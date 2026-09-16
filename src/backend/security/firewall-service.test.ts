import { type NetworkConfig, networkConfigSchema } from '../../shared';
import { type HelperResponse } from '../privileged/main';
import { type PrivilegedRequest } from '../privileged/verbs';

import { FirewallService } from './firewall-service';

/**
 * The service decides two things the ruleset itself cannot: whether the stored request
 * to route is one this arrangement can honour, and whether anything needs reapplying.
 */

function network(overrides: Partial<NetworkConfig> = {}): NetworkConfig {
  return networkConfigSchema.parse({
    lan: { interface: 'eth0' },
    tnc: { interface: 'eth1' },
    ...overrides,
  });
}

function service(): { firewall: FirewallService; calls: PrivilegedRequest[] } {
  const calls: PrivilegedRequest[] = [];
  const firewall = new FirewallService({
    invoke: (request: PrivilegedRequest): HelperResponse => {
      calls.push(request);
      return { ok: true, verb: request.verb };
    },
  });
  return { firewall, calls };
}

function lastCall(calls: readonly PrivilegedRequest[]): {
  content: string;
  ipForward: boolean;
} {
  const call = calls[calls.length - 1];
  if (call?.verb !== 'write-nft-ruleset') {
    throw new Error('expected a ruleset write');
  }
  return { content: call.content, ipForward: call.ipForward };
}

it('routes a single machine out when the operator asked for it', () => {
  const { firewall, calls } = service();

  firewall.apply(network({ mode: 'single-machine', bridge: { internetAccess: true } }));

  const call = lastCall(calls);
  expect(call.ipForward).toBe(true);
  expect(call.content).toContain('masquerade');
});

it('does not route when the operator did not ask', () => {
  const { firewall, calls } = service();

  firewall.apply(network({ mode: 'single-machine', bridge: { internetAccess: false } }));

  const call = lastCall(calls);
  expect(call.ipForward).toBe(false);
  expect(call.content).not.toContain('masquerade');
});

it('ignores a flag left over from a mode the bridge is no longer in', () => {
  // `bridge.internetAccess` is its own key and nothing clears it on a mode change. Read
  // on its own it would have this bridge masquerade a segment it does not own.
  const { firewall, calls } = service();

  firewall.apply(network({ mode: 'existing-network', bridge: { internetAccess: true } }));

  const call = lastCall(calls);
  expect(call.ipForward).toBe(false);
  expect(call.content).not.toContain('masquerade');
});

it('reapplies when routing is switched on, rather than seeing an unchanged ruleset', () => {
  const { firewall, calls } = service();

  firewall.apply(network({ mode: 'single-machine', bridge: { internetAccess: false } }));
  firewall.apply(network({ mode: 'single-machine', bridge: { internetAccess: true } }));

  expect(calls).toHaveLength(2);
  expect(lastCall(calls).ipForward).toBe(true);
});

it('skips the helper when nothing about the ruleset changed', () => {
  const { firewall, calls } = service();

  firewall.apply(network());
  firewall.apply(network());

  expect(calls).toHaveLength(1);
});
