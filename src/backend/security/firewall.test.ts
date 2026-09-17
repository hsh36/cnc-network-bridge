import {
  FIREWALL_TABLE,
  FirewallError,
  MANAGEMENT_PORTS,
  isManagementIsolationCurrent,
  renderManagementIsolation,
} from './firewall';

/**
 * The ruleset is a file executed as root, built from a string that names an interface
 * out of the configuration. Both halves of that sentence are what these tests are for:
 * that the rule it produces actually isolates the management ports on the TNC side, and
 * that nothing that is not an interface name can reach the file.
 */

describe('renderManagementIsolation', () => {
  it('drops the management ports arriving on the TNC interface', () => {
    const ruleset = renderManagementIsolation({ machineInterface: 'eth1' });

    expect(ruleset).toContain('iifname "eth1" tcp dport { 22, 443 } drop');
  });

  it('keeps the policy at accept', () => {
    // A default-deny policy here would take down SMB, DHCP and DNS on the machine
    // segment — the three services the appliance exists to provide.
    expect(renderManagementIsolation({ machineInterface: 'eth1' })).toContain('policy accept;');
  });

  it('is idempotent to load: it declares the table before deleting it', () => {
    const ruleset = renderManagementIsolation({ machineInterface: 'eth1' });
    const declare = ruleset.indexOf(`table inet ${FIREWALL_TABLE}\ndelete table inet`);

    // `delete` on a missing table is an error, so a fresh boot would fail to load a
    // file that deleted first.
    expect(declare).toBeGreaterThan(-1);
  });

  it('isolates SSH as well as HTTPS', () => {
    // "Configured from the LAN only" is not satisfied by closing the web interface and
    // leaving a shell open on the same segment.
    expect(MANAGEMENT_PORTS).toContain(22);
    expect(MANAGEMENT_PORTS).toContain(443);
  });

  it('names the ports in ascending order, whatever order they were given', () => {
    expect(
      renderManagementIsolation({ machineInterface: 'eth1', managementPorts: [443, 22] }),
    ).toBe(renderManagementIsolation({ machineInterface: 'eth1', managementPorts: [22, 443] }));
  });

  it.each([
    ['eth1; drop', 'a command separator'],
    ['eth1" accept "', 'a quote break-out'],
    ['../../etc/passwd', 'a path'],
    ['', 'empty'],
    ['thisnameiswaytoolong', 'over the kernel limit'],
  ])('refuses %p — %s', (iface) => {
    expect(() => renderManagementIsolation({ machineInterface: iface })).toThrow(FirewallError);
  });

  it.each([0, 65_536, -1, 1.5])('refuses the port %p', (port) => {
    expect(() =>
      renderManagementIsolation({ machineInterface: 'eth1', managementPorts: [port] }),
    ).toThrow(FirewallError);
  });

  it('refuses an empty port list rather than emitting a rule that matches nothing', () => {
    expect(() =>
      renderManagementIsolation({ machineInterface: 'eth1', managementPorts: [] }),
    ).toThrow(FirewallError);
  });
});

describe('isManagementIsolationCurrent', () => {
  it('recognises its own output', () => {
    const input = { machineInterface: 'eth1' };
    expect(isManagementIsolationCurrent(renderManagementIsolation(input), input)).toBe(true);
  });

  it('rejects a ruleset naming a different interface', () => {
    // The case that matters: the TNC side was moved to another NIC and the loaded rule
    // now points at one nothing arrives on.
    const stale = renderManagementIsolation({ machineInterface: 'eth1' });
    expect(isManagementIsolationCurrent(stale, { machineInterface: 'eth2' })).toBe(false);
  });

  it('treats a missing ruleset as not current', () => {
    expect(isManagementIsolationCurrent(undefined, { machineInterface: 'eth1' })).toBe(false);
  });
});

describe('routing the machine segment', () => {
  const routed = { machineInterface: 'eth1', lanInterface: 'eth0', internetAccess: true };

  it('drops forwarding off the machine side when internet access is off', () => {
    // Not merely "adds no route". The host may have `ip_forward` on for its own reasons,
    // and the off position has to mean something the appliance controls.
    const ruleset = renderManagementIsolation({ machineInterface: 'eth1' });

    expect(ruleset).toContain('iifname "eth1" drop');
    expect(ruleset).not.toContain('masquerade');
  });

  it('lets the control out and only lets the answer back', () => {
    const ruleset = renderManagementIsolation(routed);

    expect(ruleset).toContain('iifname "eth1" oifname "eth0" accept');
    expect(ruleset).toContain('iifname "eth0" oifname "eth1" ct state established,related accept');
    // The asymmetry is the point: the machine cannot be patched, so nothing may open a
    // connection towards it.
    expect(ruleset).toContain('iifname "eth0" oifname "eth1" drop');
  });

  it('masquerades behind the LAN interface, which is the only address upstream knows', () => {
    expect(renderManagementIsolation(routed)).toContain('oifname "eth0" masquerade');
  });

  it('still isolates management when routing is on', () => {
    // The two are independent: a machine allowed out to a licence server is not thereby
    // allowed into this appliance's configuration.
    expect(renderManagementIsolation(routed)).toContain(
      'iifname "eth1" tcp dport { 22, 443 } drop',
    );
  });

  it('refuses to route without a LAN interface to masquerade behind', () => {
    expect(() =>
      renderManagementIsolation({ machineInterface: 'eth1', internetAccess: true }),
    ).toThrow(FirewallError);
  });

  it('refuses to route a segment out of the interface it arrived on', () => {
    expect(() =>
      renderManagementIsolation({
        machineInterface: 'eth1',
        lanInterface: 'eth1',
        internetAccess: true,
      }),
    ).toThrow(FirewallError);
  });

  it('rejects a LAN interface name that is not one', () => {
    expect(() =>
      renderManagementIsolation({
        machineInterface: 'eth1',
        lanInterface: 'eth0"; drop',
        internetAccess: true,
      }),
    ).toThrow(FirewallError);
  });

  it('counts turning routing on as a ruleset change', () => {
    // Otherwise a bridge that already had the isolation rule loaded would keep it and
    // never apply the route the operator just asked for.
    const off = renderManagementIsolation({ machineInterface: 'eth1', lanInterface: 'eth0' });
    expect(isManagementIsolationCurrent(off, routed)).toBe(false);
  });
});
