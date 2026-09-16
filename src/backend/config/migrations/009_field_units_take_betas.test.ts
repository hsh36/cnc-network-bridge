import { copyFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { cleanupTmpDbs, tmpDb, tmpDir } from '../../../../tests/support/tmp-db';
import { ConfigManager } from '../config-manager';
import { type Db } from '../db';
import { generateSecretKey } from '../secrets';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from './runner';

/**
 * The migration has to tell two databases apart that look almost identical: an
 * appliance that has been running for weeks, and one being installed right now. Get it
 * wrong in one direction and the unit in the field never receives another update; get
 * it wrong in the other and every new appliance ships subscribed to pre-releases,
 * which is the opposite of what a default should promise.
 */

let db: Db;

/** Brings the database to the schema version an upgrade would find, and no further. */
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

function channel(): string | undefined {
  return db.pluck<string>("SELECT value FROM config WHERE key = 'updates.channel'");
}

beforeEach(() => {
  db = tmpDb();
});

afterEach(() => {
  cleanupTmpDbs();
});

it('moves an appliance that is already in service onto the beta channel', () => {
  // A unit in the field: migrated, started at least once so the defaults exist, and
  // taken through the setup wizard.
  migrateTo(8);
  openConfig();
  db.run("UPDATE config SET value = 'true' WHERE key = 'setup.completed'");

  runMigrations(db);

  expect(channel()).toBe('"beta"');
});

it('leaves a fresh install on stable, because that is what a new appliance promises', () => {
  // Nothing has started yet: migrations run before the Config Manager writes any
  // default, so there is no channel row at all to move.
  runMigrations(db);
  expect(channel()).toBeUndefined();

  openConfig();
  expect(channel()).toBe('"stable"');
});

it('leaves an installed-but-unconfigured appliance on stable', () => {
  // Defaults exist because the service has started, but nobody has completed setup —
  // this is a box being prepared, not one in service.
  migrateTo(8);
  openConfig();

  runMigrations(db);

  expect(channel()).toBe('"stable"');
});

it('runs once, so a later restart does not undo a switch back to stable', () => {
  migrateTo(8);
  const config = openConfig();
  db.run("UPDATE config SET value = 'true' WHERE key = 'setup.completed'");

  runMigrations(db);
  expect(channel()).toBe('"beta"');

  config.set('updates', { ...config.get('updates'), channel: 'stable' });
  runMigrations(db);

  expect(channel()).toBe('"stable"');
});
