import { Router } from 'express';
import { type ShareRuntime, type Status } from '../../../shared';
import { ShareStore } from '../../sync/share-store';
import { type AppContext } from '../context';
import { ok, requireSessionOrToken } from '../middleware';

/**
 * `/status` and `/health` (T30).
 *
 * Aggregates what genuinely exists: the shares and their per-share counts, the lock
 * and conflict tables, and whether the process itself is healthy.
 *
 * `serverLink.reachable` and the two throughput figures used to be literal `false` and
 * `0` here, with a comment calling them an honest placeholder. They stopped being honest
 * once the subsystems behind them existed: the dashboard read "Server link: offline" on
 * an appliance that was syncing, and showed a flat zero next to charts on the monitoring
 * page that were drawing real traffic. Both are now derived from the same sources those
 * pages use.
 *
 * `shares` used to be a hardcoded empty array left over from before share CRUD existed.
 * The file browser reads its share picker from here, so the picker was permanently
 * empty and the page looked broken from the first click.
 */
/**
 * An appliance with more shares than this has other problems; the cap is here so a
 * status poll can never turn into an unbounded query.
 */
const SHARE_LIST_CAP = 200;

export function statusRoutes(ctx: AppContext): Router {
  const router = Router();
  const store = new ShareStore({ db: ctx.db, config: ctx.config });

  router.get('/status', requireSessionOrToken(ctx), (_req, res) => {
    const filesIndexed = ctx.db.pluck<number>('SELECT count(*) FROM file_index') ?? 0;
    const filesPending =
      ctx.db.pluck<number>(
        `SELECT count(*) FROM file_index WHERE state IN ('pending_push', 'pending_pull')`,
      ) ?? 0;
    const activeLocks =
      ctx.db.pluck<number>('SELECT count(*) FROM locks WHERE released_at IS NULL') ?? 0;
    const unacknowledgedConflicts =
      ctx.db.pluck<number>('SELECT count(*) FROM conflicts WHERE acknowledged = 0') ?? 0;
    const sharesEnabled =
      ctx.db.pluck<number>('SELECT count(*) FROM shares WHERE enabled = 1') ?? 0;
    const shares = store.list(SHARE_LIST_CAP, 0).items;

    const status: Status = {
      version: ctx.version,
      uptimeSeconds: Math.max(0, Math.floor(ctx.now() / 1000) - Math.floor(ctx.startedAt / 1000)),
      setupRequired: !ctx.config.getFlag<boolean>('setup.completed', false),
      serverLink: serverLinkOf(shares),
      shares,
      totals: {
        sharesEnabled,
        filesIndexed,
        filesPending,
        activeLocks,
        unacknowledgedConflicts,
        ...throughput(ctx),
      },
      readOnlyReason: null,
    };
    ok(res, status);
  });

  router.get('/health', (req, res) => {
    const remote = req.socket.remoteAddress ?? '';
    const isLocal =
      remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1' || remote === '';
    if (!isLocal) {
      res.status(403).json({
        ok: false,
        error: { code: 'FORBIDDEN', message: '/health is reachable from localhost only' },
      });
      return;
    }

    const database = ctx.db.isOpen;
    const migrations = (ctx.db.pluck<number>('PRAGMA user_version') ?? 0) > 0;
    const httpServer = true;
    const samba = false; // T12/T13 (smb.conf generation and service control) are not wired up yet.
    const allOk = database && migrations && httpServer;

    res.status(200).json({
      ok: true,
      data: {
        status: allOk ? ('ok' as const) : ('degraded' as const),
        version: ctx.version,
        uptimeSeconds: Math.max(0, Math.floor(ctx.now() / 1000) - Math.floor(ctx.startedAt / 1000)),
        checks: { database, migrations, httpServer, samba },
      },
    });
  });

  return router;
}

/**
 * One answer for a bridge that may serve several shares from several servers.
 *
 * Reachable when any enabled share is: the dashboard's line answers "can this appliance
 * reach what it syncs", and one share offline out of three is a per-share problem the
 * share list below already shows, not a dead link.
 *
 * A bridge with no enabled shares reports unreachable with a `lastError` that says why.
 * Neither answer is really true there — it is not failing to reach a server, it has no
 * server to reach — and of the two available, "offline, because nothing is configured"
 * sends a new installer to the page they need, while "online" on an appliance wired to
 * nothing is simply wrong.
 *
 * The dialect fields stay null. They describe a negotiated SMB session, which is a
 * property of one mount rather than of the appliance, and nothing collects them yet;
 * claiming a dialect here would be inventing one.
 */
function serverLinkOf(shares: readonly ShareRuntime[]): Status['serverLink'] {
  const enabled = shares.filter((share) => share.enabled);
  const offline = enabled.filter((share) => !share.serverReachable);

  if (enabled.length === 0) {
    return {
      reachable: false,
      dialect: null,
      signing: null,
      encryption: null,
      lastProbeAt: null,
      lastError: 'No enabled share, so there is no server to reach',
    };
  }

  return {
    reachable: offline.length < enabled.length,
    dialect: null,
    signing: null,
    encryption: null,
    lastProbeAt: null,
    lastError:
      offline.length === 0
        ? null
        : (offline.find((share) => share.lastError !== null)?.lastError ??
          `${String(offline.length)} of ${String(enabled.length)} shares cannot reach their server`),
  };
}

/**
 * Bytes per second, differentiated from the two most recent counter samples.
 *
 * `sync.bytes_in` is a cumulative counter, so a rate has to come from a pair of samples
 * and the gap between them. Reading the newest two rather than keeping state here means
 * the figure survives a restart of this process and matches what the monitoring page
 * plots from the same table — two numbers from one source rather than two that drift.
 *
 * Zero until the collector has written twice, which is the honest answer: with one
 * sample there is no interval to divide by.
 */
function throughput(ctx: AppContext): { bytesInPerSec: number; bytesOutPerSec: number } {
  return {
    bytesInPerSec: rateOf(ctx, 'sync.bytes_in'),
    bytesOutPerSec: rateOf(ctx, 'sync.bytes_out'),
  };
}

function rateOf(ctx: AppContext, metric: string): number {
  const rows = ctx.db.all<{ ts: number; value: number }>(
    `SELECT ts, value FROM metrics_samples
      WHERE metric = @metric AND share_id = 0
      ORDER BY ts DESC
      LIMIT 2`,
    { metric },
  );

  const [latest, previous] = rows;
  if (latest === undefined || previous === undefined) {
    return 0;
  }

  const seconds = latest.ts - previous.ts;
  const delta = latest.value - previous.value;
  // A counter that went backwards is one that was reset — by a restart, or by the
  // registry being rebuilt. Reporting the negative difference as a rate would draw a
  // spike pointing the wrong way; reporting nothing until the next pair is correct.
  if (seconds <= 0 || delta < 0) {
    return 0;
  }
  return delta / seconds;
}
