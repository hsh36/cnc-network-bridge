import { type Lock } from '../../shared';
import { type ConfigManager } from '../config/config-manager';
import { type Db, type DbLogger } from '../config/db';
import { type AuditEvent, type AuditOperation } from '../smb/audit-syslog';
import { type SmbStatus, toRelativePath } from '../smb/samba-service';
import { ShareStore } from '../sync/share-store';

import { LockHeldError, type LockManager } from './lock-manager';

/**
 * Turns what Samba reports into rows in the `locks` table (T14 + T24, joined).
 *
 * Both halves of TNC-side locking were written and tested and neither was ever called:
 * `AuditIngest` parsed events nothing consumed, and `smbstatus` was parsed by nobody.
 * A lock could therefore only be created through the REST API or a schedule window —
 * which is to say the product's central feature, "the file a control has open cannot be
 * overwritten underneath it", did not exist outside its unit tests.
 *
 * Two inputs, deliberately:
 *
 * - **Audit events** are immediate. A control opening a program for writing produces
 *   `openat` within milliseconds, which is fast enough to stop a sync that is about to
 *   overwrite it. They are also lossy: syslog is UDP, this service restarts, the rate
 *   limiter drops a flood.
 * - **`smbstatus`** is authoritative but periodic. It says what the kernel believes
 *   right now, and reconciling against it repairs whatever the event stream missed.
 *
 * The asymmetry between them is intentional. Reconciliation may *release* a lock only on
 * the strength of a status that was actually read — never on a failed or empty one, or
 * every lock on the bridge would drop the first time `smbstatus` is unavailable, which
 * is exactly when a control is most likely mid-program.
 */

/** Written by Samba or by the bridge itself; never a program a control is editing. */
const IGNORED_PATH_PATTERNS = [
  /(^|\/)\.~lock\..*#$/, // our own sidecar projection
  /(^|\/)\.tnc-tmp-/, // in-flight transfer temp files
  /(^|\/)\.tnc-bridge-probe/, // reachability probes
  /(^|\/)\.tnc-versions(\/|$)/, // the local version store
  /(^|\/)\.::TMPNAME:/, // Samba's own mkdir-then-rename scratch name
];

/**
 * Cap on rows touched in one reconcile pass.
 *
 * A bridge with more than this many machine locks on one share is not in a state a
 * bigger page size would fix, and an unbounded query here would be run on a timer.
 */
const MAX_RECONCILE_ROWS = 1000;

/** Operations that end a machine's interest in a path. */
const RELEASING_OPERATIONS: ReadonlySet<AuditOperation> = new Set<AuditOperation>([
  'close',
  'unlink',
  'rename',
]);

export interface TncLockSourceOptions {
  readonly db: Db;
  readonly config: ConfigManager;
  readonly locks: LockManager;
  readonly logger?: DbLogger;
}

export interface ReconcileResult {
  readonly acquired: number;
  readonly released: number;
  /** True when the status was not usable and nothing was released on its strength. */
  readonly skipped: boolean;
}

export class TncLockSource {
  private readonly locks: LockManager;
  private readonly logger: DbLogger | undefined;
  private readonly shares: ShareStore;

  constructor(options: TncLockSourceOptions) {
    this.locks = options.locks;
    this.logger = options.logger;
    this.shares = new ShareStore({ db: options.db, config: options.config });
  }

  /**
   * Applies one audit event.
   *
   * Write opens take a lock; closes, deletes and renames give it up. A *read* open does
   * not lock: a control listing a directory or streaming a program it is running would
   * otherwise lock half the share, and the file it is running is protected by the sync
   * engine's own conflict rules rather than by an exclusive lock nobody asked for.
   */
  handleEvent(event: AuditEvent): void {
    if (event.result !== 'ok' || event.share === null || event.path === '') {
      return;
    }
    if (IGNORED_PATH_PATTERNS.some((pattern) => pattern.test(event.path))) {
      return;
    }

    const share = this.shareByName(event.share);
    if (share === undefined) {
      // A section in smb.conf with no row behind it. Worth saying once per event rather
      // than silently: it means the config and the database have diverged.
      this.logger?.warn({ share: event.share }, 'audit event for an unknown share');
      return;
    }

    if (event.operation === 'open' && (event.mode === null || event.mode.includes('w'))) {
      this.acquire(share.id, event.path, event.clientIp, event.user);
      return;
    }

    if (RELEASING_OPERATIONS.has(event.operation)) {
      this.releaseIfHeldByMachine(share.id, event.path, event.clientIp);
      // A rename moves the machine's interest to the destination rather than ending it,
      // but the lock is keyed on the path — the old one is gone and the new name is a
      // different file as far as the table is concerned.
      if (event.operation === 'rename' && event.newPath !== null && event.newPath !== '') {
        this.releaseIfHeldByMachine(share.id, event.newPath, event.clientIp);
      }
    }
  }

  /**
   * Makes the lock table match what `smbstatus` reports.
   *
   * `status` of `null` means the command failed — see the note on asymmetry above.
   */
  reconcile(status: SmbStatus | null): ReconcileResult {
    if (status === null) {
      return { acquired: 0, released: 0, skipped: true };
    }

    // pid → the machine that owns it, so a lock discovered here is still attributable.
    const ipByPid = new Map<number, string>();
    for (const session of status.sessions) {
      if (session.pid !== null && session.remoteMachine !== null) {
        ipByPid.set(session.pid, session.remoteMachine);
      }
    }

    let acquired = 0;
    let released = 0;

    for (const share of this.enabledShares()) {
      const open = new Map<string, string | null>();
      for (const file of status.openFiles) {
        const relPath = toRelativePath(file, share.cachePath);
        if (relPath === null || IGNORED_PATH_PATTERNS.some((pattern) => pattern.test(relPath))) {
          continue;
        }
        // `rw` is `RDWR`/`WRONLY`/`RDONLY` in the text parser and the access mask in
        // JSON; anything that is not plainly read-only counts as a write open, because
        // the failure mode of guessing "read" is overwriting a program being edited.
        if (file.rw !== null && /^rdonly$/i.test(file.rw)) {
          continue;
        }
        open.set(relPath, file.pid === null ? null : (ipByPid.get(file.pid) ?? null));
      }

      for (const [relPath, ip] of open) {
        if (this.locks.getActive(share.id, relPath) === undefined) {
          if (this.acquire(share.id, relPath, ip, null)) {
            acquired += 1;
          }
        }
      }

      for (const lock of this.activeMachineLocks(share.id)) {
        if (!open.has(lock.relPath)) {
          this.release(lock, 'smbstatus-reconcile');
          released += 1;
        }
      }
    }

    return { acquired, released, skipped: false };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private acquire(
    shareId: number,
    relPath: string,
    tncIp: string | null,
    user: string | null,
  ): boolean {
    try {
      this.locks.acquire({
        shareId,
        relPath,
        origin: 'tnc',
        ownerLabel: user,
        tncIp,
        note: 'opened on a machine',
      });
      return true;
    } catch (error) {
      if (error instanceof LockHeldError) {
        // Already locked — by this machine re-opening the file, or by an operator. Both
        // are ordinary; the second is the whole point of a lock table.
        return false;
      }
      // Locking disabled in configuration lands here, and so would a database error.
      // Neither is a reason to stop ingesting: the next event must still be read.
      this.logger?.warn(
        { shareId, relPath, error: error instanceof Error ? error.message : String(error) },
        'could not take a machine lock',
      );
      return false;
    }
  }

  private releaseIfHeldByMachine(shareId: number, relPath: string, tncIp: string | null): void {
    const lock = this.locks.getActive(shareId, relPath);
    if (lock?.origin !== 'tnc') {
      return;
    }
    // A close from a different machine than the one holding the lock is not a release.
    // Two controls with the same program open is precisely the case the table exists for.
    if (tncIp !== null && lock.tncIp !== null && lock.tncIp !== tncIp) {
      return;
    }
    this.release(lock, 'closed on the machine');
  }

  private release(lock: Lock, reason: string): void {
    try {
      this.locks.release(lock.id, { reason });
    } catch (error) {
      this.logger?.warn(
        { lockId: lock.id, error: error instanceof Error ? error.message : String(error) },
        'could not release a machine lock',
      );
    }
  }

  private activeMachineLocks(shareId: number): Lock[] {
    return this.locks.list({
      share: shareId,
      origin: 'tnc',
      includeReleased: false,
      limit: MAX_RECONCILE_ROWS,
      offset: 0,
    }).items;
  }

  private enabledShares(): { id: number; name: string; cachePath: string }[] {
    return this.shares
      .list(MAX_RECONCILE_ROWS, 0)
      .items.filter((share) => share.enabled)
      .map((share) => ({ id: share.id, name: share.name, cachePath: share.cachePath }));
  }

  /** The export root Samba logs paths against, for the audit parser. */
  cachePathFor(name: string): string | undefined {
    return this.shareByName(name)?.cachePath;
  }

  private shareByName(name: string): { id: number; cachePath: string } | undefined {
    return this.enabledShares().find((share) => share.name === name);
  }
}
