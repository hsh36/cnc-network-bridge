import { copyFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { cleanupTmpDbs, tmpDb, tmpDir } from '../../../../tests/support/tmp-db';
import { ConfigManager } from '../config-manager';
import { type Db } from '../db';
import { generateSecretKey } from '../secrets';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from './runner';

/**
 * Changing a default does not reach an appliance that already stored the old one — the
 * Config Manager fills gaps with `INSERT OR IGNORE` and never overwrites. Without this
 * migration the bridge in the field would go on restoring deleted programs forever,
 * while every new install behaved the way the documentation describes.
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

function openConfig(): ConfigManager {
  return ConfigManager.create({ db, secretKey: generateSecretKey() });
}

function stored(): string | undefined {
  return db.pluck<string>("SELECT value FROM config WHERE key = 'sync.protectDeletes'");
}

beforeEach(() => {
  db = tmpDb();
});

afterEach(() => {
  cleanupTmpDbs();
});

it('carries an appliance that stored the old default over to propagating deletions', () => {
  migrateTo(9);
  openConfig();
  // The row as a bridge installed before this change holds it. It cannot be produced by
  // running today's code, which already writes the new default — which is the entire
  // reason the migration has to exist.
  db.run("UPDATE config SET value = 'true' WHERE key = 'sync.protectDeletes'");

  runMigrations(db);

  expect(stored()).toBe('false');
});

it('leaves a fresh install alone, because its default is already right', () => {
  runMigrations(db);
  expect(stored()).toBeUndefined();

  openConfig();
  expect(stored()).toBe('false');
});

it('does not reassert itself after an operator turns protection back on', () => {
  migrateTo(9);
  const config = openConfig();
  db.run("UPDATE config SET value = 'true' WHERE key = 'sync.protectDeletes'");
  runMigrations(db);
  expect(stored()).toBe('false');

  config.set('sync', { ...config.get('sync'), protectDeletes: true });
  runMigrations(db);

  expect(stored()).toBe('true');
});
