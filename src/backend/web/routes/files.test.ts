import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Express } from 'express';
import request from 'supertest';
import { cleanupTmpDbs, tmpDb, tmpDir } from '../../../../tests/support/tmp-db';
import { ConfigManager } from '../../config/config-manager';
import { type Db } from '../../config/db';
import { runMigrations } from '../../config/migrations/runner';
import { generateSecretKey } from '../../config/secrets';
import { createShareCacheRootResolver } from '../../config/share-paths';
import { createBridgeMetrics } from '../../monitoring/registry';
import { JobRegistry } from '../../scheduling/jobs';
import { Scheduler } from '../../scheduling/scheduler';
import { ConflictResolver } from '../../locking/conflict-resolver';
import { LockManager } from '../../locking/lock-manager';
import { AuthLogWriter } from '../../logging/auth-log';
import { AuditLog, installAuditGuards } from '../../security/audit-log';
import { BlobStore } from '../../versioning/blob-store';
import { VersionStore } from '../../versioning/version-store';
import { createApp } from '../app';
import { attachmentFilename } from './files';
import { AuthManager } from '../auth';
import { type AppContext } from '../context';
import { EventBus } from '../event-bus';

/**
 * Preview and download hand a browser the contents of a file on the appliance's disk,
 * chosen by a row id. The path never comes from the client, and these tests are mostly
 * about the cases where that is not enough on its own: a row whose stored path points
 * out of the share, a row whose share is gone, a file that is not text.
 */

const PASSWORD = 'Sup3rGeheim!Passwort-2026';

let db: Db;
let app: Express;
let cacheRoot: string;
let shareId: number;

async function seedShare(): Promise<void> {
  cacheRoot = join(tmpDir('tnc-files-'), 'cache');
  await mkdir(cacheRoot, { recursive: true });
  const now = Math.floor(Date.now() / 1000);
  shareId = Number(
    db.run(
      `INSERT INTO shares (name, server_unc, mount_point, cache_path, created_at, updated_at)
       VALUES ('programs', '//fs/cnc$', '/mnt/tnc-server/programs', @cache, @now, @now)`,
      { now, cache: cacheRoot },
    ).lastInsertRowid,
  );
}

/** Indexes a path without writing it, for the rows that are supposed to fail. */
function index(relPath: string, options: { isDir?: boolean; share?: number } = {}): number {
  return Number(
    db.run(
      `INSERT INTO file_index (share_id, rel_path, rel_path_ci, is_dir, state, retry_count)
       VALUES (@share, @relPath, @ci, @isDir, 'synced', 0)`,
      {
        share: options.share ?? shareId,
        relPath,
        ci: relPath.toLowerCase(),
        isDir: options.isDir === true ? 1 : 0,
      },
    ).lastInsertRowid,
  );
}

async function indexFile(relPath: string, content: string | Buffer): Promise<number> {
  const absolute = join(cacheRoot, relPath);
  await mkdir(join(absolute, '..'), { recursive: true });
  await writeFile(absolute, content);
  return index(relPath);
}

beforeEach(async () => {
  db = tmpDb();
  runMigrations(db);
  installAuditGuards(db);

  const config = ConfigManager.create({ db, secretKey: generateSecretKey() });
  const ctx: AppContext = {
    db,
    config,
    auth: new AuthManager({ db, config, authLog: new AuthLogWriter(`${tmpDir()}/auth.log`) }),
    locks: new LockManager({ db, config }),
    conflicts: new ConflictResolver(db),
    events: new EventBus(),
    versions: new VersionStore({ db, blobs: new BlobStore({ root: `${tmpDir()}/versions` }) }),
    schedules: new Scheduler({ db, jobs: new JobRegistry() }),
    metrics: createBridgeMetrics(),
    audit: new AuditLog(db),
    shareCacheRoot: createShareCacheRootResolver(db),
    certDir: tmpDir(),
    version: '0.0.0-test',
    startedAt: Date.now(),
    now: () => Date.now(),
  };
  app = createApp(ctx);
  await seedShare();
});

afterEach(() => {
  cleanupTmpDbs();
});

async function loginAgent(): Promise<ReturnType<typeof request.agent>> {
  const agent = request.agent(app);
  await agent.post('/api/v1/setup/password').send({ password: PASSWORD }).expect(200);
  const login = await agent
    .post('/api/v1/auth/login')
    .send({ username: 'admin', password: PASSWORD })
    .expect(200);
  const csrf = (login.body as { data: { csrfToken: string } }).data.csrfToken;
  await agent.post('/api/v1/setup/complete').set('x-csrf-token', csrf).send({}).expect(200);
  return agent;
}

describe('GET /files/:id/preview', () => {
  it('requires credentials', async () => {
    const id = await indexFile('P.H', 'BEGIN PGM P MM');
    await request(app)
      .get(`/api/v1/files/${String(id)}/preview`)
      .expect(401);
  });

  it('returns the text of an indexed file', async () => {
    const id = await indexFile('P.H', 'BEGIN PGM P MM\nL X+0 Y+0\nEND PGM P MM');
    const agent = await loginAgent();

    const res = await agent.get(`/api/v1/files/${String(id)}/preview`).expect(200);

    expect(res.body.data.content).toContain('BEGIN PGM P MM');
    expect(res.body.data.truncated).toBe(false);
    expect(res.body.data.relPath).toBe('P.H');
  });

  it('truncates a large file and says so', async () => {
    // The flag is the point: showing the first page of a file as though it were the
    // whole file is worse than showing nothing.
    const id = await indexFile('BIG.H', 'L X+0\n'.repeat(20_000));
    const agent = await loginAgent();

    const res = await agent.get(`/api/v1/files/${String(id)}/preview`).expect(200);

    expect(res.body.data.truncated).toBe(true);
    expect(res.body.data.size).toBeGreaterThan(res.body.data.content.length);
  });

  it('refuses a binary file rather than rendering it as mojibake', async () => {
    const id = await indexFile('MODEL.STP', Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]));
    const agent = await loginAgent();

    const res = await agent.get(`/api/v1/files/${String(id)}/preview`).expect(415);

    expect(res.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('refuses a byte sequence that is not valid UTF-8 even without a NUL', async () => {
    const id = await indexFile('ODD.BIN', Buffer.from([0xc3, 0x28, 0xa0, 0xa1]));
    const agent = await loginAgent();

    await agent.get(`/api/v1/files/${String(id)}/preview`).expect(415);
  });

  it('refuses a stored path that climbs out of the share root', async () => {
    // The client cannot supply a path — but `rel_path` is a column, and a column is
    // something that can hold a value nobody meant to put there.
    const id = index('../../../../etc/passwd');
    const agent = await loginAgent();

    const res = await agent.get(`/api/v1/files/${String(id)}/preview`).expect(400);

    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('refuses an absolute stored path, which would otherwise ignore the root', async () => {
    const id = index('/etc/passwd');
    const agent = await loginAgent();

    await agent.get(`/api/v1/files/${String(id)}/preview`).expect(404);
  });

  it('refuses a directory', async () => {
    const id = index('PARTS', { isDir: true });
    const agent = await loginAgent();

    await agent.get(`/api/v1/files/${String(id)}/preview`).expect(400);
  });

  it('reports an indexed file that is not in the cache', async () => {
    const id = index('NOTPULLED.H');
    const agent = await loginAgent();

    const res = await agent.get(`/api/v1/files/${String(id)}/preview`).expect(404);

    expect(res.body.error.message).toMatch(/not in the local cache/);
  });

  it('has no rows left to serve once the share is destroyed', async () => {
    // The route guards against a share it cannot resolve, and this is why that guard is
    // only ever a backstop: `file_index.share_id` cascades, so destroying a share takes
    // its index rows with it and the id stops existing rather than dangling.
    const id = await indexFile('P.H', 'BEGIN PGM P MM');
    const agent = await loginAgent();
    await agent.get(`/api/v1/files/${String(id)}/preview`).expect(200);

    db.run('DELETE FROM shares WHERE id = @id', { id: shareId });

    await agent.get(`/api/v1/files/${String(id)}/preview`).expect(404);
  });

  it('rejects an id that is not one', async () => {
    const agent = await loginAgent();
    await agent.get('/api/v1/files/0/preview').expect(400);
  });
});

describe('GET /files/:id/download', () => {
  it('requires credentials', async () => {
    const id = await indexFile('P.H', 'BEGIN PGM P MM');
    await request(app)
      .get(`/api/v1/files/${String(id)}/download`)
      .expect(401);
  });

  it('returns the bytes as an attachment named after the file', async () => {
    const id = await indexFile('PARTS/001.H', 'BEGIN PGM 001 MM');
    const agent = await loginAgent();

    const res = await agent.get(`/api/v1/files/${String(id)}/download`).expect(200);

    expect(res.headers['content-disposition']).toContain('001.H');
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(Buffer.from(res.body as Buffer).toString()).toBe('BEGIN PGM 001 MM');
  });

  it('serves a binary file that preview refuses', async () => {
    // Download is the answer preview gives for anything it will not render.
    const bytes = Buffer.from([0x00, 0x01, 0x02, 0xff]);
    const id = await indexFile('MODEL.STP', bytes);
    const agent = await loginAgent();

    const res = await agent.get(`/api/v1/files/${String(id)}/download`).expect(200);

    expect(Buffer.from(res.body as Buffer).equals(bytes)).toBe(true);
  });

  it('refuses a stored path that climbs out of the share root', async () => {
    const id = index('../../../../etc/passwd');
    const agent = await loginAgent();

    await agent.get(`/api/v1/files/${String(id)}/download`).expect(400);
  });
});

describe('attachmentFilename', () => {
  it('keeps an ordinary name', () => {
    expect(attachmentFilename('PARTS/001.H')).toBe('001.H');
  });

  it('replaces a quote, which would close the header value', () => {
    expect(attachmentFilename('we"ird.H')).toBe('we_ird.H');
  });

  it('replaces CR and LF, which would end the header entirely', () => {
    // The injection that matters: everything after a CRLF is read as its own header.
    const injected = attachmentFilename('a\r\nSet-Cookie: session=stolen');
    expect(injected).not.toContain('\r');
    expect(injected).not.toContain('\n');
  });

  it('treats a backslash as a separator, so none can reach the header', () => {
    expect(attachmentFilename('PARTS\\001.H')).toBe('001.H');
  });

  it('falls back to a name when there is nothing left of one', () => {
    expect(attachmentFilename('PARTS/')).toBe('file');
  });
});
