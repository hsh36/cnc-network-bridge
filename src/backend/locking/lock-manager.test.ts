import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { cleanupTmpDbs, tmpDb, tmpDir } from '../../../tests/support/tmp-db';
import { ConfigManager } from '../config/config-manager';
import { type Db } from '../config/db';
import { runMigrations } from '../config/migrations/runner';
import { generateSecretKey } from '../config/secrets';
import { EventEmitter } from 'node:events';
import { type ChildProcess, type spawn } from 'node:child_process';
import { ByteRangeLocker } from './byte-range';
import { LockHeldError, LockManager, LockNotFoundError } from './lock-manager';

/** A holder that behaves like a successful `flock`: it starts and stays running. */
const fakeSpawn = (() => {
  const child = new EventEmitter() as EventEmitter & { pid: number; kill: () => boolean };
  child.pid = 1234;
  child.kill = () => true;
  return child as unknown as ChildProcess;
}) as unknown as typeof spawn;

let db: Db;
let config: ConfigManager;
let manager: LockManager;
let mountPoint: string;
let clockSeconds: number;

function insertShare(overrides: Record<string, string | number | null> = {}): number {
  const now = clockSeconds;
  const values = {
    name: 'programs',
    server_unc: '//fileserver/cnc$/programs',
    mount_point: mountPoint,
    cache_path: join(mountPoint, '..', 'cache'),
    created_at: now,
    updated_at: now,
    ...overrides,
  };
  const columns = Object.keys(values);
  const result = db.run(
    `INSERT INTO shares (${columns.join(', ')}) VALUES (${columns.map((c) => `@${c}`).join(', ')})`,
    values,
  );
  return Number(result.lastInsertRowid);
}

beforeEach(() => {
  db = tmpDb();
  runMigrations(db);
  config = ConfigManager.create({ db, secretKey: generateSecretKey() });
  mountPoint = join(tmpDir(), 'mount');
  mkdirSync(mountPoint, { recursive: true });
  clockSeconds = 1_700_000_000;
  // The temp directory stands in for a mounted server share. Stated rather than
  // assumed: production checks that the mount point really is a mount, because an
  // unmounted one takes the marker onto the appliance's own disk and reports success.
  manager = new LockManager({
    db,
    config,
    now: () => clockSeconds,
    isMounted: () => true,
    // No real `flock` is spawned here. These tests are about the rows and the marker;
    // the holder's own lifetime is covered in byte-range.test.ts, and spawning a child
    // per lock would make this suite depend on a util-linux that Windows does not have.
    byteRange: new ByteRangeLocker({ spawnImpl: fakeSpawn }),
  });
});

afterEach(() => {
  cleanupTmpDbs();
});

describe('acquire', () => {
  it('creates a lock row and writes the sidecar marker', () => {
    const shareId = insertShare();
    const lock = manager.acquire({
      shareId,
      relPath: 'PART1.H',
      origin: 'machine',
      machineIp: '192.168.42.50',
    });

    expect(lock.id).toBeGreaterThan(0);
    expect(lock.releasedAt).toBeNull();
    expect(lock.serverLockOk).toBe(true);
    expect(existsSync(join(mountPoint, '.~lock.PART1.H#'))).toBe(true);
  });

  it('refuses to write the marker when the share is not mounted', () => {
    // The case that prompted the check: the server's hostname did not resolve, the CIFS
    // mount failed, and the mount point stayed behind as an ordinary directory. The
    // marker landed on the appliance's own disk and the row said it had reached the
    // server. The lock is still real — it is a database row, not a file on the server —
    // but the row must say what actually happened.
    const unmounted = new LockManager({
      db,
      config,
      now: () => clockSeconds,
      isMounted: () => false,
    });
    const shareId = insertShare();

    const lock = unmounted.acquire({ shareId, relPath: 'PART1.H', origin: 'machine' });

    expect(lock.releasedAt).toBeNull();
    expect(lock.serverLockOk).toBe(false);
    expect(lock.serverLockError).toContain('not a mounted share');
    expect(existsSync(join(mountPoint, '.~lock.PART1.H#'))).toBe(false);
  });

  it('leaves the marker alone on release when the share is not mounted', () => {
    // Deleting the path anyway would remove a stray local file and report the marker
    // cleaned up, while the real one on the server stays there for good.
    const shareId = insertShare();
    const lock = manager.acquire({ shareId, relPath: 'PART1.H', origin: 'machine' });
    expect(existsSync(join(mountPoint, '.~lock.PART1.H#'))).toBe(true);

    const unmounted = new LockManager({
      db,
      config,
      now: () => clockSeconds,
      isMounted: () => false,
    });
    unmounted.release(lock.id);

    expect(existsSync(join(mountPoint, '.~lock.PART1.H#'))).toBe(true);
  });

  it('defaults a TNC lock TTL from configuration', () => {
    const shareId = insertShare();
    const lock = manager.acquire({ shareId, relPath: 'PART1.H', origin: 'machine' });
    expect(lock.expiresAt).toBe(clockSeconds + config.get('locking').machineLockTtlS);
  });

  it('leaves a manual lock without expiry unless a TTL is given', () => {
    const shareId = insertShare();
    const lock = manager.acquire({ shareId, relPath: 'PART1.H', origin: 'manual' });
    expect(lock.expiresAt).toBeNull();
  });

  it('honours an explicit TTL override', () => {
    const shareId = insertShare();
    const lock = manager.acquire({ shareId, relPath: 'PART1.H', origin: 'manual', ttlSeconds: 60 });
    expect(lock.expiresAt).toBe(clockSeconds + 60);
  });

  it('refuses a second lock on the same path', () => {
    const shareId = insertShare();
    manager.acquire({ shareId, relPath: 'PART1.H', origin: 'machine' });
    expect(() => manager.acquire({ shareId, relPath: 'PART1.H', origin: 'manual' })).toThrow(
      LockHeldError,
    );
  });

  it('allows locking the same path again once the first lock is released', () => {
    const shareId = insertShare();
    const first = manager.acquire({ shareId, relPath: 'PART1.H', origin: 'machine' });
    manager.release(first.id);
    expect(() => manager.acquire({ shareId, relPath: 'PART1.H', origin: 'manual' })).not.toThrow();
  });

  it('records a projection failure without refusing the lock', () => {
    const shareId = insertShare({ mount_point: join(mountPoint, 'does-not-exist') });
    const lock = manager.acquire({ shareId, relPath: 'PART1.H', origin: 'machine' });
    expect(lock.serverLockOk).toBe(false);
    expect(lock.serverLockError).toBeTruthy();
  });

  it('throws when locking is disabled', () => {
    config.set('locking', { ...config.get('locking'), enabled: false });
    const shareId = insertShare();
    expect(() => manager.acquire({ shareId, relPath: 'PART1.H', origin: 'manual' })).toThrow(
      'Locking is disabled',
    );
  });
});

describe('release', () => {
  it('removes the sidecar marker and marks the row released', () => {
    const shareId = insertShare();
    const lock = manager.acquire({ shareId, relPath: 'PART1.H', origin: 'machine' });
    const released = manager.release(lock.id, { reason: 'closed on TNC' });

    expect(released.releasedAt).toBe(clockSeconds);
    expect(released.note).toBe('closed on TNC');
    expect(existsSync(join(mountPoint, '.~lock.PART1.H#'))).toBe(false);
  });

  it('throws for an id that is not an active lock', () => {
    expect(() => manager.release(999)).toThrow(LockNotFoundError);
  });

  it('throws when releasing an already-released lock', () => {
    const shareId = insertShare();
    const lock = manager.acquire({ shareId, relPath: 'PART1.H', origin: 'manual' });
    manager.release(lock.id);
    expect(() => manager.release(lock.id)).toThrow(LockNotFoundError);
  });
});

describe('expireStale', () => {
  it('leaves an unexpired lock alone', () => {
    const shareId = insertShare();
    manager.acquire({ shareId, relPath: 'PART1.H', origin: 'machine' });
    expect(manager.expireStale()).toHaveLength(0);
  });

  it('releases a lock past its TTL and removes its sidecar', () => {
    const shareId = insertShare();
    manager.acquire({ shareId, relPath: 'PART1.H', origin: 'machine', ttlSeconds: 30 });
    clockSeconds += 31;

    const expired = manager.expireStale();
    expect(expired).toHaveLength(1);
    expect(expired[0]?.releasedAt).toBe(clockSeconds);
    expect(existsSync(join(mountPoint, '.~lock.PART1.H#'))).toBe(false);
  });

  it('never expires a lock with no TTL', () => {
    const shareId = insertShare();
    manager.acquire({ shareId, relPath: 'PART1.H', origin: 'manual' });
    clockSeconds += 1_000_000;
    expect(manager.expireStale()).toHaveLength(0);
  });
});

describe('list and getActive', () => {
  it('finds the active lock for a path', () => {
    const shareId = insertShare();
    manager.acquire({ shareId, relPath: 'PART1.H', origin: 'machine' });
    expect(manager.getActive(shareId, 'PART1.H')?.relPath).toBe('PART1.H');
    expect(manager.getActive(shareId, 'OTHER.H')).toBeUndefined();
  });

  it('excludes released locks by default and includes them on request', () => {
    const shareId = insertShare();
    const lock = manager.acquire({ shareId, relPath: 'PART1.H', origin: 'machine' });
    manager.release(lock.id);

    expect(manager.list({ limit: 100, offset: 0, includeReleased: false }).total).toBe(0);
    expect(manager.list({ limit: 100, offset: 0, includeReleased: true }).total).toBe(1);
  });

  it('filters by origin', () => {
    const shareId = insertShare();
    manager.acquire({ shareId, relPath: 'A.H', origin: 'machine' });
    manager.acquire({ shareId, relPath: 'B.H', origin: 'manual' });

    const result = manager.list({
      limit: 100,
      offset: 0,
      includeReleased: false,
      origin: 'manual',
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.relPath).toBe('B.H');
  });
});

describe('lock events', () => {
  it('notifies subscribers on acquire, release and expiry', () => {
    const shareId = insertShare();
    const seen: string[] = [];
    manager.onLockEvent((e) => seen.push(e.action));

    const lock = manager.acquire({
      shareId,
      relPath: 'PART1.H',
      origin: 'machine',
      ttlSeconds: 30,
    });
    manager.release(lock.id);

    const second = manager.acquire({ shareId, relPath: 'A.H', origin: 'machine', ttlSeconds: 10 });
    void second;
    clockSeconds += 20;
    manager.expireStale();

    expect(seen).toEqual(['acquired', 'released', 'acquired', 'expired']);
  });

  it('lets an unsubscribe stop further notifications', () => {
    const shareId = insertShare();
    const seen: string[] = [];
    const unsubscribe = manager.onLockEvent((e) => seen.push(e.action));
    unsubscribe();

    manager.acquire({ shareId, relPath: 'PART1.H', origin: 'machine' });
    expect(seen).toHaveLength(0);
  });

  it('does not let a throwing subscriber break the acquire call', () => {
    const shareId = insertShare();
    manager.onLockEvent(() => {
      throw new Error('subscriber bug');
    });
    expect(() => manager.acquire({ shareId, relPath: 'PART1.H', origin: 'manual' })).not.toThrow();
  });
});

describe('createManual', () => {
  it('forces origin to manual regardless of what the caller might pass elsewhere', () => {
    const shareId = insertShare();
    const lock = manager.createManual(shareId, {
      shareId,
      relPath: 'PART1.H',
      note: 'operator hold',
    });
    expect(lock.origin).toBe('manual');
    expect(lock.note).toBe('operator hold');
  });
});

describe('server-enforced locks', () => {
  /** Records what a holder was asked to do, without starting one. */
  function recordingLocker(): { locker: ByteRangeLocker; taken: string[]; dropped: number[] } {
    const taken: string[] = [];
    const dropped: number[] = [];
    const locker = {
      acquire: (_id: number, path: string) => {
        taken.push(path);
        return { ok: true };
      },
      release: (id: number) => {
        dropped.push(id);
      },
      releaseAll: () => undefined,
      isHeld: () => true,
      count: taken.length,
    } as unknown as ByteRangeLocker;
    return { locker, taken, dropped };
  }

  function managerWith(locker: ByteRangeLocker): LockManager {
    return new LockManager({
      db,
      config,
      now: () => clockSeconds,
      isMounted: () => true,
      byteRange: locker,
    });
  }

  it('takes the lock on the file on the server share, not the cached copy', () => {
    const { locker, taken } = recordingLocker();
    const shareId = insertShare();

    managerWith(locker).acquire({ shareId, relPath: 'sub/PART1.H', origin: 'machine' });

    // The cache copy is ours; locking it would protect nothing from anyone.
    expect(taken).toEqual([posix.join(mountPoint, 'sub/PART1.H')]);
  });

  it('writes the marker as well, so a person sees why the file will not save', () => {
    const { locker } = recordingLocker();
    const shareId = insertShare();

    const lock = managerWith(locker).acquire({ shareId, relPath: 'PART1.H', origin: 'machine' });

    expect(existsSync(join(mountPoint, '.~lock.PART1.H#'))).toBe(true);
    expect(lock.serverLockOk).toBe(true);
  });

  it('drops the holder when the lock is released', () => {
    const { locker, dropped } = recordingLocker();
    const shareId = insertShare();
    const mgr = managerWith(locker);
    const lock = mgr.acquire({ shareId, relPath: 'PART1.H', origin: 'machine' });

    mgr.release(lock.id);

    expect(dropped).toEqual([lock.id]);
  });

  it('records a lock the server will not enforce, rather than claiming it holds', () => {
    const failing = {
      acquire: () => ({ ok: false, error: 'flock: No such file or directory' }),
      release: () => undefined,
      releaseAll: () => undefined,
      isHeld: () => false,
      count: 0,
    } as unknown as ByteRangeLocker;
    const shareId = insertShare();

    const lock = managerWith(failing).acquire({ shareId, relPath: 'GONE.H', origin: 'machine' });

    // The row still stands: the bridge's own lock is the row, and the control's file
    // stays protected here even when the projection onto the server failed.
    expect(lock.releasedAt).toBeNull();
    expect(lock.serverLockOk).toBe(false);
    expect(lock.serverLockError).toMatch(/No such file/);
  });

  it('retakes the locks that outlived the process that was holding them', () => {
    // Every holder is a child process, so a restart leaves rows with nothing behind
    // them. Without this the bridge comes back believing it protects open files.
    const { locker, taken } = recordingLocker();
    const shareId = insertShare();
    managerWith(locker).acquire({ shareId, relPath: 'STILL_OPEN.H', origin: 'machine' });
    taken.length = 0;

    const afterRestart = managerWith(locker);
    const result = afterRestart.restoreServerLocks();

    expect(result).toEqual({ restored: 1, failed: 0 });
    expect(taken).toEqual([posix.join(mountPoint, 'STILL_OPEN.H')]);
  });

  it('does not retake a lock that was already released', () => {
    const { locker, taken } = recordingLocker();
    const shareId = insertShare();
    const mgr = managerWith(locker);
    const lock = mgr.acquire({ shareId, relPath: 'DONE.H', origin: 'machine' });
    mgr.release(lock.id);
    taken.length = 0;

    expect(managerWith(locker).restoreServerLocks()).toEqual({ restored: 0, failed: 0 });
    expect(taken).toEqual([]);
  });

  it('marks a lock unenforced when its share is not mounted at startup', () => {
    const { locker } = recordingLocker();
    const shareId = insertShare();
    managerWith(locker).acquire({ shareId, relPath: 'STILL_OPEN.H', origin: 'machine' });

    const unmounted = new LockManager({
      db,
      config,
      now: () => clockSeconds,
      isMounted: () => false,
      byteRange: locker,
    });
    expect(unmounted.restoreServerLocks()).toEqual({ restored: 0, failed: 1 });

    const row = db.get<{ server_lock_ok: number; server_lock_error: string }>(
      'SELECT server_lock_ok, server_lock_error FROM locks WHERE rel_path = @p',
      { p: 'STILL_OPEN.H' },
    );
    expect(row?.server_lock_ok).toBe(0);
    expect(row?.server_lock_error).toMatch(/not mounted/);
  });
});

/**
 * The one piece of lock state that outlives the process.
 *
 * A byte-range holder is a child process and dies with the service, which makes its
 * lifetime self-correcting. A file whose write permission has been taken away stays that
 * way until something puts it back — and a program nobody can save again is the failure
 * this codebase has already paid for once, with orphaned `flock` holders.
 */
describe('write permission left behind', () => {
  // Windows has no POSIX mode bits worth asserting on; the appliance is Linux.
  const itOnPosix = process.platform === 'win32' ? it.skip : it;

  itOnPosix('gives it back on release', () => {
    const shareId = insertShare({});
    writeFileSync(join(mountPoint, 'PART1.H'), 'BEGIN PGM PART1 MM\n', { mode: 0o660 });
    chmodSync(join(mountPoint, 'PART1.H'), 0o660);

    const lock = manager.acquire({ shareId, relPath: 'PART1.H', origin: 'machine' });
    expect(statSync(join(mountPoint, 'PART1.H')).mode & 0o222).toBe(0);

    manager.release(lock.id);
    expect(statSync(join(mountPoint, 'PART1.H')).mode & 0o220).toBe(0o220);
  });

  itOnPosix('sweeps a released lock whose restore never happened', () => {
    const shareId = insertShare({});
    const file = join(mountPoint, 'PART1.H');
    writeFileSync(file, 'BEGIN PGM PART1 MM\n', { mode: 0o660 });
    chmodSync(file, 0o660);

    const lock = manager.acquire({ shareId, relPath: 'PART1.H', origin: 'machine' });
    manager.release(lock.id);

    // The state a release that could not finish leaves behind: the row is closed, the
    // flag still says we owe a restore, and the file is still read-only. Staged
    // directly, because the ways to reach it for real — the mount gone at the wrong
    // moment, the process killed between the two — are not reproducible in a unit test.
    chmodSync(file, 0o440);
    db.run('UPDATE locks SET server_read_only_applied = 1 WHERE id = @id', { id: lock.id });

    expect(manager.sweepReadOnlyLeftovers()).toBe(1);
    expect(statSync(file).mode & 0o220).toBe(0o220);
  });

  itOnPosix('leaves alone a file it did not take the permission from', () => {
    const shareId = insertShare({});
    const file = join(mountPoint, 'PART1.H');
    writeFileSync(file, 'BEGIN PGM PART1 MM\n');
    // An operator protected this deliberately, before any lock existed.
    chmodSync(file, 0o440);

    const lock = manager.acquire({ shareId, relPath: 'PART1.H', origin: 'machine' });
    manager.release(lock.id);

    // Still theirs. Handing back a write bit nobody here removed would be the quiet
    // damage this whole mechanism exists to prevent.
    expect(statSync(file).mode & 0o222).toBe(0);
  });

  itOnPosix('does not sweep a lock that is still held', () => {
    const shareId = insertShare({});
    const file = join(mountPoint, 'PART1.H');
    writeFileSync(file, 'BEGIN PGM PART1 MM\n', { mode: 0o660 });
    chmodSync(file, 0o660);

    manager.acquire({ shareId, relPath: 'PART1.H', origin: 'machine' });

    expect(manager.sweepReadOnlyLeftovers()).toBe(0);
    expect(statSync(file).mode & 0o222).toBe(0);
  });
});
