import { cleanupTmpDbs, tmpDb } from '../../../tests/support/tmp-db';
import { ConfigManager } from '../config/config-manager';
import { type Db } from '../config/db';
import { runMigrations } from '../config/migrations/runner';
import { generateSecretKey } from '../config/secrets';
import { createBridgeMetrics } from '../monitoring/registry';
import { renderSmbConf } from '../smb/smb-conf';

import { FailoverService, type FailoverChange } from './failover-service';

/**
 * The controller's own rules are covered in failover.test.ts. This covers the wiring
 * that did not exist: that a verdict reaches `shares.failover_read_only`, that it gets
 * there once rather than on every tick, and that the column it writes is the one Samba
 * renders as `read only = yes` — which is the whole point, because until smbd is told,
 * a machine can still save into a share whose server is gone.
 */

let db: Db;
let config: ConfigManager;
let metrics: ReturnType<typeof createBridgeMetrics>;
let clock: number;
let flips: FailoverChange[];

const GRACE_S = 300;

function addShare(name: string, status = 'idle'): number {
  return Number(
    db.run(
      `INSERT INTO shares (name, server_unc, mount_point, cache_path, status, created_at, updated_at)
       VALUES (@name, @unc, @mount, @cache, @status, 0, 0)`,
      {
        name,
        unc: `//fs/${name}`,
        mount: `/mnt/tnc-server/${name}`,
        cache: `/srv/tnc/${name}`,
        status,
      },
    ).lastInsertRowid,
  );
}

function setStatus(shareId: number, status: string): void {
  db.run('UPDATE shares SET status = @status WHERE id = @id', { id: shareId, status });
}

function isReadOnly(shareId: number): boolean {
  return (
    db.pluck<number>('SELECT failover_read_only FROM shares WHERE id = @id', { id: shareId }) === 1
  );
}

function service(): FailoverService {
  return new FailoverService({
    db,
    config,
    metrics,
    onFlip: (change) => flips.push(change),
    now: () => clock,
    controllerOptions: { serverGraceS: GRACE_S, diskFullPct: 95, recoveryStabilityS: 60 },
  });
}

/** Sets the disk gauges so `diskUsedPct` lands on the requested percentage. */
function setDiskUsedPct(pct: number): void {
  metrics.diskUsage.set(pct);
  metrics.diskFree.set(100 - pct);
}

beforeEach(() => {
  db = tmpDb();
  runMigrations(db);
  config = ConfigManager.create({ db, secretKey: generateSecretKey() });
  metrics = createBridgeMetrics();
  clock = 1_000_000;
  flips = [];
  setDiskUsedPct(10);
});

afterEach(() => {
  cleanupTmpDbs();
});

describe('a server that goes away', () => {
  it('leaves writes alone inside the grace period', () => {
    // An ordinary switch reboot or a DHCP renewal must not disturb a running job.
    const id = addShare('programs');
    const failover = service();
    failover.observe();

    setStatus(id, 'offline');
    failover.observe();
    clock += GRACE_S - 1;
    failover.observe();

    expect(isReadOnly(id)).toBe(false);
    expect(flips).toHaveLength(0);
  });

  it('stops writes once the grace period is over', () => {
    const id = addShare('programs');
    const failover = service();
    failover.observe();

    setStatus(id, 'offline');
    failover.observe();
    clock += GRACE_S;
    failover.observe();

    expect(isReadOnly(id)).toBe(true);
    expect(flips).toEqual([
      expect.objectContaining({ shareId: id, readOnly: true, reasons: ['server_unreachable'] }),
    ]);
  });

  it('reports why, so an operator does not have to read the log', () => {
    const id = addShare('programs');
    const failover = service();
    failover.observe();
    setStatus(id, 'offline');
    failover.observe();
    clock += GRACE_S;
    failover.observe();

    expect(failover.readOnlyReason()).toBe(`share ${String(id)}: server_unreachable`);
  });

  it('says nothing while everything is fine', () => {
    addShare('programs');
    const failover = service();
    failover.observe();

    expect(failover.readOnlyReason()).toBeNull();
  });
});

describe('a server that comes back', () => {
  function failOver(failover: FailoverService, id: number): void {
    failover.observe();
    setStatus(id, 'offline');
    failover.observe();
    clock += GRACE_S;
    failover.observe();
  }

  it('does not resume on the first successful probe', () => {
    // A server up for ten seconds a minute would otherwise toggle the flag repeatedly,
    // and every toggle is an smbd reload that drops the machines' sessions.
    const id = addShare('programs');
    const failover = service();
    failOver(failover, id);

    setStatus(id, 'idle');
    failover.observe();
    clock += 59;
    failover.observe();

    expect(isReadOnly(id)).toBe(true);
  });

  it('resumes once the link has been healthy long enough', () => {
    const id = addShare('programs');
    const failover = service();
    failOver(failover, id);

    setStatus(id, 'idle');
    failover.observe();
    clock += 60;
    failover.observe();

    expect(isReadOnly(id)).toBe(false);
    expect(flips.at(-1)).toMatchObject({ shareId: id, readOnly: false });
  });
});

describe('what the flip costs', () => {
  it('writes and reports once, not on every tick', () => {
    // The consequence of a flip is an smb.conf render and an smbd reload. Re-asserting
    // an unchanged flag every fifteen seconds would reload Samba forever.
    const id = addShare('programs');
    const failover = service();
    failover.observe();
    setStatus(id, 'offline');
    failover.observe();
    clock += GRACE_S;

    for (let i = 0; i < 5; i += 1) {
      clock += 15;
      failover.observe();
    }

    expect(flips).toHaveLength(1);
  });
});

describe('several shares', () => {
  it('stops only the share whose server is gone', () => {
    // Shares can come from different servers, and stopping machines that have nothing to
    // do with the failure would be worse than the failure.
    const down = addShare('programs');
    const up = addShare('tools');
    const failover = service();
    failover.observe();

    setStatus(down, 'offline');
    failover.observe();
    clock += GRACE_S;
    failover.observe();

    expect(isReadOnly(down)).toBe(true);
    expect(isReadOnly(up)).toBe(false);
  });

  it('stops every share when the disk is full, because there is only one disk', () => {
    const a = addShare('programs');
    const b = addShare('tools');
    const failover = service();
    failover.observe();

    setDiskUsedPct(96);
    failover.observe();

    expect(isReadOnly(a)).toBe(true);
    expect(isReadOnly(b)).toBe(true);
  });

  it('treats a missing disk reading as empty rather than full', () => {
    // The collector fills these in on its own schedule. A bridge that has not taken its
    // first sample must not stop every machine in the shop for want of a number.
    metrics.diskUsage.set(0);
    metrics.diskFree.set(0);
    const id = addShare('programs');
    const failover = service();
    failover.observe();

    expect(isReadOnly(id)).toBe(false);
  });

  it('ignores a disabled share', () => {
    const id = addShare('programs', 'offline');
    db.run('UPDATE shares SET enabled = 0 WHERE id = @id', { id });
    const failover = service();
    failover.observe();
    clock += GRACE_S;
    failover.observe();

    expect(isReadOnly(id)).toBe(false);
  });
});

describe('a sync engine that cannot reason about its own state', () => {
  it('stops writes without waiting out a grace period', () => {
    // `error` means the engine could not work out what to do. The controller's rule is
    // that it must then not act — and neither should the machines.
    const id = addShare('programs');
    const failover = service();
    failover.observe();

    setStatus(id, 'error');
    failover.observe();

    expect(isReadOnly(id)).toBe(true);
    expect(flips[0]?.reasons).toContain('sync_error');
  });
});

describe('the flag Samba renders', () => {
  it('is the one that becomes "read only = yes"', () => {
    /*
      The end of the chain, asserted rather than assumed. Everything above writes a
      column; this is what makes a machine's save fail, and it is the only step that is
      visible to the person standing at the control.
    */
    const share = { name: 'programs', path: '/srv/tnc/programs', guestOk: true };

    const writable = renderSmbConf({
      tncInterface: 'eth1',
      shares: [{ ...share, readOnly: false }],
    });
    const refused = renderSmbConf({
      tncInterface: 'eth1',
      shares: [{ ...share, readOnly: true }],
    });

    expect(writable).toContain('read only = no');
    expect(refused).toContain('read only = yes');
  });
});
