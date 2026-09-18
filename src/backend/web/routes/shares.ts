import { rm } from 'node:fs/promises';
import { posix } from 'node:path';

import { Router } from 'express';

import {
  createShareRequestSchema,
  deleteShareQuerySchema,
  paginationQuerySchema,
  shareActionSchema,
  updateShareRequestSchema,
  type ShareRuntime,
} from '../../../shared';
import { CACHE_ROOT, ShareError, ShareStore } from '../../sync/share-store';
import { type AppContext } from '../context';
import { HttpError } from '../envelope';
import {
  asyncHandler,
  ok,
  requireCsrf,
  requireSession,
  requireSessionOrToken,
} from '../middleware';

/**
 * Bring the running syncs *and* the exported shares in line with what was just written.
 *
 * Fire-and-forget on purpose: the caller asked to save a share, and a mount that takes
 * twenty seconds to time out must not hold their save open. Whether a share syncs is
 * decided by its `enabled` column, which is now stored — reconciliation is how that
 * becomes true, not a second thing the operator has to ask for.
 *
 * Samba is reconciled here too, and synchronously, because it is cheap: rendering
 * `smb.conf` is a query and a string, and the helper reloads rather than restarts. A
 * share that syncs but is not exported is a share no machine can reach, which looks
 * exactly like the share not working at all.
 */
function reconcile(ctx: AppContext): void {
  void ctx.sync?.reconcile();
  ctx.samba?.reconcile();
}

/**
 * `/shares` — the bridge's central object: one server export, mirrored into a local
 * cache, re-served to the machines.
 *
 * Actions act on the running supervisor. `scan` and `resync` bring the next cycle
 * forward; `pause` and `resume` suspend transfers without unmounting or losing the
 * index. `mount`/`unmount` are reconciliation in disguise — what decides whether a
 * share is mounted is whether it is enabled — so they are answered by asking the
 * supervisor to converge rather than by poking the mount directly.
 */

function idParam(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new HttpError(400, 'VALIDATION_FAILED', 'Expected a positive integer id');
  }
  return n;
}

/** Maps a share action onto the supervisor. Returns false when the share is not running. */
function runAction(ctx: AppContext, shareId: number, action: string): boolean {
  const sync = ctx.sync;
  if (sync === undefined) {
    return false;
  }
  switch (action) {
    case 'pause':
      return sync.setPaused(shareId, true);
    case 'resume':
      return sync.setPaused(shareId, false);
    case 'mount':
    case 'unmount':
      // Both are "make the running state match the configuration", which is exactly
      // what reconcile does — and unlike poking the mount, it cannot leave the two
      // disagreeing.
      void sync.reconcile();
      return true;
    default:
      // scan and resync: bring the next cycle forward.
      return sync.runNow(shareId);
  }
}

function toHttp(error: unknown): unknown {
  if (error instanceof ShareError) {
    return error.kind === 'not_found'
      ? new HttpError(404, 'NOT_FOUND', error.message)
      : new HttpError(409, 'CONFLICT', error.message);
  }
  return error;
}

/**
 * Remove a deleted share's cached copies.
 *
 * This is the only place in the API that deletes a directory tree, so it does not take
 * the stored path on trust. `cache_path` is written by the store as `<root>/<name>` and
 * is never client-supplied, and the check here says exactly that: anything else — a row
 * edited by hand, a path that picked up a `..`, a root that moved — is refused and
 * logged rather than removed. `root` is a parameter for the same reason: the rule is
 * "the directory this share owns", not "whatever /srv happens to mean".
 *
 * A failure is logged, not raised. The share itself is already gone by this point, and
 * answering 500 would tell the operator the deletion failed when what is actually left
 * is a directory they can remove by hand.
 */
export async function purgeShareCache(
  cachePath: string,
  shareName: string,
  root: string,
  logger?: AppContext['logger'],
): Promise<boolean> {
  if (cachePath !== posix.join(root, shareName)) {
    logger?.error(
      { cachePath, expected: posix.join(root, shareName) },
      'refusing to purge: the cache path is not the one this share owns',
    );
    return false;
  }
  try {
    await rm(cachePath, { recursive: true, force: true });
    logger?.info({ cachePath }, 'cached copies of the deleted share removed');
    return true;
  } catch (error) {
    logger?.error(
      { cachePath, error: error instanceof Error ? error.message : String(error) },
      'could not remove the cached copies of the deleted share; they are left on disk',
    );
    return false;
  }
}

export function sharesRoutes(ctx: AppContext): Router {
  const router = Router();
  const store = new ShareStore({ db: ctx.db, config: ctx.config });

  router.get('/shares', requireSessionOrToken(ctx), (req, res) => {
    const { limit, offset } = paginationQuerySchema.parse(req.query);
    const { items, total } = store.list(limit, offset);
    ok(res, { items, total, limit, offset });
  });

  router.post('/shares', requireSession(ctx), requireCsrf(ctx), (req, res) => {
    const body = createShareRequestSchema.parse(req.body);
    try {
      const share = store.create(body);
      ctx.audit?.record({
        actor: 'admin',
        action: 'shares.create',
        target: share.name,
        detail: `serverUnc=${share.serverUnc}`,
        ...(req.ip === undefined ? {} : { ip: req.ip }),
      });
      reconcile(ctx);
      ok(res, share, 201);
    } catch (error) {
      throw toHttp(error);
    }
  });

  router.get('/shares/:id', requireSessionOrToken(ctx), (req, res) => {
    try {
      ok(res, store.get(idParam(req.params.id)));
    } catch (error) {
      throw toHttp(error);
    }
  });

  router.patch('/shares/:id', requireSession(ctx), requireCsrf(ctx), (req, res) => {
    const id = idParam(req.params.id);
    const body = updateShareRequestSchema.parse(req.body);
    try {
      // Read before the write: the machine user names a Unix account, so changing it
      // leaves the previous one orphaned exactly as a deleted share does. Reconciliation
      // walks the shares that exist and would never name the old account again.
      const before = store.get(id).machineUser;
      const share = store.update(id, body);
      if (before !== null && before !== share.machineUser) {
        ctx.samba?.dropAccount(share.name, before);
      }
      ctx.audit?.record({
        actor: 'admin',
        action: 'shares.update',
        target: share.name,
        detail: Object.keys(body).join(', '),
        ...(req.ip === undefined ? {} : { ip: req.ip }),
      });
      reconcile(ctx);
      ok(res, share);
    } catch (error) {
      throw toHttp(error);
    }
  });

  router.delete(
    '/shares/:id',
    requireSession(ctx),
    requireCsrf(ctx),
    asyncHandler(async (req, res) => {
      const id = idParam(req.params.id);
      const { purgeCache } = deleteShareQuerySchema.parse(req.query);
      let share: ShareRuntime;
      try {
        // Read before the row is gone: the name is what the Samba account is derived
        // from and the cache path is what may have to be removed, and neither can be
        // recovered afterwards.
        share = store.get(id);
        store.delete(id);
      } catch (error) {
        throw toHttp(error);
      }

      ctx.audit?.record({
        actor: 'admin',
        action: 'shares.delete',
        target: share.name,
        detail: purgeCache ? `purged ${share.cachePath}` : 'cache kept',
        ...(req.ip === undefined ? {} : { ip: req.ip }),
      });

      // Samba first, and synchronously: it stops exporting the cache directory and
      // takes the login with it. Doing this after the removal below would leave a
      // window in which a machine could reconnect to a share that is being deleted
      // underneath it.
      ctx.samba?.dropAccount(share.name, share.machineUser);
      ctx.samba?.reconcile();

      // Awaited, unlike every other caller of reconcile: it is what stops this share's
      // worker and unmounts the server export, and removing the cache while a cycle is
      // still copying into it would have the sync engine recreating what was deleted.
      await ctx.sync?.reconcile();

      if (purgeCache) {
        await purgeShareCache(share.cachePath, share.name, CACHE_ROOT, ctx.logger);
      }

      ok(res, { acknowledged: true as const });
    }),
  );

  router.post('/shares/:id/:action', requireSession(ctx), requireCsrf(ctx), (req, res) => {
    const id = idParam(req.params.id);
    const action = shareActionSchema.parse(req.params.action);
    try {
      // Resolve the share first, so an action against a share that does not exist is
      // still a 404 rather than being masked by the 503 below.
      const share = store.get(id);
      ctx.audit?.record({
        actor: 'admin',
        action: `shares.${action}`,
        target: share.name,
        ...(req.ip === undefined ? {} : { ip: req.ip }),
      });
      if (ctx.sync === undefined) {
        // No supervisor means this process is not the one that syncs — a test, or the
        // dev server. Claiming the work was queued would leave the caller waiting on an
        // event stream that will never carry a result.
        throw new HttpError(
          503,
          'SERVICE_UNAVAILABLE',
          `Share actions need the sync engine, which is not running in this process (requested: ${action})`,
        );
      }

      const accepted = runAction(ctx, id, action);
      if (!accepted) {
        throw new HttpError(
          409,
          'CONFLICT',
          `"${share.name}" is not syncing. Enable the share first.`,
        );
      }
      ok(res, {
        accepted: true as const,
        operationId: `${action}-${String(id)}-${String(Date.now())}`,
      });
    } catch (error) {
      throw toHttp(error);
    }
  });

  return router;
}
