import { type ConfigManager } from '../config/config-manager';
import { type Db, type DbLogger } from '../config/db';
import { invokePrivileged, type HelperInvoker } from '../privileged/client';
import { legacyMachineAccountFor, machineAccountName, ShareStore } from '../sync/share-store';

import { buildSmbConf, type SmbShareConfig } from './smb-conf';

/**
 * Writes `smb.conf` and reloads Samba whenever what it should contain changes.
 *
 * `buildSmbConf` and the `write-samba-config` verb were both complete and tested, and
 * nothing in the running service ever called either of them. The machine-facing half of
 * the bridge — the entire reason the product exists — was therefore not serving SMB at
 * all: shares synced into the local cache and no TNC could reach them.
 *
 * Reconciliation rather than save-triggered writes, for the same reason the sync
 * supervisor works that way. The desired file is a pure function of the config and the
 * shares table, so the only correct behaviour after a restart, a share edit or a
 * failover is "make the file match" — not "remember to write it here, and here, and in
 * this third place somebody will add next month".
 */

export interface SambaConfigManagerOptions {
  readonly db: Db;
  readonly config: ConfigManager;
  readonly logger?: DbLogger;
  /** Injected by tests; production calls the real helper over sudo. */
  readonly invoke?: HelperInvoker;
}

export class SambaConfigManager {
  private readonly db: Db;
  private readonly config: ConfigManager;
  private readonly logger: DbLogger | undefined;
  private readonly invoke: HelperInvoker;
  private readonly shares: ShareStore;
  /** The last content successfully written, so an unchanged reconcile is free. */
  private lastWritten: string | undefined;

  constructor(options: SambaConfigManagerOptions) {
    this.db = options.db;
    this.config = options.config;
    this.logger = options.logger;
    this.invoke = options.invoke ?? invokePrivileged;
    this.shares = new ShareStore({ db: options.db, config: options.config });

    // Both sections feed the file: `smb` supplies the protocol and naming globals, and
    // `network` supplies the interface smbd is confined to. Missing the second is how a
    // TNC-side NIC change would leave smbd bound to a card nothing arrives on.
    this.config.onSectionChange('smb', () => {
      this.reconcile();
    });
    this.config.onSectionChange('network', () => {
      this.reconcile();
    });
  }

  /** The file the current configuration and share list call for. */
  render(): string {
    const smb = this.config.get('smb');
    const network = this.config.get('network');

    const shares: SmbShareConfig[] = this.shares
      .list(500, 0)
      .items.filter((share) => share.enabled)
      .filter((share) => {
        // A share with guest access off and no account is one no machine can ever
        // connect to. Exporting it anyway means the control gets ACCESS_DENIED, which
        // reads as a password problem and sends an operator looking at credentials
        // that do not exist. Leaving it out and saying why is diagnosable.
        if (!share.machineGuestOk && share.machineUser === null) {
          this.logger?.warn(
            { share: share.name },
            'share not exported: guest access is off and no user is set, so no machine could connect',
          );
          return false;
        }
        return true;
      })
      .map((share) => ({
        name: share.name,
        // The *cache*, never the mount point. Exporting the CIFS mount would put a TNC's
        // writes straight onto the server with none of the locking or conflict handling
        // this bridge exists to provide, and would hang the machine whenever the server
        // was unreachable.
        path: share.cachePath,
        readOnly: share.readOnly || share.failoverReadOnly,
        guestOk: share.machineGuestOk,
        // Named only when the share actually authenticates. `valid users` alongside
        // `guest ok = yes` is a contradiction Samba resolves in favour of the guest,
        // which would silently make the account decorative.
        ...(share.machineGuestOk || share.machineUser === null
          ? {}
          : { validUsers: [machineAccountName(share.machineUser)] }),
        ...(share.excludePatterns.length > 0 ? { extraVetoFiles: share.excludePatterns } : {}),
      }));

    return buildSmbConf({
      machineInterface: network.machine.interface,
      // Handed over so the generator can prove it is absent rather than assume it.
      lanInterface: network.lan.interface,
      workgroup: smb.machine.workgroup,
      // The SMB server name is the TNC side's hostname: the name the machines dial,
      // which is deliberately independent of what the appliance calls itself.
      ...(network.machine.hostname === '' ? {} : { netbiosName: network.machine.hostname }),
      maxProtocol: smb.machine.maxProtocol,
      ntlmAuth: smb.machine.ntlmAuth,
      dosCharset: smb.machine.dosCharset,
      shares,
    });
  }

  /**
   * Create or drop the Samba accounts the shares call for.
   *
   * Before the file is written, so a `valid users` line never names an account that
   * does not exist yet — smbd would accept the stanza and refuse every login against
   * it, which looks to an operator exactly like a wrong password.
   *
   * Each share is handled in its own try/catch. One share with an unwritable account
   * must not stop the others from being exported: a partial bridge is worth more than
   * none, and the failure is on the record either way.
   */
  private reconcileAccounts(): void {
    for (const share of this.shares.list(500, 0).items) {
      const wanted = share.machineUser === null ? undefined : machineAccountName(share.machineUser);
      try {
        // The account an older build made for this share, if it is not also the one
        // wanted now. Left alone it would go on resolving forever: reconciliation walks
        // shares, and nothing would ever name that account again.
        const legacy = legacyMachineAccountFor(share.name);
        if (legacy !== wanted) {
          this.removeAccount(legacy);
        }

        if (!share.enabled || share.machineGuestOk || wanted === undefined) {
          if (wanted !== undefined) {
            this.removeAccount(wanted);
          }
          continue;
        }

        const password = this.shares.machinePassword(share.id);
        if (password === undefined) {
          // A share that names a user but has no password stored cannot authenticate
          // anyone. Saying so is more use than an account nobody can log into.
          this.logger?.warn(
            { share: share.name },
            'share has a machine user but no password; no account was created',
          );
          continue;
        }

        this.invoke({ verb: 'set-samba-user', username: wanted, password, remove: false });
      } catch (error) {
        this.logger?.error(
          { share: share.name, error: error instanceof Error ? error.message : String(error) },
          'could not reconcile the Samba account for a share',
        );
      }
    }
  }

  /**
   * Remove one account, tolerating every way that can fail.
   *
   * Removal is idempotent in the helper — an account that is not there is not an error —
   * and the helper refuses outright anything this product did not create. Both outcomes
   * are fine here; what must not happen is one stale account stopping the shares behind
   * it from being reconciled.
   */
  private removeAccount(username: string): void {
    try {
      this.invoke({ verb: 'set-samba-user', username, password: '', remove: true });
    } catch (error) {
      this.logger?.warn(
        { account: username, error: error instanceof Error ? error.message : String(error) },
        'could not remove a machine account',
      );
    }
  }

  /**
   * Drop the accounts a share owned — the one it uses now and the one an older build gave
   * it.
   *
   * Reconciliation cannot do this: {@link reconcileAccounts} walks the shares that exist,
   * and the point here is that this one no longer does. Nothing would ever name those
   * accounts again, so a deleted share left a login behind that still resolved — and a
   * share recreated under the same name inherited the old password rather than the one
   * just typed.
   *
   * Also the right call when the operator changes the machine user on a share that keeps
   * existing: the old account is as orphaned then as it is after a delete.
   *
   * Idempotent and non-throwing, like the rest of this class: removal tolerates an
   * account that was never created, and a share the operator asked to delete must not
   * survive because a `userdel` failed.
   */
  dropAccount(shareName: string, machineUser?: string | null): void {
    const accounts = new Set([legacyMachineAccountFor(shareName)]);
    if (machineUser !== undefined && machineUser !== null && machineUser !== '') {
      accounts.add(machineAccountName(machineUser));
    }
    for (const account of accounts) {
      this.removeAccount(account);
    }
  }

  /**
   * Make `smb.conf` match, and reload Samba if it changed.
   *
   * Never throws. A bridge that cannot write its Samba config is still bridging files
   * for whoever can already reach it, and taking the process down — or failing the
   * share edit that triggered this — would turn a degraded state into an outage. The
   * failure is logged, and the next reconcile tries again.
   */
  reconcile(): boolean {
    this.reconcileAccounts();

    let content: string;
    try {
      content = this.render();
    } catch (error) {
      this.logger?.error(
        { error: error instanceof Error ? error.message : String(error) },
        'could not render smb.conf',
      );
      return false;
    }

    if (content === this.lastWritten) {
      return false;
    }

    try {
      // The helper validates with `testparm` against a scratch file and only renames a
      // clean parse into place, so a bad render cannot leave smbd unconfined.
      this.invoke({ verb: 'write-samba-config', content });
      this.lastWritten = content;
      this.logger?.info({ bytes: content.length, shares: this.shareCount() }, 'smb.conf written');
      return true;
    } catch (error) {
      this.logger?.error(
        { error: error instanceof Error ? error.message : String(error) },
        'could not write smb.conf',
      );
      return false;
    }
  }

  /**
   * Restart smbd rather than reload it.
   *
   * `interfaces` and `bind interfaces only` are read at startup; smbd will not rebind
   * on a reload. A TNC-side NIC change therefore needs a restart, or smbd keeps
   * listening on the card the operator just moved away from.
   *
   * A failover flip needs one too, for a different reason: `read only` is applied when a
   * client connects to the share, and a control holds its mount from power-on, so a
   * reload never reaches it. There was a `reload()` here for that case and it did not
   * work — see the comment at the failover wiring in `server.ts`. The helper still
   * accepts `mode: 'reload'`; nothing in this service asks for it any more.
   */
  restart(): void {
    try {
      this.invoke({ verb: 'reload-samba', mode: 'restart' });
    } catch (error) {
      this.logger?.error(
        { error: error instanceof Error ? error.message : String(error) },
        'could not restart Samba',
      );
    }
  }

  private shareCount(): number {
    return this.db.pluck<number>('SELECT COUNT(*) FROM shares WHERE enabled = 1') ?? 0;
  }
}
