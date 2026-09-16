import { copyFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { cleanupTmpDbs, tmpDb, tmpDir } from '../../../../tests/support/tmp-db';
import { ConfigManager } from '../config-manager';
import { type Db } from '../db';
import { generateSecretKey } from '../secrets';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from './runner';

/**
 * A stored mode is a string the schema no longer accepts, so an unmigrated device would
 * fail to load its own network section — the one an operator needs in order to fix it.
 */

let db: Db;

function migrateTo(version: number): void {
  const staged = tmpDir('tnc-migrations-');
  for (const file of readdirSync(DEFAULT_MIGRATIONS_DIR)) {
    const match = /^(\d{3,})_.*\.sql$/.exec(file);
    if (match !== null && Number(match[1]) <= version) {
      copyFileSync(join(DEFAULT_MIGRATIONS_DIR, file), join(staged, file));
    }
  }
  runMigrations(db, { directory: staged });
}

function mode(): string | undefined {
  return db.pluck<string>("SELECT value FROM config WHERE key = 'network.mode'");
}

function setMode(value: string): void {
  db.run(`UPDATE config SET value = '"${value}"' WHERE key = 'network.mode'`);
}

beforeEach(() => {
  db = tmpDb();
});

afterEach(() => {
  cleanupTmpDbs();
});

it('renames the two-NIC server arrangement', () => {
  migrateTo(11);
  ConfigManager.create({ db, secretKey: generateSecretKey() });
  setMode('dual-nic-server');

  runMigrations(db);

  expect(mode()).toBe('"existing-network"');
});

it('renames the one-control arrangement', () => {
  migrateTo(11);
  ConfigManager.create({ db, secretKey: generateSecretKey() });
  setMode('dual-nic-bridge');

  runMigrations(db);

  expect(mode()).toBe('"single-machine"');
});

it('lands a trunked device on the default rather than on a mode that no longer exists', () => {
  migrateTo(11);
  ConfigManager.create({ db, secretKey: generateSecretKey() });
  setMode('vlan-trunk');

  runMigrations(db);

  expect(mode()).toBe('"existing-network"');
});

it('drops the VLAN tags, so no row survives for a key the schema has no name for', () => {
  migrateTo(11);
  ConfigManager.create({ db, secretKey: generateSecretKey() });
  db.run(
    "INSERT OR REPLACE INTO config (key, value, updated_at, updated_by) VALUES ('network.lan.vlan', '10', unixepoch(), 'test')",
  );
  db.run(
    "INSERT OR REPLACE INTO config (key, value, updated_at, updated_by) VALUES ('network.tnc.vlan', '20', unixepoch(), 'test')",
  );

  runMigrations(db);

  expect(db.pluck<number>("SELECT COUNT(*) FROM config WHERE key LIKE 'network.%.vlan'")).toBe(0);
});

it('leaves a migrated config loadable, which is the point of all of the above', () => {
  migrateTo(11);
  ConfigManager.create({ db, secretKey: generateSecretKey() });
  setMode('vlan-trunk');

  runMigrations(db);
  const config = ConfigManager.create({ db, secretKey: generateSecretKey() });

  expect(config.get('network').mode).toBe('existing-network');
});
