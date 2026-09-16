import { spawn, type ChildProcess } from 'node:child_process';
import { posix } from 'node:path';

import { type DbLogger } from '../config/db';

/**
 * A lock the server actually enforces (T26).
 *
 * The sidecar marker next to it is a convention — anything that does not know the
 * convention writes straight through it. This is the part that cannot be ignored: a
 * shared byte-range lock, taken over the CIFS mount, which the SMB server refuses to
 * let another client write past. Measured against a Windows share:
 *
 * | lock held here | another client reading | another client writing |
 * |----------------|----------------------|------------------------|
 * | shared         | allowed              | refused                |
 * | exclusive      | refused              | refused                |
 *
 * Shared is the one worth having. A program that is open on a control should not be
 * editable by anyone else, but a colleague must still be able to look at it — an
 * exclusive lock would turn "someone is running this" into "nobody may read this".
 *
 * Two things have to be true for any of it to work, and neither is obvious:
 *
 * 1. The mount must not carry `nobrl`. That option means "never send byte-range lock
 *    requests to the server", so every lock stays inside this machine and the share is
 *    left wide open while the appliance believes it is protected. It was set, without a
 *    reason recorded, which is why this file did not exist for so long.
 * 2. The lock lives as long as the file descriptor holding it. Node has no `fcntl`, so
 *    the holder is a child process — `flock(1)` from util-linux, which is already on
 *    the appliance and needs no privileges beyond what the service already has on its
 *    own mount.
 *
 * A held lock is therefore a running process. That is not a workaround to be embarrassed
 * about: it makes the lifetime honest. If the bridge dies, its locks die with it, which
 * is the correct outcome — a lock nobody is left to release is worse than no lock.
 */

/** What `flock` is asked to run once it holds the descriptor. */
const HOLD_COMMAND = "printf 'ACQUIRED\n'; exec sleep infinity";

export interface ByteRangeResult {
  readonly ok: boolean;
  readonly error?: string;
}

type Spawn = typeof spawn;

export interface ByteRangeLockerOptions {
  readonly logger?: DbLogger;
  /** Injected by tests; production spawns the real `flock`. */
  readonly spawnImpl?: Spawn;
  /**
   * Called when a holder exits on its own — a dropped mount, a killed process, an
   * `flock` that could not take the lock after all. The row has to stop claiming a
   * projection that is no longer there.
   */
  readonly onLost?: (lockId: number, reason: string) => void;
}

export class ByteRangeLocker {
  private readonly logger: DbLogger | undefined;
  private readonly spawnImpl: Spawn;
  private readonly onLost: ((lockId: number, reason: string) => void) | undefined;
  private readonly held = new Map<number, ChildProcess>();

  constructor(options: ByteRangeLockerOptions = {}) {
    this.logger = options.logger;
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.onLost = options.onLost;
  }

  /** Absolute path of the server-side file a lock refers to. */
  static targetPath(mountPoint: string, relPath: string): string {
    return posix.join(mountPoint, relPath);
  }

  /**
   * Starts holding a shared lock on `absolutePath` for `lockId`.
   *
   * Returns as soon as the holder is running rather than waiting for it to confirm.
   * `flock --nonblock` fails within milliseconds or not at all, and the alternative is
   * making every caller of `LockManager.acquire` asynchronous — for a wait that, in the
   * overwhelming case, is for good news. A holder that does fail reports through
   * `onLost` a moment later and the row is corrected there.
   */
  acquire(lockId: number, absolutePath: string): ByteRangeResult {
    if (this.held.has(lockId)) {
      return { ok: true };
    }

    let child: ChildProcess;
    try {
      child = this.spawnImpl(
        'flock',
        ['--shared', '--nonblock', absolutePath, '-c', HOLD_COMMAND],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: false,
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `could not start the lock holder: ${message}` };
    }

    // Registered before anything else can return. A spawn that fails asynchronously —
    // no `flock` on this platform, most obviously — emits `error` on the child, and an
    // `error` with no listener is an uncaught exception that takes the process with it.
    child.once('error', (error: Error) => {
      if (this.held.get(lockId) === child) {
        this.held.delete(lockId);
        this.onLost?.(lockId, `the lock holder failed: ${error.message}`);
      }
    });

    if (child.pid === undefined) {
      return { ok: false, error: 'the lock holder did not start' };
    }

    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.once('exit', (code, signal) => {
      // A holder that is still registered when it exits was not released by us.
      if (this.held.get(lockId) === child) {
        this.held.delete(lockId);
        const reason =
          signal !== null
            ? `the lock holder was killed (${signal})`
            : `the lock holder exited with code ${String(code ?? -1)}${
                stderr.trim() === '' ? '' : `: ${stderr.trim()}`
              }`;
        this.logger?.warn({ lockId, absolutePath, reason }, 'server-side byte-range lock lost');
        this.onLost?.(lockId, reason);
      }
    });

    this.held.set(lockId, child);
    return { ok: true };
  }

  /** Stops holding the lock. Closing the descriptor is what releases it on the server. */
  release(lockId: number): void {
    const child = this.held.get(lockId);
    if (child === undefined) {
      return;
    }
    // Deleted first, so the exit handler does not report a release as a loss.
    this.held.delete(lockId);
    child.kill('SIGTERM');
  }

  isHeld(lockId: number): boolean {
    return this.held.has(lockId);
  }

  get count(): number {
    return this.held.size;
  }

  /** Drops every holder. Called when the service is shutting down. */
  releaseAll(): void {
    for (const lockId of [...this.held.keys()]) {
      this.release(lockId);
    }
  }
}
