-- Schema v13 — the machine side is no longer named after one control family
--
-- Wrapped in a transaction by the migration runner; this file must not open one.
--
-- The product was renamed from CNC Network Bridge to SMB Bridge, because what it does —
-- put an SMB1 island in front of a modern share — is not specific to CNC. The schema
-- carried the old name in three ways, and all three change here:
--
--   * column names   tnc_user, tnc_password, tnc_guest_ok, tnc_ip
--   * stored values  conflict_mode 'tnc_wins', locks.origin 'tnc', versions.origin 'tnc'
--   * a table name   tnc_clients
--
-- Several of those live inside CHECK constraints, which SQLite cannot alter in place, so
-- the affected tables are rebuilt.
--
-- ## Why the children are copied out first
--
-- Four tables reference `shares` with ON DELETE CASCADE: file_index, locks, file_versions
-- and conflicts. `DROP TABLE shares` performs an implicit delete of every row, so with
-- foreign keys on — which is how the service runs — dropping the old shares table takes
-- all four with it. The first draft of this migration did exactly that and silently
-- emptied them; the tests below exist because of it.
--
-- SQLite's documented answer is `PRAGMA foreign_keys=OFF` around the rebuild, but that
-- pragma is a no-op inside a transaction and the runner wraps every migration in one.
-- Giving this file the no-transaction marker would trade a lost cascade for a database
-- that can end up half-rebuilt if anything fails midway, which is the worse of the two.
--
-- So the children are copied into scratch tables first. `CREATE TABLE … AS SELECT`
-- produces a table with no constraints and no foreign keys, so nothing cascades into it;
-- the originals are dropped, `shares` is rebuilt with nothing left pointing at it, and
-- the children are recreated from the scratch copies with their ids intact.

-- ---------------------------------------------------------------------------
-- 1 · copy the children somewhere nothing can cascade into
-- ---------------------------------------------------------------------------

CREATE TABLE _m13_file_index AS SELECT * FROM file_index;
CREATE TABLE _m13_locks AS SELECT * FROM locks;
CREATE TABLE _m13_file_versions AS SELECT * FROM file_versions;
CREATE TABLE _m13_conflicts AS SELECT * FROM conflicts;

-- conflicts before file_versions: it references that table as well as shares.
DROP TABLE conflicts;
DROP TABLE file_versions;
DROP TABLE locks;
DROP TABLE file_index;

-- ---------------------------------------------------------------------------
-- 2 · shares: two columns and one enum value
-- ---------------------------------------------------------------------------

ALTER TABLE shares RENAME COLUMN tnc_user TO machine_user;
ALTER TABLE shares RENAME COLUMN tnc_password TO machine_password;
ALTER TABLE shares RENAME COLUMN tnc_guest_ok TO machine_guest_ok;

CREATE TABLE shares_new (
  id                    INTEGER PRIMARY KEY,
  name                  TEXT NOT NULL UNIQUE
                          CHECK (length(name) BETWEEN 1 AND 32
                                 AND name NOT GLOB '*[^A-Za-z0-9_-]*'),
  enabled               INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  server_unc            TEXT NOT NULL,
  mount_point           TEXT NOT NULL,
  cache_path            TEXT NOT NULL,
  smb_domain            TEXT,
  smb_user              TEXT,
  smb_version           TEXT NOT NULL DEFAULT '3.1.1',
  smb_seal              INTEGER NOT NULL DEFAULT 1 CHECK (smb_seal IN (0, 1)),
  conflict_mode         TEXT NOT NULL DEFAULT 'last_write_wins'
                          CHECK (conflict_mode IN ('machine_wins', 'server_wins', 'last_write_wins')),
  exclude_patterns      TEXT NOT NULL DEFAULT '[]',
  scan_interval_ms      INTEGER NOT NULL DEFAULT 15000 CHECK (scan_interval_ms > 0),
  bandwidth_limit_kbps  INTEGER CHECK (bandwidth_limit_kbps IS NULL OR bandwidth_limit_kbps > 0),
  max_file_size_mb      INTEGER NOT NULL DEFAULT 512 CHECK (max_file_size_mb > 0),
  read_only             INTEGER NOT NULL DEFAULT 0 CHECK (read_only IN (0, 1)),
  failover_read_only    INTEGER NOT NULL DEFAULT 0 CHECK (failover_read_only IN (0, 1)),
  machine_guest_ok      INTEGER NOT NULL DEFAULT 1 CHECK (machine_guest_ok IN (0, 1)),
  status                TEXT NOT NULL DEFAULT 'idle'
                          CHECK (status IN ('idle', 'scanning', 'syncing',
                                            'paused', 'error', 'offline')),
  last_scan_at          INTEGER,
  last_error            TEXT,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  smb_password          TEXT,
  machine_user          TEXT,
  machine_password      TEXT,
  UNIQUE (mount_point),
  UNIQUE (cache_path)
);

INSERT INTO shares_new
  SELECT id, name, enabled, server_unc, mount_point, cache_path, smb_domain, smb_user,
         smb_version, smb_seal,
         CASE conflict_mode WHEN 'tnc_wins' THEN 'machine_wins' ELSE conflict_mode END,
         exclude_patterns, scan_interval_ms, bandwidth_limit_kbps, max_file_size_mb,
         read_only, failover_read_only, machine_guest_ok, status, last_scan_at,
         last_error, created_at, updated_at, smb_password, machine_user, machine_password
    FROM shares;

DROP TABLE shares;
ALTER TABLE shares_new RENAME TO shares;

-- ---------------------------------------------------------------------------
-- 3 · the children, rebuilt and refilled
-- ---------------------------------------------------------------------------

CREATE TABLE file_index (
  id             INTEGER PRIMARY KEY,
  share_id       INTEGER NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  rel_path       TEXT NOT NULL,
  rel_path_ci    TEXT NOT NULL,
  is_dir         INTEGER NOT NULL DEFAULT 0 CHECK (is_dir IN (0, 1)),
  loc_size       INTEGER,
  loc_mtime      INTEGER,
  loc_hash       TEXT,
  srv_size       INTEGER,
  srv_mtime      INTEGER,
  srv_hash       TEXT,
  base_size      INTEGER,
  base_mtime     INTEGER,
  base_hash      TEXT,
  state          TEXT NOT NULL DEFAULT 'new'
                   CHECK (state IN ('new', 'synced', 'pending_push', 'pending_pull',
                                    'conflict', 'deferred_locked', 'error', 'excluded')),
  last_sync_at   INTEGER,
  last_error     TEXT,
  retry_count    INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  next_retry_at  INTEGER,
  -- Case-insensitive uniqueness is what makes a case-collision detectable rather
  -- than a silent overwrite when an SMB client renames PART1.H to part1.h.
  UNIQUE (share_id, rel_path_ci)
);

INSERT INTO file_index SELECT * FROM _m13_file_index;

CREATE TABLE locks (
  id                INTEGER PRIMARY KEY,
  share_id          INTEGER NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  rel_path          TEXT NOT NULL,
  origin            TEXT NOT NULL CHECK (origin IN ('machine', 'manual', 'schedule', 'sync')),
  owner_label       TEXT,
  machine_ip        TEXT,
  smb_pid           INTEGER,
  smb_session_id    TEXT,
  server_lock_kind  TEXT NOT NULL DEFAULT 'sidecar'
                      CHECK (server_lock_kind IN ('none', 'sidecar', 'byte_range')),
  server_lock_ok    INTEGER NOT NULL DEFAULT 0 CHECK (server_lock_ok IN (0, 1)),
  server_lock_error TEXT,
  acquired_at       INTEGER NOT NULL,
  expires_at        INTEGER,
  released_at       INTEGER,
  note              TEXT
);

INSERT INTO locks
  SELECT id, share_id, rel_path,
         CASE origin WHEN 'tnc' THEN 'machine' ELSE origin END,
         owner_label, tnc_ip, smb_pid, smb_session_id, server_lock_kind, server_lock_ok,
         server_lock_error, acquired_at, expires_at, released_at, note
    FROM _m13_locks;

CREATE TABLE file_versions (
  id          INTEGER PRIMARY KEY,
  share_id    INTEGER NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  rel_path    TEXT NOT NULL,
  hash        TEXT NOT NULL,
  size        INTEGER NOT NULL CHECK (size >= 0),
  mtime       INTEGER NOT NULL,
  origin      TEXT NOT NULL
                CHECK (origin IN ('server', 'machine', 'restore', 'initial', 'conflict_loser')),
  reason      TEXT,
  created_at  INTEGER NOT NULL,
  pinned      INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1))
);

INSERT INTO file_versions
  SELECT id, share_id, rel_path, hash, size, mtime,
         CASE origin WHEN 'tnc' THEN 'machine' ELSE origin END,
         reason, created_at, pinned
    FROM _m13_file_versions;

CREATE TABLE conflicts (
  id                 INTEGER PRIMARY KEY,
  ts                 INTEGER NOT NULL,
  share_id           INTEGER NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  rel_path           TEXT NOT NULL,
  mode_applied       TEXT NOT NULL
                       CHECK (mode_applied IN ('machine_wins', 'server_wins', 'last_write_wins')),
  winner             TEXT NOT NULL CHECK (winner IN ('local', 'remote')),
  loser_version_id   INTEGER REFERENCES file_versions(id) ON DELETE SET NULL,
  winner_hash        TEXT,
  loser_hash         TEXT,
  local_mtime        INTEGER,
  remote_mtime       INTEGER,
  acknowledged       INTEGER NOT NULL DEFAULT 0 CHECK (acknowledged IN (0, 1)),
  detail             TEXT
);

INSERT INTO conflicts
  SELECT id, ts, share_id, rel_path,
         CASE mode_applied WHEN 'tnc_wins' THEN 'machine_wins' ELSE mode_applied END,
         winner, loser_version_id, winner_hash, loser_hash, local_mtime, remote_mtime,
         acknowledged, detail
    FROM _m13_conflicts;

DROP TABLE _m13_conflicts;
DROP TABLE _m13_file_versions;
DROP TABLE _m13_locks;
DROP TABLE _m13_file_index;

-- The indexes went with their tables and come back with them, under their own names:
-- a rebuild that renames an index is a rebuild that drops one, as far as anything
-- looking for it is concerned.
CREATE INDEX idx_fi_state ON file_index(share_id, state);
CREATE INDEX idx_fi_retry ON file_index(next_retry_at) WHERE next_retry_at IS NOT NULL;
CREATE UNIQUE INDEX idx_locks_active ON locks(share_id, rel_path) WHERE released_at IS NULL;
CREATE INDEX idx_locks_expiry ON locks(expires_at) WHERE released_at IS NULL AND expires_at IS NOT NULL;
CREATE INDEX idx_ver_path ON file_versions(share_id, rel_path, created_at DESC);
CREATE INDEX idx_ver_hash ON file_versions(hash);
CREATE INDEX idx_conflicts_ts ON conflicts(ts DESC);
CREATE INDEX idx_conflicts_open ON conflicts(share_id, acknowledged) WHERE acknowledged = 0;

-- ---------------------------------------------------------------------------
-- 4 · tnc_clients: the table name itself
-- ---------------------------------------------------------------------------

DROP INDEX IF EXISTS idx_tnc_mac;
ALTER TABLE tnc_clients RENAME TO machine_clients;
CREATE UNIQUE INDEX idx_machine_mac ON machine_clients(mac_address) WHERE mac_address IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 5 · stored configuration
--
-- `network.tnc.*` and `smb.tnc.*` are flattened config keys, one row per leaf, and
-- `sync.conflictMode` may hold the renamed value.
--
-- `UPDATE OR REPLACE`, because both spellings can be present at once: a build that
-- already knows the new names writes its defaults into `network.machine.*` on load, and
-- the renamed row would then collide with one on the primary key. The stored row wins,
-- which is the right way round — it is the operator's answer, and the one it displaces
-- is a default that was never chosen.
-- ---------------------------------------------------------------------------

UPDATE OR REPLACE config
   SET key = 'network.machine' || substr(key, length('network.tnc') + 1),
       updated_at = unixepoch(),
       updated_by = 'migration-013'
 WHERE key LIKE 'network.tnc.%';

UPDATE OR REPLACE config
   SET key = 'smb.machine' || substr(key, length('smb.tnc') + 1),
       updated_at = unixepoch(),
       updated_by = 'migration-013'
 WHERE key LIKE 'smb.tnc.%';

UPDATE config
   SET value = '"machine_wins"',
       updated_at = unixepoch(),
       updated_by = 'migration-013'
 WHERE key = 'sync.conflictMode'
   AND value = '"tnc_wins"';
