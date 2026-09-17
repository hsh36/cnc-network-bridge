import { type ShareStatus } from '../../shared';
import { type Db, type DbLogger } from '../config/db';
import { type ConfigManager } from '../config/config-manager';
import { type BridgeMetrics } from '../monitoring/registry';
import { type AuditLog } from '../security/audit-log';

import { FailoverController, type FailoverReason, type FailoverState } from './failover';

/**
 * Runs a {@link FailoverController} per share and makes its verdict real.
 *
 * The controller decides *whether* a share should stop accepting writes; this decides
 * *when it is asked* and *what happens to the answer*. Keeping those apart is what lets
 * the whole hysteresis matrix be tested without a database — and it is why the
 * controller sat here fully written and fully tested for months without doing anything:
 * nothing had ever instantiated it, `shares.failover_read_only` was read in three places
 * and written in none, and the column stood at 0 on every appliance ever shipped.
 *
 * ## One controller per share, not one per appliance
 *
 * A bridge can serve several shares from several servers. A file server being down is a
 * statement about one share, and flipping all of them read-only because one server is
 * unreachable would stop machines that have nothing to do with it.
 *
 * The disk is the exception, and it is deliberately fed to every controller: there is one
 * SD card, and a full one cannot absorb a write for any share. So the *observation* is
 * global and the *consequence* is per share, which is also how it reads in the log —
 * every affected share says `disk_full` for itself rather than one global message an
 * operator has to map onto shares by hand.
 *
 * ## Why writes stop rather than queue
 *
 * The bridge defers a push it cannot deliver and keeps it durably, so nothing is lost
 * when the server goes away. What is lost is the operator's ability to know: the save
 * succeeds, the machine says nothing, and the program exists only on a Raspberry Pi's SD
 * card until the server returns. Failing the save at the machine is the only place the
 * person who needs to know is standing.
 */

export interface FailoverServiceOptions {
  readonly db: Db;
  readonly config: ConfigManager;
  readonly metrics: BridgeMetrics;
  readonly logger?: DbLogger | undefined;
  readonly audit?: AuditLog | undefined;
  /** Re-renders `smb.conf` and reloads smbd. Called only when a share actually flips. */
  readonly onFlip?: (change: FailoverChange) => void;
  readonly now?: () => number;
  /** Overridable so a test does not have to reach the real thresholds by waiting. */
  readonly controllerOptions?: {
    readonly serverGraceS?: number;
    readonly diskFullPct?: number;
    readonly recoveryStabilityS?: number;
  };
}

export interface FailoverChange {
  readonly shareId: number;
  readonly readOnly: boolean;
  readonly state: FailoverState;
  readonly reasons: readonly FailoverReason[];
}

interface ShareRow {
  readonly id: number;
  readonly status: ShareStatus;
  readonly enabled: number;
  readonly failover_read_only: number;
}

export class FailoverService {
  private readonly controllers = new Map<number, FailoverController>();
  private readonly options: FailoverServiceOptions;
  private readonly now: () => number;

  constructor(options: FailoverServiceOptions) {
    this.options = options;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /**
   * Feeds one observation to every enabled share and applies what comes back.
   *
   * Safe to call as often as the caller likes: the controller measures its grace and
   * stabilisation windows against the clock, not against a count of observations, so the
   * interval affects how quickly a change is noticed and nothing else.
   */
  observe(): void {
    const shares = this.options.db.all<ShareRow>(
      'SELECT id, status, enabled, failover_read_only FROM shares WHERE enabled = 1',
    );

    const diskUsedPct = this.diskUsedPct();
    const seen = new Set<number>();

    for (const share of shares) {
      seen.add(share.id);
      const controller = this.controllerFor(share.id);
      const status = controller.observe({
        // `offline` is what the supervisor writes when the mount is down, which is the
        // same fact the scan loop acts on. Reading it here rather than probing again
        // means the two can never disagree about whether the server is there.
        serverReachable: share.status !== 'offline',
        diskUsedPct,
        // A share in `error` has a sync loop that could not reason about its own state.
        // The controller's own rule applies: if the engine cannot reason, it must not act.
        syncHealthy: share.status !== 'error',
      });

      this.applyTo(share, status.readOnly, status.state, status.reasons);
    }

    // A share that was disabled or destroyed keeps no controller, so re-enabling one
    // starts from a clean slate rather than resuming a grace period from a previous life.
    for (const shareId of [...this.controllers.keys()]) {
      if (!seen.has(shareId)) {
        this.controllers.delete(shareId);
      }
    }
  }

  /** The reason line for `/status`, or null when nothing is holding writes. */
  readOnlyReason(): string | null {
    const held: string[] = [];
    for (const [shareId, controller] of this.controllers) {
      const status = controller.status;
      if (status.readOnly) {
        held.push(`share ${String(shareId)}: ${status.reasons.join(', ')}`);
      }
    }
    return held.length === 0 ? null : held.join('; ');
  }

  /** Forces one share read-only until {@link resume}. */
  hold(shareId: number, actor = 'admin'): void {
    const controller = this.controllerFor(shareId);
    const status = controller.hold(actor);
    const share = this.shareRow(shareId);
    if (share !== undefined) {
      this.applyTo(share, status.readOnly, status.state, status.reasons);
    }
  }

  /** Lifts a manual hold. Automatic reasons continue to apply. */
  resume(shareId: number, actor = 'admin'): void {
    const controller = this.controllers.get(shareId);
    if (controller === undefined) {
      return;
    }
    const status = controller.resume(actor);
    const share = this.shareRow(shareId);
    if (share !== undefined) {
      this.applyTo(share, status.readOnly, status.state, status.reasons);
    }
  }

  private controllerFor(shareId: number): FailoverController {
    const existing = this.controllers.get(shareId);
    if (existing !== undefined) {
      return existing;
    }
    const controller = new FailoverController({
      ...this.options.controllerOptions,
      ...(this.options.logger === undefined ? {} : { logger: this.options.logger }),
      ...(this.options.audit === undefined ? {} : { audit: this.options.audit }),
      now: this.now,
    });
    this.controllers.set(shareId, controller);
    return controller;
  }

  /**
   * Writes the flag and tells the caller, but only when it actually moved.
   *
   * Guarded on a real change because the consequence is an `smb.conf` render and an smbd
   * reload. This runs on a timer; re-asserting an unchanged flag every tick would reload
   * Samba forever, and a reload drops the machines' SMB sessions.
   */
  private applyTo(
    share: ShareRow,
    readOnly: boolean,
    state: FailoverState,
    reasons: readonly FailoverReason[],
  ): void {
    const was = share.failover_read_only === 1;
    if (was === readOnly) {
      return;
    }

    this.options.db.run(
      'UPDATE shares SET failover_read_only = @flag, updated_at = @now WHERE id = @id',
      { id: share.id, flag: readOnly ? 1 : 0, now: this.now() },
    );

    this.options.logger?.warn(
      { shareId: share.id, readOnly, state, reasons },
      readOnly
        ? 'share dropped to read-only; machines will be refused writes until it recovers'
        : 'share accepts writes again',
    );

    this.options.onFlip?.({ shareId: share.id, readOnly, state, reasons });
  }

  private shareRow(shareId: number): ShareRow | undefined {
    return this.options.db.all<ShareRow>(
      'SELECT id, status, enabled, failover_read_only FROM shares WHERE id = @id',
      { id: shareId },
    )[0];
  }

  /**
   * Cache usage as a percentage, or 0 when it is not known yet.
   *
   * Zero rather than 100 on a missing reading: the collector fills these in on its own
   * schedule, and a bridge that has not taken its first disk sample must not stop every
   * machine in the shop because it has no number yet.
   */
  private diskUsedPct(): number {
    const used = this.options.metrics.diskUsage.get();
    const free = this.options.metrics.diskFree.get();
    const total = used + free;
    return total > 0 ? (used / total) * 100 : 0;
  }
}
