import {
  type CreateLockRequest,
  type ListLocksQuery,
  type Lock,
  type LockOrigin,
  type ServerLockKind,
} from '../../shared';
import { type ConfigManager } from '../config/config-manager';
import { type Db, type DbLogger, type SqlValue } from '../config/db';
import { isMountPoint } from '../smb/cifs-mount';

import { ByteRangeLocker } from './byte-range';
import { removeSidecar, writeSidecar } from './sidecar';

/**
 * The locking subsystem (T24).
 *
 * A lock's identity is a database row, not an in-memory object — `idx_locks_active`
 * (a partial unique index on `(share_id, rel_path) WHERE released_at IS NULL`) is what
 * actually enforces "one active lock per file", so two requests racing to acquire the
 * same path cannot both win no matter how Node happens to schedule them. Everything in
 * this class is a thin, typed layer over that invariant plus the advisory sidecar file
 * projected onto the server share for tools outside the bridge (see `sidecar.ts`).
 *
 * A lock's TTL exists for exactly one failure mode: a TNC that opens a file and is then
 * powered off, rebooted, or simply disconnected without a clean close. `expireStale()`
 * is the reaper for that case and is meant to be called on a short interval by whatever
 * owns the process's timers (T22); it does nothing surprising if called from a test.
 */

export class LockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockError';
  }
}

/** Thrown by {@link LockManager.acquire} when the path already has an active lock. */
export class LockHeldError extends LockError {
  constructor(readonly existing: Lock) {
    super(
      `"${existing.relPath}" is already locked (origin: ${existing.origin}, ` +
        `acquired ${new Date(existing.acquiredAt * 1000).toISOString()})`,
    );
    this.name = 'LockHeldError';
  }
}

export class LockNotFoundError extends LockError {
  constructor(id: number) {
    super(`No active lock with id ${id}`);
    this.name = 'LockNotFoundError';
  }
}

export interface AcquireLockInput {
  readonly shareId: number;
  readonly relPath: string;
  readonly origin: LockOrigin;
  readonly ownerLabel?: string | null;
  readonly tncIp?: string | null;
  readonly smbPid?: number | null;
  readonly smbSessionId?: string | null;
  /** Overrides the configured TTL. `null` means "held until explicitly released". */
  readonly ttlSeconds?: number | null;
  readonly note?: string | null;
}

export interface ReleaseLockOptions {
  /** Recorded on the row and surfaced to any lock-event subscriber. */
  readonly reason?: string;
  /** True when an operator is releasing a lock they do not own (T30 audits this). */
  readonly forced?: boolean;
}

export type LockEventAction = 'acquired' | 'released' | 'expired' | 'force_released';

export interface LockEvent {
  readonly action: LockEventAction;
  readonly lock: Lock;
}

export type LockEventHandler = (event: LockEvent) => void;
export type Unsubscribe = () => void;

interface LockRow {
  id: number;
  share_id: number;
  rel_path: string;
  origin: string;
  owner_label: string | null;
  tnc_ip: string | null;
  smb_pid: number | null;
  smb_session_id: string | null;
  server_lock_kind: string;
  server_lock_ok: number;
  server_lock_error: string | null;
  acquired_at: number;
  expires_at: number | null;
  released_at: number | null;
  note: string | null;
}

interface ShareMountRow {
  mount_point: string;
}

function toLock(row: LockRow): Lock {
  return {
    id: row.id,
    shareId: row.share_id,
    relPath: row.rel_path,
    origin: row.origin as LockOrigin,
    ownerLabel: row.owner_label,
    tncIp: row.tnc_ip,
    smbPid: row.smb_pid,
    smbSessionId: row.smb_session_id,
    serverLockKind: row.server_lock_kind as ServerLockKind,
    serverLockOk: row.server_lock_ok === 1,
    serverLockError: row.server_lock_error,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
    releasedAt: row.released_at,
    note: row.note,
  };
}

export interface LockManagerOptions {
  readonly db: Db;
  readonly config: ConfigManager;
  readonly logger?: DbLogger;
  /** Seconds since the epoch. Overridable so TTL/expiry tests do not sleep. */
  readonly now?: () => number;
  /**
   * Whether a share's mount point is really a mounted filesystem.
   *
   * Injected so a test can use an ordinary temp directory as a stand-in for a mounted
   * share. Production takes the default, which is the real `st_dev` check — the reason
   * this option exists at all is that the unchecked version wrote lock markers onto the
   * appliance's own disk and reported them as projected onto the server.
   */
  readonly isMounted?: (mountPoint: string) => boolean;
  /**
   * Holds the real, server-enforced locks. Injected so tests can drive the lifetime
   * without spawning anything, and so a platform without `flock` can run with none.
   */
  readonly byteRange?: ByteRangeLocker;
}

/** Kinds that additionally drop a marker next to the file for people to see. */
const SERVER_MARKER_KINDS: ReadonlySet<ServerLockKind> = new Set(['sidecar', 'byte_range']);

export class LockManager {
  private readonly db: Db;
  private readonly config: ConfigManager;
  private readonly logger: DbLogger | undefined;
  private readonly now: () => number;
  private readonly isMounted: (mountPoint: string) => boolean;
  private readonly byteRange: ByteRangeLocker;
  private readonly handlers = new Set<LockEventHandler>();

  constructor(options: LockManagerOptions) {
    this.db = options.db;
    this.config = options.config;
    this.logger = options.logger;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.isMounted = options.isMounted ?? ((path) => isMountPoint(path));
    this.byteRange =
      options.byteRange ??
      new ByteRangeLocker({
        ...(options.logger ? { logger: options.logger } : {}),
        onLost: (lockId, reason) => this.recordProjectionLoss(lockId, reason),
      });
  }

  /**
   * Takes a lock.
   *
   * The insert and the sidecar projection are deliberately two steps: the database
   * write is what makes the lock real, and it must not roll back just because the
   * remote mount is briefly unreachable. A failed projection is recorded on the row
   * (`serverLockOk: false`) and returned to the caller as data, not thrown.
   */
  acquire(input: AcquireLockInput): Lock {
    const locking = this.config.get('locking');
    if (!locking.enabled) {
      throw new LockError('Locking is disabled in configuration');
    }

    const now = this.now();
    const ttl =
      input.ttlSeconds !== undefined
        ? input.ttlSeconds
        : input.origin === 'tnc'
          ? locking.tncLockTtlS
          : null;
    const expiresAt = ttl === null || ttl === 0 ? null : now + ttl;
    const serverLockKind: ServerLockKind = locking.serverProjection;

    let row: LockRow;
    try {
      row = this.db.immediateTransaction(() => {
        const existing = this.db.get<LockRow>(
          `SELECT * FROM locks WHERE share_id = @shareId AND rel_path = @relPath AND released_at IS NULL`,
          { shareId: input.shareId, relPath: input.relPath },
        );
        if (existing !== undefined) {
          throw new LockHeldError(toLock(existing));
        }

        const result = this.db.run(
          `INSERT INTO locks (
             share_id, rel_path, origin, owner_label, tnc_ip, smb_pid, smb_session_id,
             server_lock_kind, server_lock_ok, server_lock_error, acquired_at, expires_at, note
           ) VALUES (
             @shareId, @relPath, @origin, @ownerLabel, @tncIp, @smbPid, @smbSessionId,
             @serverLockKind, 0, NULL, @acquiredAt, @expiresAt, @note
           )`,
          {
            shareId: input.shareId,
            relPath: input.relPath,
            origin: input.origin,
            ownerLabel: input.ownerLabel ?? null,
            tncIp: input.tncIp ?? null,
            smbPid: input.smbPid ?? null,
            smbSessionId: input.smbSessionId ?? null,
            serverLockKind,
            acquiredAt: now,
            expiresAt,
            note: input.note ?? null,
          },
        );
        const inserted = this.db.get<LockRow>('SELECT * FROM locks WHERE id = @id', {
          id: Number(result.lastInsertRowid),
        });
        if (inserted === undefined) {
          throw new LockError('Lock row disappeared immediately after insert');
        }
        return inserted;
      });
    } catch (err) {
      if (err instanceof LockHeldError) {
        throw err;
      }
      // A UNIQUE violation here means a concurrent transaction won the race between
      // our read and our insert — collapse it into the same typed error rather than
      // leaking a raw SQLite constraint message to callers.
      const conflicting = this.db.get<LockRow>(
        `SELECT * FROM locks WHERE share_id = @shareId AND rel_path = @relPath AND released_at IS NULL`,
        { shareId: input.shareId, relPath: input.relPath },
      );
      if (conflicting !== undefined) {
        throw new LockHeldError(toLock(conflicting));
      }
      throw err;
    }

    row = this.projectAndPersist(row, serverLockKind, 'lock');
    const lock = toLock(row);
    this.emit({ action: 'acquired', lock });
    return lock;
  }

  /** Releases an active lock, removing its sidecar projection if one was written. */
  release(id: number, options: ReleaseLockOptions = {}): Lock {
    const row = this.db.get<LockRow>('SELECT * FROM locks WHERE id = @id AND released_at IS NULL', {
      id,
    });
    if (row === undefined) {
      throw new LockNotFoundError(id);
    }
    return this.finish(
      row,
      options.forced === true ? 'force_released' : 'released',
      options.reason,
    );
  }

  /** Releases every active lock past its `expiresAt`. Returns the released locks. */
  expireStale(): Lock[] {
    const now = this.now();
    const stale = this.db.all<LockRow>(
      `SELECT * FROM locks WHERE released_at IS NULL AND expires_at IS NOT NULL AND expires_at <= @now`,
      { now },
    );
    return stale.map((row) => this.finish(row, 'expired', 'TTL exceeded'));
  }

  private finish(row: LockRow, action: LockEventAction, reason: string | undefined): Lock {
    const releasedAt = this.now();
    this.db.run(
      `UPDATE locks SET released_at = @releasedAt, note = COALESCE(@reason, note) WHERE id = @id`,
      { id: row.id, releasedAt, reason: reason ?? null },
    );

    // Closing the descriptor is what lifts the lock on the server, so this happens
    // whether or not the mount is still there — a holder for a share that vanished is a
    // process with nothing left to protect.
    this.byteRange.release(row.id);

    if (SERVER_MARKER_KINDS.has(row.server_lock_kind as ServerLockKind)) {
      const mount = this.getMountPoint(row.share_id);
      if (mount !== undefined && !this.isMounted(mount)) {
        // Symmetry with the write side, and for a sharper reason: deleting a path under
        // an unmounted mount point would remove a stray local file and report the
        // marker cleaned up, while the real one on the server stays there for good.
        this.logger?.warn(
          { shareId: row.share_id, relPath: row.rel_path, mount },
          'server share is not mounted; the lock marker on it could not be removed',
        );
      } else if (mount !== undefined) {
        const result = removeSidecar(mount, row.rel_path);
        if (!result.ok) {
          this.logger?.warn(
            { shareId: row.share_id, relPath: row.rel_path, error: result.error },
            'failed to remove sidecar lock file',
          );
        }
      }
    }

    const updated = this.db.get<LockRow>('SELECT * FROM locks WHERE id = @id', { id: row.id });
    const lock = toLock(updated ?? { ...row, released_at: releasedAt });
    this.emit({ action, lock });
    return lock;
  }

  getActive(shareId: number, relPath: string): Lock | undefined {
    const row = this.db.get<LockRow>(
      `SELECT * FROM locks WHERE share_id = @shareId AND rel_path = @relPath AND released_at IS NULL`,
      { shareId, relPath },
    );
    return row === undefined ? undefined : toLock(row);
  }

  list(query: ListLocksQuery): { items: Lock[]; total: number; limit: number; offset: number } {
    const clauses: string[] = [];
    const params: Record<string, SqlValue> = { limit: query.limit, offset: query.offset };

    if (!query.includeReleased) {
      clauses.push('released_at IS NULL');
    }
    if (query.share !== undefined) {
      clauses.push('share_id = @share');
      params.share = query.share;
    }
    if (query.origin !== undefined) {
      clauses.push('origin = @origin');
      params.origin = query.origin;
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

    const total = this.db.pluck<number>(`SELECT count(*) FROM locks ${where}`, params) ?? 0;
    const rows = this.db.all<LockRow>(
      `SELECT * FROM locks ${where} ORDER BY acquired_at DESC LIMIT @limit OFFSET @offset`,
      params,
    );
    return { items: rows.map(toLock), total, limit: query.limit, offset: query.offset };
  }

  /**
   * From a bare create request (the shape the API accepts from an operator) to a full
   * acquire — `origin` is always forced to `'manual'` here, never taken from the
   * caller, so a client cannot claim TNC or scheduler precedence for its own lock.
   */
  createManual(shareId: number, request: CreateLockRequest): Lock {
    return this.acquire({
      shareId,
      relPath: request.relPath,
      origin: 'manual',
      ttlSeconds: request.ttlSeconds ?? null,
      note: request.note ?? null,
    });
  }

  onLockEvent(handler: LockEventHandler): Unsubscribe {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private projectAndPersist(row: LockRow, kind: ServerLockKind, marker: string): LockRow {
    if (kind === 'none') {
      return row;
    }
    const mount = this.getMountPoint(row.share_id);
    if (mount === undefined) {
      this.db.run(`UPDATE locks SET server_lock_ok = 0, server_lock_error = @err WHERE id = @id`, {
        id: row.id,
        err: 'share has no known mount point',
      });
    } else if (!this.isMounted(mount)) {
      // The marker would land on the appliance's own disk, where the server will never
      // see it — and the row would claim the opposite. Recording the failure is the
      // honest outcome: the lock itself is real either way, because it is a database row
      // and not a file on someone else's server.
      this.db.run(`UPDATE locks SET server_lock_ok = 0, server_lock_error = @err WHERE id = @id`, {
        id: row.id,
        err: `${mount} is not a mounted share; the marker was not written`,
      });
      this.logger?.warn(
        { shareId: row.share_id, relPath: row.rel_path, mount },
        'server share is not mounted; the lock is held locally but not projected',
      );
    } else {
      if (kind === 'byte_range') {
        const target = ByteRangeLocker.targetPath(mount, row.rel_path);
        const held = this.byteRange.acquire(row.id, target);
        if (!held.ok) {
          this.db.run(
            `UPDATE locks SET server_lock_ok = 0, server_lock_error = @err WHERE id = @id`,
            { id: row.id, err: held.error ?? 'the server-side lock could not be taken' },
          );
          this.logger?.warn(
            { shareId: row.share_id, relPath: row.rel_path, error: held.error },
            'the lock is held locally but the server does not enforce it',
          );
          return this.db.get<LockRow>('SELECT * FROM locks WHERE id = @id', { id: row.id }) ?? row;
        }
      }

      // The marker goes on for `byte_range` too. The lock is enforced without it, but
      // the marker is the part a person sees: someone browsing the share in Explorer
      // gets an explanation for why the file will not save, rather than a refusal with
      // no author.
      const result = writeSidecar(
        mount,
        row.rel_path,
        `Locked by CNC Network Bridge (${marker}) at ${new Date(row.acquired_at * 1000).toISOString()}\n`,
      );
      this.db.run(
        `UPDATE locks SET server_lock_ok = @ok, server_lock_error = @err WHERE id = @id`,
        {
          id: row.id,
          ok: result.ok ? 1 : 0,
          err: result.ok ? null : (result.error ?? 'unknown error'),
        },
      );
      if (!result.ok) {
        this.logger?.warn(
          { shareId: row.share_id, relPath: row.rel_path, error: result.error },
          'failed to write sidecar lock file — the lock is still held locally',
        );
      }
    }

    const refreshed = this.db.get<LockRow>('SELECT * FROM locks WHERE id = @id', { id: row.id });
    return refreshed ?? row;
  }

  /**
   * Records that a server-side lock is gone while the lock itself still stands.
   *
   * The row stays active on purpose. The bridge's own lock is the database row; losing
   * the projection means other clients can now write, which is worth surfacing loudly,
   * but it is not a reason to let the control's file go unprotected here as well.
   */
  private recordProjectionLoss(lockId: number, reason: string): void {
    this.db.run(
      `UPDATE locks SET server_lock_ok = 0, server_lock_error = @err
        WHERE id = @id AND released_at IS NULL`,
      { id: lockId, err: reason },
    );
  }

  /**
   * Re-establishes the server-side locks for rows that are still held.
   *
   * A holder is a child process, so every one of them died with the previous run. The
   * rows outlived them, and without this the appliance would come back believing it
   * protects files that anyone can now write. Called once at startup, after the shares
   * are mounted.
   */
  restoreServerLocks(): { restored: number; failed: number } {
    const rows = this.db.all<LockRow>(
      `SELECT * FROM locks WHERE released_at IS NULL AND server_lock_kind = 'byte_range'`,
    );
    let restored = 0;
    let failed = 0;

    for (const row of rows) {
      const mount = this.getMountPoint(row.share_id);
      if (mount === undefined || !this.isMounted(mount)) {
        failed += 1;
        this.recordProjectionLoss(row.id, 'the share was not mounted when the bridge started');
        continue;
      }
      const held = this.byteRange.acquire(row.id, ByteRangeLocker.targetPath(mount, row.rel_path));
      if (held.ok) {
        restored += 1;
        this.db.run(
          `UPDATE locks SET server_lock_ok = 1, server_lock_error = NULL WHERE id = @id`,
          { id: row.id },
        );
      } else {
        failed += 1;
        this.recordProjectionLoss(row.id, held.error ?? 'the lock could not be retaken');
      }
    }

    if (rows.length > 0) {
      this.logger?.info({ restored, failed }, 'server-side locks re-established after startup');
    }
    return { restored, failed };
  }

  /** Stops holding every server-side lock, without releasing the locks themselves. */
  shutdown(): void {
    this.byteRange.releaseAll();
  }

  private getMountPoint(shareId: number): string | undefined {
    const row = this.db.get<ShareMountRow>('SELECT mount_point FROM shares WHERE id = @id', {
      id: shareId,
    });
    return row?.mount_point;
  }

  private emit(event: LockEvent): void {
    for (const handler of [...this.handlers]) {
      try {
        handler(event);
      } catch (err) {
        this.logger?.error({ err, action: event.action }, 'a lock-event subscriber threw');
      }
    }
  }
}
