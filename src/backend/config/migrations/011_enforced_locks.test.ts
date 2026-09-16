import { copyFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { cleanupTmpDbs, tmpDb, tmpDir } from '../../../../tests/support/tmp-db';
import { ConfigManager } from '../config-manager';
import { type Db } from '../db';
import { generateSecretKey } from '../secrets';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from './runner';

/**
 * The appliance in the field stored `sidecar`, which protects nothing: the marker is a
 * convention, and a tool that does not know it writes straight through. Changing the
 * default alone would leave that bridge advisory for ever, since defaults are only ever
 * written into gaps.
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

function projection(): string | undefined {
  return db.pluck<string>("SELECT value FROM config WHERE key = 'locking.serverProjection'");
}

beforeEach(() => {
  db = tmpDb();
});

afterEach(() => {
  cleanupTmpDbs();
});

it('moves an appliance from the advisory marker to a lock the server enforces', () => {
  migrateTo(10);
  ConfigManager.create({ db, secretKey: generateSecretKey() });
  db.run("UPDATE config SET value = '\"sidecar\"' WHERE key = 'locking.serverProjection'");

  runMigrations(db);

  expect(projection()).toBe('"byte_range"');
});

it('leaves a fresh install on the new default without help', () => {
  runMigrations(db);
  ConfigManager.create({ db, secretKey: generateSecretKey() });

  expect(projection()).toBe('"byte_range"');
});

it('does not overrule an operator who turned projection off', () => {
  // `none` is a deliberate answer — a share whose server refuses locks outright, say.
  // Silently switching it back on would be this migration inventing a policy.
  migrateTo(10);
  ConfigManager.create({ db, secretKey: generateSecretKey() });
  db.run("UPDATE config SET value = '\"none\"' WHERE key = 'locking.serverProjection'");

  runMigrations(db);

  expect(projection()).toBe('"none"');
});
