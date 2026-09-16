import { EventEmitter } from 'node:events';
import { type ChildProcess, type spawn } from 'node:child_process';

import { ByteRangeLocker } from './byte-range';

/**
 * A holder that can be made to behave like `flock` does: keep running while it holds
 * the descriptor, or fall over the moment it cannot take the lock.
 */
class FakeChild extends EventEmitter {
  readonly stderr = new EventEmitter();
  readonly killed: NodeJS.Signals[] = [];
  // A plain field, not a defaulted constructor parameter: passing `undefined` to one of
  // those falls back to the default, and "the holder never started" is a case under test.
  pid: number | undefined = 4242;
  kill(signal?: NodeJS.Signals): boolean {
    this.killed.push(signal ?? 'SIGTERM');
    return true;
  }
}

interface SpawnCall {
  readonly command: string;
  readonly args: readonly string[];
}

function harness(children: FakeChild[] = []) {
  const calls: SpawnCall[] = [];
  let index = 0;
  const spawnImpl = ((command: string, args: readonly string[]) => {
    calls.push({ command, args });
    const child = children[index] ?? new FakeChild();
    index += 1;
    return child as unknown as ChildProcess;
  }) as unknown as typeof spawn;
  return { calls, spawnImpl };
}

describe('taking the lock', () => {
  it('asks flock for a shared, non-blocking lock on the file', () => {
    const { calls, spawnImpl } = harness();
    const locker = new ByteRangeLocker({ spawnImpl });

    expect(locker.acquire(1, '/mnt/server/share/PART1.H')).toEqual({ ok: true });

    expect(calls[0]?.command).toBe('flock');
    // Shared, because an exclusive lock would stop a colleague reading a program that
    // is merely running. Non-blocking, because a lock request that waits would hang the
    // control's file open instead of reporting the conflict.
    expect(calls[0]?.args).toContain('--shared');
    expect(calls[0]?.args).toContain('--nonblock');
    expect(calls[0]?.args).toContain('/mnt/server/share/PART1.H');
  });

  it('holds one lock per id and does not start a second holder for the same one', () => {
    const { calls, spawnImpl } = harness();
    const locker = new ByteRangeLocker({ spawnImpl });

    locker.acquire(1, '/mnt/a/X.H');
    locker.acquire(1, '/mnt/a/X.H');

    expect(calls).toHaveLength(1);
    expect(locker.count).toBe(1);
  });

  it('reports a holder that never started, rather than claiming the lock', () => {
    const stillborn = new FakeChild();
    stillborn.pid = undefined;
    const { spawnImpl } = harness([stillborn]);
    const locker = new ByteRangeLocker({ spawnImpl });

    const result = locker.acquire(1, '/mnt/a/X.H');

    expect(result.ok).toBe(false);
    expect(locker.isHeld(1)).toBe(false);
  });

  it('survives a spawn that throws instead of letting it reach the caller', () => {
    const spawnImpl = (() => {
      throw new Error('ENOENT: flock is not installed');
    }) as unknown as typeof spawn;
    const locker = new ByteRangeLocker({ spawnImpl });

    const result = locker.acquire(1, '/mnt/a/X.H');

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/flock is not installed/);
  });
});

describe('a platform without flock', () => {
  it('reports the failure instead of letting an unhandled error kill the service', () => {
    // `spawn` does not throw when the binary is missing — it hands back a child with no
    // pid and emits `error` a tick later. An `error` nobody listens for is an uncaught
    // exception, so the appliance died taking a lock on a machine without `flock`.
    const child = new FakeChild();
    child.pid = undefined;
    const { spawnImpl } = harness([child]);
    const lost: string[] = [];
    const locker = new ByteRangeLocker({ spawnImpl, onLost: (_id, reason) => lost.push(reason) });

    locker.acquire(1, '/mnt/a/X.H');

    expect(() => child.emit('error', new Error('spawn flock ENOENT'))).not.toThrow();
    expect(locker.isHeld(1)).toBe(false);
  });
});

describe('losing the lock', () => {
  it('reports a holder that exits on its own, because the file is writable again', () => {
    const child = new FakeChild();
    const { spawnImpl } = harness([child]);
    const lost: { id: number; reason: string }[] = [];
    const locker = new ByteRangeLocker({
      spawnImpl,
      onLost: (id, reason) => lost.push({ id, reason }),
    });

    locker.acquire(7, '/mnt/a/X.H');
    child.stderr.emit('data', Buffer.from('flock: cannot open lock file'));
    child.emit('exit', 1, null);

    expect(lost).toHaveLength(1);
    expect(lost[0]?.id).toBe(7);
    expect(lost[0]?.reason).toMatch(/cannot open lock file/);
    expect(locker.isHeld(7)).toBe(false);
  });

  it('does not report a release as a loss', () => {
    const child = new FakeChild();
    const { spawnImpl } = harness([child]);
    const lost: number[] = [];
    const locker = new ByteRangeLocker({ spawnImpl, onLost: (id) => lost.push(id) });

    locker.acquire(7, '/mnt/a/X.H');
    locker.release(7);
    // The process dies a moment after the signal; by then it is no longer ours.
    child.emit('exit', null, 'SIGTERM');

    expect(lost).toEqual([]);
  });
});

describe('releasing', () => {
  it('kills the holder, since closing the descriptor is what lifts the lock', () => {
    const child = new FakeChild();
    const { spawnImpl } = harness([child]);
    const locker = new ByteRangeLocker({ spawnImpl });

    locker.acquire(3, '/mnt/a/X.H');
    locker.release(3);

    expect(child.killed).toEqual(['SIGTERM']);
    expect(locker.isHeld(3)).toBe(false);
  });

  it('is quiet about releasing a lock it never held', () => {
    const { spawnImpl } = harness();
    const locker = new ByteRangeLocker({ spawnImpl });

    expect(() => locker.release(99)).not.toThrow();
  });

  it('drops every holder on shutdown', () => {
    const children = [new FakeChild(), new FakeChild()];
    const { spawnImpl } = harness(children);
    const locker = new ByteRangeLocker({ spawnImpl });

    locker.acquire(1, '/mnt/a/X.H');
    locker.acquire(2, '/mnt/a/Y.H');
    locker.releaseAll();

    expect(locker.count).toBe(0);
    expect(children.every((c) => c.killed.length === 1)).toBe(true);
  });
});

describe('targetPath', () => {
  it('resolves the file on the server share, not in the cache', () => {
    expect(ByteRangeLocker.targetPath('/mnt/tnc-server/test', 'sub/PART1.H')).toBe(
      '/mnt/tnc-server/test/sub/PART1.H',
    );
  });
});
