/**
 * Constants shared by the backend and the browser bundle.
 * This module must stay free of Node and backend imports — it is compiled into the frontend.
 */

export const PRODUCT_NAME = 'SMB Bridge';

/**
 * Where updates come from.
 *
 * Deliberately a constant and not a config key. It was one, and that is exactly how an
 * appliance ends up unable to update itself: the repository was renamed, the value in
 * the database still pointed at the old one, and the update check asked GitHub about a
 * repository that no longer exists — silently, on a schedule, forever. Nobody
 * administering a CNC bridge has a reason to point it at a different repository, and
 * the one field that can break updating beyond self-repair should not be editable in a
 * web form.
 */
export const GITHUB_REPO = 'hsh36/smb-bridge';

/**
 * The one account.
 *
 * This appliance has no user management and is not getting any: it is administered by
 * whoever can reach it on the LAN, and that reachability is the access control. The
 * login form therefore does not ask for a name — asking for the only possible answer is
 * a field that can only ever be typed wrong.
 */
export const ADMIN_USERNAME = 'admin';

/** Every REST route is mounted below this prefix (IMPLEMENTATION_PLAN §5). */
export const API_BASE_PATH = '/api/v1';

/** Share names are used as filesystem paths and Samba section names, so they are tightly bounded. */
export const SHARE_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,32}$/;

/**
 * The account a control actually logs in as — the operator's chosen name, normalised.
 *
 * It lives in `shared` because both halves must give the same answer. The one time they
 * did not cost a production test: the backend created `tnc-pm1` and wrote
 * `valid users = tnc-pm1`, while the form offered a free-text "User" field whose value
 * was never used as a name at all. An operator who typed `PM1` in both places got
 * `mount error(13): Permission denied`, which reads as a wrong password and sends you
 * checking the one thing that was right.
 *
 * Lower case, because Samba tries a supplied username and then its lower-case form: a
 * lower-case account answers a control that sends either spelling, and an upper-case one
 * answers only its own. Characters outside the Unix-name set become dashes rather than
 * being dropped, so two different names cannot collapse into one account.
 */
export function machineAccountName(user: string): string {
  return user
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 32);
}

/**
 * The account an older build would have created for this share.
 *
 * Kept only so those accounts can be cleaned up. Until 0.4.6 the name was derived from
 * the share and forced to carry a `tnc-` prefix; an appliance that ever ran such a build
 * still has one per share, and nothing else would ever look at them again.
 */
export function legacyMachineAccountFor(shareName: string): string {
  return `tnc-${shareName.toLowerCase().replace(/[^a-z0-9_-]/g, '-')}`;
}

/** Conflict resolution strategies (IMPLEMENTATION_PLAN §3.1). */
export const CONFLICT_MODES = ['machine_wins', 'server_wins', 'last_write_wins'] as const;

/** Per-share lifecycle states driven by the sync orchestrator (T22). */
export const SHARE_STATUSES = [
  'idle',
  'scanning',
  'syncing',
  'paused',
  'error',
  'offline',
] as const;

/** Reconciliation state of a single indexed file (T15/T18). */
export const FILE_STATES = [
  'new',
  'synced',
  'pending_push',
  'pending_pull',
  'conflict',
  'deferred_locked',
  'error',
  'excluded',
] as const;

/** What caused a lock to be taken (T24). */
export const LOCK_ORIGINS = ['machine', 'manual', 'schedule', 'sync'] as const;

/** How a lock is projected onto the server share (T26). */
export const SERVER_LOCK_KINDS = ['none', 'sidecar', 'byte_range'] as const;

/** Prefix for in-flight transfer temp files. Vetoed in smb.conf and excluded from sync. */
export const TEMP_FILE_PREFIX = '.smb-tmp-';

/**
 * Returned in place of any secret value by the API, and accepted on write to mean
 * "leave this secret unchanged" (T5).
 */
export const SECRET_SENTINEL = '********';

/**
 * How much of a file the preview endpoint reads and returns.
 *
 * 64 KiB is several hundred lines of a NC program — far more than the question "is this
 * the right program" needs, and small enough that opening a file that turns out to be a
 * 400 MB CAD export costs nothing. A file larger than this is returned truncated rather
 * than refused: the beginning is what identifies it.
 */
export const PREVIEW_MAX_BYTES = 64 * 1024;
