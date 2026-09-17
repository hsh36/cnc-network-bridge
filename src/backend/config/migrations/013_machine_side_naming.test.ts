import { copyFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { cleanupTmpDbs, tmpDb, tmpDir } from '../../../../tests/support/tmp-db';
import { ConfigManager } from '../config-manager';
import { type Db } from '../db';
import { generateSecretKey } from '../secrets';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from './runner';

/**
 * The rename reaches into the schema: two CHECK constraints hold values that no longer
 * exist, four columns and one table are named after a control family the product is no
 * longer named after. SQLite cannot alter a CHECK in place, so four tables are rebuilt —
 * and a rebuild is where rows get lost, references break, or an id quietly changes.
 * These tests put data in first and check it is all still there afterwards.
 */

let db: Db;

function migrateTo(version: number): void {
  const staged = tmpDir('smb-migrations-');
  for (const file of readdirSync(DEFAULT_MIGRATIONS_DIR)) {
    const match = /^(\d{3,})_.*\.sql$/.exec(file);
    if (match !== null && Number(match[1]) <= version) {
      copyFileSync(join(DEFAULT_MIGRATIONS_DIR, file), join(staged, file));
    }
  }
  runMigrations(db, { directory: staged });
}

/** A share, a lock, a version and a conflict, all carrying the old spellings. */
function seedLegacyRows(): { shareId: number; versionId: number } {
  const shareId = Number(
    db.run(
      `INSERT INTO shares (name, server_unc, mount_point, cache_path, conflict_mode,
                           tnc_guest_ok, tnc_user, tnc_password, created_at, updated_at)
       VALUES ('programs', '//fs/cnc$', '/mnt/tnc-server/programs', '/srv/tnc/programs',
               'tnc_wins', 0, 'tnc-test', 'secret', 100, 100)`,
    ).lastInsertRowid,
  );

  db.run(
    `INSERT INTO locks (share_id, rel_path, origin, owner_label, tnc_ip, acquired_at)
     VALUES (@shareId, '11.H', 'tnc', 'TNC-640-Halle2', '192.168.42.2', 200)`,
    { shareId },
  );

  const versionId = Number(
    db.run(
      `INSERT INTO file_versions (share_id, rel_path, hash, size, mtime, origin, created_at)
       VALUES (@shareId, '11.H', 'abc', 1140, 300, 'tnc', 300)`,
      { shareId },
    ).lastInsertRowid,
  );

  db.run(
    `INSERT INTO conflicts (ts, share_id, rel_path, mode_applied, winner, loser_version_id)
     VALUES (400, @shareId, '11.H', 'tnc_wins', 'local', @versionId)`,
    { shareId, versionId },
  );

  return { shareId, versionId };
}

beforeEach(() => {
  db = tmpDb();
});

afterEach(() => {
  cleanupTmpDbs();
});

describe('columns and table names', () => {
  it('renames the share columns and keeps what was in them', () => {
    migrateTo(12);
    const { shareId } = seedLegacyRows();

    runMigrations(db);

    const share = db.get<{
      machine_user: string;
      machine_password: string;
      machine_guest_ok: number;
    }>('SELECT machine_user, machine_password, machine_guest_ok FROM shares WHERE id = @id', {
      id: shareId,
    });
    expect(share?.machine_user).toBe('tnc-test');
    expect(share?.machine_password).toBe('secret');
    expect(share?.machine_guest_ok).toBe(0);
  });

  it('renames the client table and its unique index', () => {
    migrateTo(12);
    db.run("INSERT INTO tnc_clients (name, mac_address) VALUES ('Halle 2', 'aa:bb:cc:dd:ee:ff')");

    runMigrations(db);

    expect(db.pluck<number>("SELECT count(*) FROM sqlite_master WHERE name = 'tnc_clients'")).toBe(
      0,
    );
    expect(db.pluck<string>('SELECT name FROM machine_clients')).toBe('Halle 2');
    // The index is what stops two reservations claiming one MAC, so losing it in the
    // rename would be a silent loss of a constraint rather than a visible error.
    expect(() =>
      db.run("INSERT INTO machine_clients (name, mac_address) VALUES ('x', 'aa:bb:cc:dd:ee:ff')"),
    ).toThrow();
  });
});

describe('stored values inside CHECK constraints', () => {
  it('moves tnc_wins to machine_wins on the share', () => {
    migrateTo(12);
    const { shareId } = seedLegacyRows();

    runMigrations(db);

    expect(
      db.pluck<string>('SELECT conflict_mode FROM shares WHERE id = @id', { id: shareId }),
    ).toBe('machine_wins');
  });

  it('moves the lock origin and keeps the rest of the row', () => {
    migrateTo(12);
    seedLegacyRows();

    runMigrations(db);

    const lock = db.get<{ origin: string; machine_ip: string; owner_label: string }>(
      'SELECT origin, machine_ip, owner_label FROM locks',
    );
    expect(lock?.origin).toBe('machine');
    expect(lock?.machine_ip).toBe('192.168.42.2');
    expect(lock?.owner_label).toBe('TNC-640-Halle2');
  });

  it('moves the version origin', () => {
    migrateTo(12);
    seedLegacyRows();

    runMigrations(db);

    expect(db.pluck<string>('SELECT origin FROM file_versions')).toBe('machine');
  });

  it('moves the conflict mode and keeps its reference to the losing version', () => {
    // `conflicts.loser_version_id` points at a table this migration rebuilds. A rebuild
    // that let the reference drop would take the recoverable copy with it.
    migrateTo(12);
    const { versionId } = seedLegacyRows();

    runMigrations(db);

    const conflict = db.get<{ mode_applied: string; loser_version_id: number }>(
      'SELECT mode_applied, loser_version_id FROM conflicts',
    );
    expect(conflict?.mode_applied).toBe('machine_wins');
    expect(conflict?.loser_version_id).toBe(versionId);
  });

  it('leaves the other enum values alone', () => {
    migrateTo(12);
    const shareId = Number(
      db.run(
        `INSERT INTO shares (name, server_unc, mount_point, cache_path, conflict_mode,
                             created_at, updated_at)
         VALUES ('tools', '//fs/t', '/mnt/t', '/srv/t', 'server_wins', 1, 1)`,
      ).lastInsertRowid,
    );
    db.run(
      `INSERT INTO locks (share_id, rel_path, origin, acquired_at)
       VALUES (@shareId, 'a.H', 'manual', 1)`,
      { shareId },
    );

    runMigrations(db);

    expect(db.pluck<string>('SELECT conflict_mode FROM shares')).toBe('server_wins');
    expect(db.pluck<string>('SELECT origin FROM locks')).toBe('manual');
  });
});

describe('the rebuild itself', () => {
  it('keeps the cascade from a share to its locks', () => {
    // Rebuilding four tables is where a foreign key silently stops being enforced.
    migrateTo(12);
    const { shareId } = seedLegacyRows();
    runMigrations(db);

    db.run('DELETE FROM shares WHERE id = @id', { id: shareId });

    expect(db.pluck<number>('SELECT count(*) FROM locks')).toBe(0);
    expect(db.pluck<number>('SELECT count(*) FROM file_versions')).toBe(0);
  });

  it('still refuses a value the constraint never allowed', () => {
    migrateTo(12);
    runMigrations(db);

    expect(() =>
      db.run(
        `INSERT INTO shares (name, server_unc, mount_point, cache_path, conflict_mode,
                             created_at, updated_at)
         VALUES ('x', '//fs/x', '/mnt/x', '/srv/x', 'nonsense', 1, 1)`,
      ),
    ).toThrow();
  });

  it('leaves a migrated database loadable, which is the point of all of the above', () => {
    migrateTo(12);
    seedLegacyRows();

    runMigrations(db);
    const config = ConfigManager.create({ db, secretKey: generateSecretKey() });

    expect(config.get('network').machine.interface).toBe('eth1');
  });
});

describe('stored configuration keys', () => {
  it('moves the network and smb section keys', () => {
    migrateTo(12);
    ConfigManager.create({ db, secretKey: generateSecretKey() });
    db.run(
      `INSERT OR REPLACE INTO config (key, value, is_secret, updated_at, updated_by)
       VALUES ('network.tnc.interface', '"eth9"', 0, 1, 'test')`,
    );
    db.run(
      `INSERT OR REPLACE INTO config (key, value, is_secret, updated_at, updated_by)
       VALUES ('smb.tnc.workgroup', '"SHOPFLOOR"', 0, 1, 'test')`,
    );

    runMigrations(db);

    expect(
      db.pluck<string>("SELECT value FROM config WHERE key = 'network.machine.interface'"),
    ).toBe('"eth9"');
    expect(db.pluck<string>("SELECT value FROM config WHERE key = 'smb.machine.workgroup'")).toBe(
      '"SHOPFLOOR"',
    );
    expect(db.pluck<number>("SELECT count(*) FROM config WHERE key LIKE '%.tnc.%'")).toBe(0);
  });
});
