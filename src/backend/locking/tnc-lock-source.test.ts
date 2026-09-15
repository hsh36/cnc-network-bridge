import { mkdirSync } from 'node:fs';
import { join, posix } from 'node:path';

import { cleanupTmpDbs, tmpDb, tmpDir } from '../../../tests/support/tmp-db';
import { ConfigManager } from '../config/config-manager';
import { type Db } from '../config/db';
import { runMigrations } from '../config/migrations/runner';
import { generateSecretKey } from '../config/secrets';
import { type AuditEvent } from '../smb/audit-syslog';
import { type SmbOpenFile, type SmbSession, type SmbStatus } from '../smb/samba-service';

import { LockManager } from './lock-manager';
import { TncLockSource } from './tnc-lock-source';

let db: Db;
let config: ConfigManager;
let locks: LockManager;
let source: TncLockSource;
let shareId: number;

/** The export root smbd serves and logs against, as install.sh lays it out. */
const CACHE_PATH = '/srv/tnc/test';

function insertShare(name = 'test', enabled = 1): number {
  const now = 1_700_000_000;
  const result = db.run(
    `INSERT INTO shares (name, server_unc, mount_point, cache_path, enabled, created_at, updated_at)
     VALUES (@name, @unc, @mount, @cache, @enabled, @now, @now)`,
    {
      name,
      unc: `//fileserver/cnc$/${name}`,
      mount: posix.join('/mnt/tnc', name),
      cache: posix.join('/srv/tnc', name),
      enabled,
      now,
    },
  );
  return Number(result.lastInsertRowid);
}

function event(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    ts: Date.now(),
    operation: 'open',
    result: 'ok',
    clientIp: '172.16.37.42',
    user: 'tnc-test',
    share: 'test',
    path: '10.H',
    newPath: null,
    mode: 'w',
    ...overrides,
  };
}

function openFile(overrides: Partial<SmbOpenFile> = {}): SmbOpenFile {
  return {
    pid: 4242,
    uid: 1000,
    denyMode: 'DENY_NONE',
    access: '0x12019f',
    rw: 'RDWR',
    oplock: 'NONE',
    sharePath: CACHE_PATH,
    filename: '10.H',
    openedAt: null,
    ...overrides,
  };
}

function status(overrides: Partial<SmbStatus> = {}): SmbStatus {
  const session: SmbSession = {
    sessionId: '1',
    pid: 4242,
    username: 'tnc-test',
    group: 'tnc-test',
    remoteMachine: '172.16.37.42',
    dialect: 'NT1',
    encryption: null,
    signing: null,
  };
  return {
    version: '4.22.10',
    sessions: [session],
    tcons: [],
    openFiles: [],
    source: 'json',
    ...overrides,
  };
}

function activePaths(): string[] {
  return locks
    .list({ share: shareId, includeReleased: false, limit: 100, offset: 0 })
    .items.map((lock) => lock.relPath);
}

beforeEach(() => {
  db = tmpDb();
  runMigrations(db);
  config = ConfigManager.create({ db, secretKey: generateSecretKey() });
  // The sidecar projection writes under the share's mount point; give it a real one so
  // a failed projection does not muddy what these tests are about.
  mkdirSync(join(tmpDir(), 'mount'), { recursive: true });
  locks = new LockManager({ db, config });
  source = new TncLockSource({ db, config, locks });
  shareId = insertShare();
});

afterEach(() => {
  cleanupTmpDbs();
});

// ---------------------------------------------------------------------------
// Audit events
// ---------------------------------------------------------------------------

describe('handleEvent', () => {
  it('locks a file a machine opened for writing', () => {
    source.handleEvent(event());

    const lock = locks.getActive(shareId, '10.H');
    expect(lock).toMatchObject({ origin: 'tnc', tncIp: '172.16.37.42', ownerLabel: 'tnc-test' });
  });

  it('does not lock a read open', () => {
    // A control listing a directory or streaming a program it is running opens for read.
    // Locking on that would lock most of the share within seconds of a machine booting.
    source.handleEvent(event({ mode: 'r' }));
    expect(activePaths()).toEqual([]);
  });

  it('releases the lock when the machine closes the file', () => {
    source.handleEvent(event());
    source.handleEvent(event({ operation: 'close', mode: null }));

    expect(activePaths()).toEqual([]);
  });

  it('releases on unlink and on both ends of a rename', () => {
    source.handleEvent(event());
    source.handleEvent(event({ operation: 'unlink', mode: null }));
    expect(activePaths()).toEqual([]);

    source.handleEvent(event({ path: 'alt.H' }));
    source.handleEvent(event({ operation: 'rename', path: 'alt.H', newPath: 'neu.H', mode: null }));
    expect(activePaths()).toEqual([]);
  });

  it('ignores a close from a different machine than the one holding the lock', () => {
    // Two controls with the same program open is exactly what the table is for; the
    // second one closing must not free the first one's lock.
    source.handleEvent(event());
    source.handleEvent(event({ operation: 'close', mode: null, clientIp: '172.16.37.99' }));

    expect(activePaths()).toEqual(['10.H']);
  });

  it('leaves a manual lock alone when a machine closes the file', () => {
    locks.createManual(shareId, { shareId, relPath: '10.H', note: 'Meier' });
    source.handleEvent(event({ operation: 'close', mode: null }));

    expect(locks.getActive(shareId, '10.H')).toMatchObject({ origin: 'manual' });
  });

  it.each([
    ['our own sidecar', '.~lock.10.H#'],
    ['an in-flight transfer temp file', '.tnc-tmp-abc123'],
    ['a reachability probe', '.tnc-bridge-probe-1'],
    ['the version store', '.tnc-versions/10.H/1'],
    ["Samba's mkdir scratch name", '.::TMPNAME:D:83032%15382:neu'],
  ])('ignores %s', (_label, path) => {
    source.handleEvent(event({ path }));
    expect(activePaths()).toEqual([]);
  });

  it('ignores failed operations, the share root and unknown shares', () => {
    source.handleEvent(event({ result: 'fail' }));
    source.handleEvent(event({ path: '' }));
    source.handleEvent(event({ share: 'nicht-da' }));
    source.handleEvent(event({ share: null }));

    expect(activePaths()).toEqual([]);
  });

  it('survives locking being switched off in configuration', () => {
    config.set('locking', { ...config.get('locking'), enabled: false });
    expect(() => source.handleEvent(event())).not.toThrow();
    expect(activePaths()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// smbstatus reconciliation
// ---------------------------------------------------------------------------

describe('reconcile', () => {
  it('takes a lock for an open file the event stream missed', () => {
    const result = source.reconcile(status({ openFiles: [openFile()] }));

    expect(result).toMatchObject({ acquired: 1, released: 0, skipped: false });
    expect(locks.getActive(shareId, '10.H')).toMatchObject({
      origin: 'tnc',
      // Attributed through the pid → session lookup, not left anonymous.
      tncIp: '172.16.37.42',
    });
  });

  it('releases a machine lock for a file nothing has open any more', () => {
    source.handleEvent(event());
    const result = source.reconcile(status({ openFiles: [] }));

    expect(result).toMatchObject({ released: 1, skipped: false });
    expect(activePaths()).toEqual([]);
  });

  it('releases nothing when smbstatus could not be read', () => {
    // The dangerous case: treating "I could not find out" as "nothing is open" would
    // drop every lock on the bridge at the moment smbd is least healthy.
    source.handleEvent(event());
    const result = source.reconcile(null);

    expect(result).toEqual({ acquired: 0, released: 0, skipped: true });
    expect(activePaths()).toEqual(['10.H']);
  });

  it('leaves manual locks untouched', () => {
    locks.createManual(shareId, { shareId, relPath: 'handarbeit.H', note: 'Meier' });
    source.reconcile(status({ openFiles: [] }));

    expect(activePaths()).toEqual(['handarbeit.H']);
  });

  it('ignores read-only opens and files belonging to another share', () => {
    source.reconcile(
      status({
        openFiles: [
          openFile({ rw: 'RDONLY' }),
          openFile({ sharePath: '/srv/tnc/andere', filename: 'fremd.H' }),
        ],
      }),
    );

    expect(activePaths()).toEqual([]);
  });

  it('is idempotent across passes', () => {
    const open = status({ openFiles: [openFile()] });
    source.reconcile(open);
    const second = source.reconcile(open);

    expect(second).toMatchObject({ acquired: 0, released: 0 });
    expect(activePaths()).toEqual(['10.H']);
  });

  it('skips a disabled share', () => {
    db.run('UPDATE shares SET enabled = 0 WHERE id = @id', { id: shareId });
    source.reconcile(status({ openFiles: [openFile()] }));

    expect(activePaths()).toEqual([]);
  });
});

describe('cachePathFor', () => {
  it('answers with the export root the audit parser needs', () => {
    expect(source.cachePathFor('test')).toBe(CACHE_PATH);
    expect(source.cachePathFor('nicht-da')).toBeUndefined();
  });
});
