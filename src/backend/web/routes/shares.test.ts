import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { posix } from 'node:path';

import { type Express } from 'express';
import request from 'supertest';

import { cleanupTmpDbs, tmpDb, tmpDir } from '../../../../tests/support/tmp-db';
import { ConfigManager } from '../../config/config-manager';
import { type Db } from '../../config/db';
import { runMigrations } from '../../config/migrations/runner';
import { generateSecretKey } from '../../config/secrets';
import { createShareCacheRootResolver } from '../../config/share-paths';
import { ConflictResolver } from '../../locking/conflict-resolver';
import { LockManager } from '../../locking/lock-manager';
import { createBridgeMetrics } from '../../monitoring/registry';
import { JobRegistry } from '../../scheduling/jobs';
import { Scheduler } from '../../scheduling/scheduler';
import { AuditLog, installAuditGuards } from '../../security/audit-log';
import { ShareStore } from '../../sync/share-store';
import { BlobStore } from '../../versioning/blob-store';
import { VersionStore } from '../../versioning/version-store';
import { type PrivilegedRequest } from '../../privileged/verbs';
import { SambaConfigManager } from '../../smb/samba-config-manager';
import { createApp } from '../app';
import { purgeShareCache } from './shares';
import { AuthLogWriter } from '../../logging/auth-log';
import { AuthManager } from '../auth';
import { type AppContext } from '../context';
import { EventBus } from '../event-bus';

const PASSWORD = 'Sup3rGeheim!Passwort-2026';

let db: Db;
let app: Express;
let ctx: AppContext;

function buildContext(): AppContext {
  const config = ConfigManager.create({ db, secretKey: generateSecretKey() });
  installAuditGuards(db);
  return {
    db,
    config,
    // Without an explicit writer this reaches for /var/log/smb-bridge, which the
    // constructor creates eagerly — fine as root, EACCES on a CI runner.
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
    startedAt: Date.now() - 1000,
    now: () => Date.now(),
  };
}

async function loginAgent(): Promise<{ agent: ReturnType<typeof request.agent>; csrf: string }> {
  const agent = request.agent(app);
  await agent.post('/api/v1/setup/password').send({ password: PASSWORD }).expect(200);
  const login = await agent
    .post('/api/v1/auth/login')
    .send({ username: 'admin', password: PASSWORD })
    .expect(200);
  const csrf = (login.body as { data: { csrfToken: string } }).data.csrfToken;
  await agent.post('/api/v1/setup/complete').set('x-csrf-token', csrf).send({}).expect(200);
  return { agent, csrf };
}

const VALID_SHARE = { name: 'programs', serverUnc: '//fileserver/cnc$/programs' };

beforeEach(() => {
  db = tmpDb();
  runMigrations(db);
  ctx = buildContext();
  app = createApp(ctx);
});

afterEach(() => {
  cleanupTmpDbs();
});

describe('POST /shares', () => {
  it('creates a share and derives its paths from the name', async () => {
    const { agent, csrf } = await loginAgent();

    const res = await agent
      .post('/api/v1/shares')
      .set('x-csrf-token', csrf)
      .send(VALID_SHARE)
      .expect(201);

    // Letting a client choose these would hand it the mount and cache namespaces.
    expect(res.body.data).toMatchObject({
      name: 'programs',
      mountPoint: '/mnt/smb-server/programs',
      cachePath: '/srv/smb-bridge/programs',
      enabled: true,
      smbVersion: '3.1.1',
    });
  });

  it('ignores a client-supplied mount point', async () => {
    const { agent, csrf } = await loginAgent();

    const res = await agent
      .post('/api/v1/shares')
      .set('x-csrf-token', csrf)
      .send({ ...VALID_SHARE, mountPoint: '/etc' });

    // `.strict()` on the request schema: an unknown field is a rejection, not a
    // silently dropped one, so a caller cannot believe it set something it did not.
    expect(res.status).toBe(400);
  });

  it('refuses a duplicate name with 409 rather than a constraint error', async () => {
    const { agent, csrf } = await loginAgent();
    await agent.post('/api/v1/shares').set('x-csrf-token', csrf).send(VALID_SHARE).expect(201);

    const res = await agent.post('/api/v1/shares').set('x-csrf-token', csrf).send(VALID_SHARE);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it.each(['../escape', 'has space', 'semi;colon'])('rejects the unsafe name %p', async (name) => {
    const { agent, csrf } = await loginAgent();
    const res = await agent
      .post('/api/v1/shares')
      .set('x-csrf-token', csrf)
      .send({ ...VALID_SHARE, name });
    expect(res.status).toBe(400);
  });

  it('needs the CSRF header', async () => {
    const { agent } = await loginAgent();
    expect((await agent.post('/api/v1/shares').send(VALID_SHARE)).status).toBe(403);
  });
});

describe('GET /shares', () => {
  it('needs credentials', async () => {
    expect((await request(app).get('/api/v1/shares')).status).toBe(401);
  });

  it('lists shares with their live counts', async () => {
    const { agent, csrf } = await loginAgent();
    await agent.post('/api/v1/shares').set('x-csrf-token', csrf).send(VALID_SHARE).expect(201);

    const res = await agent.get('/api/v1/shares').expect(200);

    expect(res.body.data.total).toBe(1);
    expect(res.body.data.items[0]).toMatchObject({
      name: 'programs',
      filesIndexed: 0,
      activeLocks: 0,
      effectiveReadOnly: false,
    });
  });

  it('answers 404 for a share that does not exist', async () => {
    const { agent } = await loginAgent();
    expect((await agent.get('/api/v1/shares/999')).status).toBe(404);
  });
});

describe('PATCH /shares/:id', () => {
  it('applies only the fields that were sent', async () => {
    const { agent, csrf } = await loginAgent();
    const created = await agent
      .post('/api/v1/shares')
      .set('x-csrf-token', csrf)
      .send(VALID_SHARE)
      .expect(201);
    const id = created.body.data.id as number;

    const res = await agent
      .patch(`/api/v1/shares/${String(id)}`)
      .set('x-csrf-token', csrf)
      .send({ readOnly: true, conflictMode: 'machine_wins' })
      .expect(200);

    expect(res.body.data).toMatchObject({
      readOnly: true,
      conflictMode: 'machine_wins',
      // Untouched fields keep their values rather than reverting to defaults.
      serverUnc: '//fileserver/cnc$/programs',
      smbVersion: '3.1.1',
    });
  });

  it('refuses to rename, because the name owns the paths', async () => {
    const { agent, csrf } = await loginAgent();
    const created = await agent
      .post('/api/v1/shares')
      .set('x-csrf-token', csrf)
      .send(VALID_SHARE)
      .expect(201);

    const res = await agent
      .patch(`/api/v1/shares/${String(created.body.data.id as number)}`)
      .set('x-csrf-token', csrf)
      .send({ name: 'renamed' });

    expect(res.status).toBe(400);
  });
});

describe('per-share SMB credentials', () => {
  it('stores the password encrypted, never in plaintext', async () => {
    const { agent, csrf } = await loginAgent();

    const created = await agent
      .post('/api/v1/shares')
      .set('x-csrf-token', csrf)
      .send({ ...VALID_SHARE, smbUser: 'svc-tnc', smbPassword: 'ein-geheimes-Kennwort' })
      .expect(201);
    const id = created.body.data.id as number;

    const stored = db.pluck<string>('SELECT smb_password FROM shares WHERE id = @id', { id });
    expect(stored).toBeDefined();
    expect(stored).not.toContain('ein-geheimes-Kennwort');
    expect(stored?.startsWith('v1:')).toBe(true);

    const store = new ShareStore({ db, config: ctx.config });
    expect(store.password(id)).toBe('ein-geheimes-Kennwort');
  });

  it('never returns the password over the API', async () => {
    const { agent, csrf } = await loginAgent();
    const created = await agent
      .post('/api/v1/shares')
      .set('x-csrf-token', csrf)
      .send({ ...VALID_SHARE, smbPassword: 'ein-geheimes-Kennwort' })
      .expect(201);

    expect(JSON.stringify(created.body)).not.toContain('ein-geheimes-Kennwort');
    const fetched = await agent
      .get(`/api/v1/shares/${String(created.body.data.id as number)}`)
      .expect(200);
    expect(JSON.stringify(fetched.body)).not.toContain('ein-geheimes-Kennwort');
  });

  it('leaves the stored password alone when a PATCH omits it', async () => {
    const { agent, csrf } = await loginAgent();
    const created = await agent
      .post('/api/v1/shares')
      .set('x-csrf-token', csrf)
      .send({ ...VALID_SHARE, smbPassword: 'ein-geheimes-Kennwort' })
      .expect(201);
    const id = created.body.data.id as number;

    await agent
      .patch(`/api/v1/shares/${String(id)}`)
      .set('x-csrf-token', csrf)
      .send({ smbUser: 'svc-other' })
      .expect(200);

    // Round-tripping a share through the UI must not silently wipe its credentials.
    expect(new ShareStore({ db, config: ctx.config }).password(id)).toBe('ein-geheimes-Kennwort');
  });

  it('clears the password on an explicit empty string', async () => {
    const { agent, csrf } = await loginAgent();
    const created = await agent
      .post('/api/v1/shares')
      .set('x-csrf-token', csrf)
      .send({ ...VALID_SHARE, smbPassword: 'ein-geheimes-Kennwort' })
      .expect(201);
    const id = created.body.data.id as number;

    await agent
      .patch(`/api/v1/shares/${String(id)}`)
      .set('x-csrf-token', csrf)
      .send({ smbPassword: '' })
      .expect(200);

    // undefined means "fall back to the global service account".
    expect(new ShareStore({ db, config: ctx.config }).password(id)).toBeUndefined();
  });
});

describe('DELETE /shares/:id', () => {
  async function createShare(): Promise<{
    agent: ReturnType<typeof request.agent>;
    csrf: string;
    id: number;
  }> {
    const { agent, csrf } = await loginAgent();
    const created = await agent
      .post('/api/v1/shares')
      .set('x-csrf-token', csrf)
      .send(VALID_SHARE)
      .expect(201);
    return { agent, csrf, id: created.body.data.id as number };
  }

  it('removes the share', async () => {
    const { agent, csrf, id } = await createShare();

    await agent
      .delete(`/api/v1/shares/${String(id)}`)
      .set('x-csrf-token', csrf)
      .expect(200);

    expect((await agent.get(`/api/v1/shares/${String(id)}`)).status).toBe(404);
  });

  it('drops the Samba account the share owned', async () => {
    // Reconciliation cannot do this one — it walks the shares that still exist — so a
    // delete that forgot to ask would leave `tnc-programs` resolving forever, and a
    // share recreated under that name would inherit the old password.
    const calls: PrivilegedRequest[] = [];
    ctx = {
      ...buildContext(),
      samba: new SambaConfigManager({
        db,
        config: ctx.config,
        invoke: (request: PrivilegedRequest) => {
          calls.push(request);
          return { ok: true, verb: request.verb, commands: [], detail: {} };
        },
      }),
    };
    app = createApp(ctx);

    const { agent, csrf, id } = await createShare();
    calls.length = 0;

    await agent
      .delete(`/api/v1/shares/${String(id)}`)
      .set('x-csrf-token', csrf)
      .expect(200);

    expect(calls).toContainEqual(
      expect.objectContaining({
        verb: 'set-samba-user',
        username: 'tnc-programs',
        remove: true,
      }),
    );
  });

  it('records in the audit trail whether the cache was kept', async () => {
    const { agent, csrf, id } = await createShare();

    await agent
      .delete(`/api/v1/shares/${String(id)}`)
      .set('x-csrf-token', csrf)
      .expect(200);

    const entry = db.get<{ action: string; detail: string | null }>(
      "SELECT action, detail FROM audit_log WHERE action = 'shares.delete' ORDER BY id DESC LIMIT 1",
    );
    // The default is to keep the files, and the record has to say so: the same share
    // name recreated later adopts the same directory.
    expect(entry?.detail).toBe('cache kept');
  });

  it('records the purge when one was asked for', async () => {
    const { agent, csrf, id } = await createShare();

    await agent
      .delete(`/api/v1/shares/${String(id)}?purgeCache=true`)
      .set('x-csrf-token', csrf)
      .expect(200);

    const entry = db.get<{ detail: string | null }>(
      "SELECT detail FROM audit_log WHERE action = 'shares.delete' ORDER BY id DESC LIMIT 1",
    );
    expect(entry?.detail).toBe('purged /srv/smb-bridge/programs');
  });

  it('reads purgeCache=false as false rather than as a non-empty string', async () => {
    const { agent, csrf, id } = await createShare();

    await agent
      .delete(`/api/v1/shares/${String(id)}?purgeCache=false`)
      .set('x-csrf-token', csrf)
      .expect(200);

    const entry = db.get<{ detail: string | null }>(
      "SELECT detail FROM audit_log WHERE action = 'shares.delete' ORDER BY id DESC LIMIT 1",
    );
    expect(entry?.detail).toBe('cache kept');
  });
});

// `posix.join`, not `join`: the paths the helper compares are appliance paths, and on a
// Windows developer machine `join` would build a backslash path the check rightly
// refuses. Node itself is happy to create either.
describe('purgeShareCache', () => {
  it('removes the directory the share owns', async () => {
    const root = tmpDir();
    const cache = posix.join(root, 'programs');
    mkdirSync(posix.join(cache, 'sub'), { recursive: true });
    writeFileSync(posix.join(cache, 'sub', 'part.h'), 'BEGIN PGM');

    await expect(purgeShareCache(cache, 'programs', root)).resolves.toBe(true);
    expect(existsSync(cache)).toBe(false);
  });

  it('refuses a path that is not the one the share owns', async () => {
    // A recursive remove driven by a database column: the name has to agree with the
    // path, or a row edited by hand becomes an arbitrary `rm -rf`.
    const root = tmpDir();
    const elsewhere = posix.join(root, 'not-this-one');
    mkdirSync(elsewhere, { recursive: true });

    await expect(purgeShareCache(elsewhere, 'programs', root)).resolves.toBe(false);
    expect(existsSync(elsewhere)).toBe(true);
  });

  it('succeeds when the directory was never created', async () => {
    // A share deleted before its first sync has no cache directory, and that is not an
    // error the operator needs to hear about.
    const root = tmpDir();
    await expect(purgeShareCache(posix.join(root, 'programs'), 'programs', root)).resolves.toBe(
      true,
    );
  });
});

describe('POST /shares/:id/:action', () => {
  it('says the sync engine is not running rather than pretending to queue work', async () => {
    const { agent, csrf } = await loginAgent();
    const created = await agent
      .post('/api/v1/shares')
      .set('x-csrf-token', csrf)
      .send(VALID_SHARE)
      .expect(201);

    const res = await agent
      .post(`/api/v1/shares/${String(created.body.data.id as number)}/scan`)
      .set('x-csrf-token', csrf);

    // A 200 with {accepted: true} would leave the UI waiting on an event stream that
    // will never carry a result.
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('still reports an unknown share as 404, not 503', async () => {
    const { agent, csrf } = await loginAgent();
    const res = await agent.post('/api/v1/shares/999/scan').set('x-csrf-token', csrf);
    expect(res.status).toBe(404);
  });

  it('rejects an action that is not in the enum', async () => {
    const { agent, csrf } = await loginAgent();
    const created = await agent
      .post('/api/v1/shares')
      .set('x-csrf-token', csrf)
      .send(VALID_SHARE)
      .expect(201);

    const res = await agent
      .post(`/api/v1/shares/${String(created.body.data.id as number)}/destroy`)
      .set('x-csrf-token', csrf);

    expect(res.status).toBe(400);
  });
});

describe('TNC-side credentials survive a save', () => {
  /** Creates a share and returns its id. */
  async function makeShare(
    agent: ReturnType<typeof request.agent>,
    csrf: string,
    body: Record<string, unknown>,
  ): Promise<number> {
    const res = await agent
      .post('/api/v1/shares')
      .set('x-csrf-token', csrf)
      .send({ name: 'werkstatt', serverUnc: '//server/cnc', ...body })
      .expect(201);
    return (res.body as { data: { id: number } }).data.id;
  }

  it('keeps the user set at creation', async () => {
    const { agent, csrf } = await loginAgent();
    const id = await makeShare(agent, csrf, { machineGuestOk: false, machineUser: 'cnc' });

    const res = await agent.get(`/api/v1/shares/${String(id)}`).expect(200);
    expect((res.body as { data: { machineUser: string | null } }).data.machineUser).toBe('cnc');
  });

  it('keeps a user set by editing an existing share', async () => {
    // The reported bug: the settings dialog saved, closed, and on reopening the user
    // field was empty again. The column, the schema and the create path all carried it;
    // the UPDATE statement simply had no assignment for it, so every edit dropped it
    // silently and reported success.
    const { agent, csrf } = await loginAgent();
    const id = await makeShare(agent, csrf, { machineGuestOk: true });

    await agent
      .patch(`/api/v1/shares/${String(id)}`)
      .set('x-csrf-token', csrf)
      .send({ machineGuestOk: false, machineUser: 'cnc', machinePassword: 'geheim' })
      .expect(200);

    const res = await agent.get(`/api/v1/shares/${String(id)}`).expect(200);
    expect((res.body as { data: { machineUser: string | null } }).data.machineUser).toBe('cnc');
  });

  it('lets the user be cleared again', async () => {
    const { agent, csrf } = await loginAgent();
    const id = await makeShare(agent, csrf, { machineGuestOk: false, machineUser: 'cnc' });

    await agent
      .patch(`/api/v1/shares/${String(id)}`)
      .set('x-csrf-token', csrf)
      .send({ machineGuestOk: true, machineUser: null })
      .expect(200);

    const res = await agent.get(`/api/v1/shares/${String(id)}`).expect(200);
    expect((res.body as { data: { machineUser: string | null } }).data.machineUser).toBeNull();
  });

  it('never returns the TNC password', async () => {
    // It is a credential a machine authenticates with; the dialog only ever needs to
    // know whether one is stored, never what it is.
    const { agent, csrf } = await loginAgent();
    const id = await makeShare(agent, csrf, {
      machineGuestOk: false,
      machineUser: 'cnc',
      machinePassword: 'geheim',
    });

    const res = await agent.get(`/api/v1/shares/${String(id)}`).expect(200);
    expect(JSON.stringify(res.body)).not.toContain('geheim');
  });
});
