import { chmodSync, statSync } from 'node:fs';

/**
 * Taking a locked file's write permission away on the server share.
 *
 * ## Why a byte-range lock is not enough
 *
 * The shared lock in `byte-range.ts` does what it says: another client cannot write
 * bytes past it. What it cannot do is stop that client *opening* the file with
 * truncate-on-open, and the truncation happens at open, before a single byte is
 * written. Measured on the appliance on 2026-09-18, with a control holding a program
 * open: the write came back `NT_STATUS_FILE_LOCK_CONFLICT`, correctly refused — and the
 * program on the server was 0 bytes. The refusal arrived after the damage.
 *
 * The same hole has a second, quieter form. An editor that saves by writing a temporary
 * file and renaming it over the original never writes to the locked file at all; it
 * replaces it. The lock then belongs to an inode nothing points at any more. Windows
 * editors do this routinely.
 *
 * ## What this does instead
 *
 * Removes the write bits for the duration of the lock. On a CIFS mount that maps to the
 * DOS read-only attribute, and the server then refuses the open itself:
 *
 * | with the file read-only | another client reading | another client writing   |
 * |-------------------------|------------------------|--------------------------|
 * | measured                | allowed, 793 bytes     | `NT_STATUS_ACCESS_DENIED` at open |
 *
 * The file was untouched afterwards. Reading — the thing a colleague must keep — still
 * works, which is the same balance the shared lock was chosen for. It also covers the
 * rename case, because Windows will not replace a read-only file either.
 *
 * ## The failure that matters
 *
 * Leaving a file read-only that nobody will ever unlock. That is the shape of the bug
 * this codebase has already been bitten by once — the orphaned `flock` holders that left
 * a program permanently unwritable. So:
 *
 * - {@link applyReadOnly} reports whether it actually changed anything, and the caller
 *   records that on the lock row. A file that was *already* read-only is left alone and
 *   never made writable later; an operator who protected a file deliberately keeps their
 *   protection.
 * - {@link clearReadOnly} is driven from that record, so it only ever undoes this
 *   module's own work, and it runs on every path out of a lock: release, expiry, and a
 *   startup sweep for rows whose release never got that far.
 *
 * Unlike the byte-range holder, this state is not a running process and does not die
 * with the service. It has to be cleaned up deliberately, which is why the record lives
 * in the database rather than in memory.
 */

/** Write bits for user, group and other. */
const WRITE_BITS = 0o222;

export interface ReadOnlyResult {
  readonly ok: boolean;
  /**
   * True when this call removed write permission and a matching {@link clearReadOnly}
   * is owed. False when the file was already read-only, which is not ours to undo.
   */
  readonly applied: boolean;
  readonly error?: string;
}

/**
 * Removes write permission from `absolutePath`, if it had any.
 *
 * Never throws: an unreachable mount or a server that refuses the permission change is
 * a weaker lock, reported to the caller, and not a reason to refuse a lock the bridge
 * can still enforce on its own side.
 */
export function applyReadOnly(absolutePath: string): ReadOnlyResult {
  let mode: number;
  try {
    mode = statSync(absolutePath).mode;
  } catch (error) {
    return { ok: false, applied: false, error: messageOf(error) };
  }

  if ((mode & WRITE_BITS) === 0) {
    // Already read-only, by someone else's decision. Nothing to do and nothing to undo.
    return { ok: true, applied: false };
  }

  try {
    chmodSync(absolutePath, mode & ~WRITE_BITS);
  } catch (error) {
    return { ok: false, applied: false, error: messageOf(error) };
  }
  return { ok: true, applied: true };
}

/**
 * Gives write permission back.
 *
 * The bits are restored from the file's *current* mode rather than from a mode captured
 * when the lock was taken. A stored mode goes stale — the file can legitimately have
 * changed on the server in between — and writing a stale one back would be this module
 * causing exactly the kind of quiet damage it exists to prevent. What is restored is the
 * one fact that was true: it was writable before, so it is writable again.
 *
 * Mirrors the mount's own `file_mode`, which grants user and group. Other is left alone;
 * nothing on this appliance has ever wanted it.
 */
export function clearReadOnly(absolutePath: string): ReadOnlyResult {
  let mode: number;
  try {
    mode = statSync(absolutePath).mode;
  } catch (error) {
    return { ok: false, applied: false, error: messageOf(error) };
  }

  try {
    chmodSync(absolutePath, mode | 0o220);
  } catch (error) {
    return { ok: false, applied: false, error: messageOf(error) };
  }
  return { ok: true, applied: true };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
