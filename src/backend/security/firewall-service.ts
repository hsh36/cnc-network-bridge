import { type DbLogger } from '../config/db';
import { type HelperInvoker, invokePrivileged } from '../privileged/client';

import { type NetworkConfig } from '../../shared';

import { renderManagementIsolation } from './firewall';

/**
 * Keeps the management-isolation ruleset loaded, and with it whatever routing the
 * machine segment is allowed.
 *
 * Called at startup and again whenever the network configuration changes, because the
 * rules name interfaces: moving the TNC side from `eth1` to `eth2` without reloading
 * would leave the drop pointing at the wrong NIC — that is, at nothing — and quietly
 * expose the admin interface on the machine segment.
 *
 * Both halves of the ruleset come from the same call on purpose. `bridge.internetAccess`
 * was a stored setting with nothing behind it: the checkbox saved, the page confirmed,
 * and no route, no masquerade and no `ip_forward` ever followed. A shop that needed a
 * licence check turned it on and found it did not work; worse, a shop that turned it
 * *off* was never routing in the first place and had no way to know the switch was
 * decorative.
 *
 * A failure is logged and swallowed. The alternative is refusing to start, and a bridge
 * that will not boot because `nft` is missing is worse than one that boots and says so:
 * `management-guard.ts` still refuses TNC-side requests inside the process, so the
 * appliance degrades to "protected but noisy" rather than "unreachable".
 */
export interface FirewallServiceOptions {
  readonly logger?: DbLogger | undefined;
  /** Injectable for tests; defaults to the real sudo-backed helper. */
  readonly invoke?: HelperInvoker;
}

export class FirewallService {
  private readonly logger: DbLogger | undefined;
  private readonly invoke: HelperInvoker;
  private lastApplied: string | undefined;

  constructor(options: FirewallServiceOptions = {}) {
    this.logger = options.logger;
    this.invoke = options.invoke ?? invokePrivileged;
  }

  /**
   * Loads the ruleset the given network configuration calls for. Returns whether it is
   * now in force.
   *
   * Skips the helper call when the same ruleset was applied already: this runs on every
   * config save, and each invocation is a sudo call plus an `nft -f` that briefly
   * replaces the table.
   */
  apply(network: NetworkConfig): boolean {
    const machineInterface = network.machine.interface;
    /*
      Routing is a `single-machine` question, and the mode is checked here rather than
      trusted from the stored flag.

      `bridge.internetAccess` survives a mode change — it is a separate key, and nothing
      clears it when an operator moves back to `existing-network`. Reading it alone would
      mean a bridge that starts masquerading a segment it does not own, because of a box
      ticked for an arrangement that no longer exists.
    */
    const routing = network.mode === 'single-machine' && network.bridge.internetAccess;

    let content: string;
    try {
      content = renderManagementIsolation({
        machineInterface,
        lanInterface: network.lan.interface,
        internetAccess: routing,
      });
    } catch (error) {
      this.logger?.error(
        { machineInterface, error: messageOf(error) },
        'could not build the management isolation ruleset',
      );
      return false;
    }

    if (content === this.lastApplied) {
      return true;
    }

    try {
      const response = this.invoke({ verb: 'write-nft-ruleset', content, ipForward: routing });
      if (!response.ok) {
        this.logger?.error(
          { machineInterface, error: response.error },
          'the helper refused the management isolation ruleset',
        );
        return false;
      }
      this.lastApplied = content;
      this.logger?.info(
        { machineInterface, routing },
        routing
          ? 'management interface isolated from the TNC segment; machines routed out via NAT'
          : 'management interface isolated from the TNC segment by nftables',
      );
      return true;
    } catch (error) {
      this.logger?.error(
        { machineInterface, error: messageOf(error) },
        'could not load the management isolation ruleset; the in-process guard still applies',
      );
      return false;
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
