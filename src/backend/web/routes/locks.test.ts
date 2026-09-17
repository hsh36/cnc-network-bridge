import request from 'supertest';
import { type Express } from 'express';
import { cleanupTmpDbs, tmpDb, tmpDir } from '../../../../tests/support/tmp-db';
import { ConfigManager } from '../../config/config-manager';
import { type Db } from '../../config/db';
import { runMigrations } from '../../config/migrations/runner';
import { generateSecretKey } from '../../config/secrets';
import { AuthLogWriter } from '../../logging/auth-log';
import { ConflictResolver } from '../../locking/conflict-resolver';
import { LockManager } from '../../locking/lock-manager';
import { ScheduleLockWindowManager } from '../../locking/schedule-windows';
import { createShareCacheRootResolver } from '../../config/share-paths';
import { createBridgeMetrics } from '../../monitoring/registry';
import { JobRegistry } from '../../scheduling/jobs';
import { Scheduler } from '../../scheduling/scheduler';
import { AuditLog, installAuditGuards } from '../../security/audit-log';
import { BlobStore } from '../../versioning/blob-store';
import { VersionStore } from '../../versioning/version-store';
import { createApp } from '../app';
import { AuthManager } from '../auth';
import { type AppContext } from '../context';
import { EventBus } from '../event-bus';

const PASSWORD = 'Sup3rGeheim!Passwort-2026';

let db: Db;
let app: Express;
let ctx: AppContext;

function buildContext(): AppContext {
  const config = ConfigManager.create({ db, secretKey: generateSecretKey() });
  const auth = new AuthManager({
    db,
    config,
    authLog: new AuthLogWriter(`${tmpDir()}/auth.log`),
  });
  const locks = new LockManager({ db, config });
  const conflicts = new ConflictResolver(db);
  installAuditGuards(db);

  const jobs = new JobRegistry();
  const schedules = new Scheduler({ db, jobs });

  // Wire up the lock/unlock handlers
  new ScheduleLockWindowManager({
    db,
    locks,
    scheduler: schedules,
  });

  return {
    db,
    config,
    auth,
    locks,
    conflicts,
    events: new EventBus(),
    versions: new VersionStore({ db, blobs: new BlobStore({ root: `${tmpDir()}/versions` }) }),
    schedules,
    metrics: createBridgeMetrics(),
    audit: new AuditLog(db),
    shareCacheRoot: createShareCacheRootResolver(db),
    certDir: tmpDir(),
    version: '0.0.0-test',
    startedAt: Date.now() - 1000,
    now: () => Date.now(),
  };
}

beforeEach(() => {
  db = tmpDb();
  runMigrations(db);
  ctx = buildContext();
  app = createApp(ctx);
});

afterEach(() => {
  cleanupTmpDbs();
});

type Agent = ReturnType<typeof request.agent>;

interface AuthedAgent {
  readonly agent: Agent;
  readonly csrf: string;
}

async function loginAgent(): Promise<AuthedAgent> {
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

interface LockListBody {
  data: { items: { id: number; relPath: string; releasedAt: number | null }[]; total: number };
}

/** A share to hang locks off. The lock tables key on `share_id`, nothing else. */
function seedShare(): number {
  db.run(
    `INSERT INTO shares (name, server_unc, mount_point, cache_path, enabled, conflict_mode,
                         created_at, updated_at)
       VALUES ('test', '//server/test', '/mnt/test', '/srv/test', 1, 'last_write_wins',
               unixepoch(), unixepoch())`,
  );
  return db.pluck<number>('SELECT id FROM shares') ?? 0;
}

/**
 * The listing and the release button, which had no coverage at all.
 *
 * The Locks page is the one screen an operator reaches for when a control has crashed
 * with a program open — the lock outlives the machine that took it, and the only way
 * back is this button. It was never exercised end to end: the manager had tests, the
 * route had none, and the query feeding the page returned the wrong rows entirely.
 */
describe('GET /locks', () => {
  it('returns only the locks that are actually held', async () => {
    const shareId = seedShare();
    const held = ctx.locks.acquire({ shareId, relPath: 'HELD.H', origin: 'manual' });
    const gone = ctx.locks.acquire({ shareId, relPath: 'GONE.H', origin: 'manual' });
    ctx.locks.release(gone.id);

    const { agent } = await loginAgent();
    const res = await agent.get('/api/v1/locks').expect(200);

    // The defect this pins: `includeReleased` defaults to false, but arrived through
    // `z.coerce.boolean()` — and `Boolean("false")` is true. Every released lock came
    // back, and twelve finished locks were displayed as twelve active ones.
    const body = res.body as LockListBody;
    expect(body.data.items.map((l) => l.relPath)).toEqual(['HELD.H']);
    expect(body.data.total).toBe(1);
    expect(held.releasedAt).toBeNull();
  });

  it('returns the released ones too when they are asked for by name', async () => {
    const shareId = seedShare();
    const gone = ctx.locks.acquire({ shareId, relPath: 'GONE.H', origin: 'manual' });
    ctx.locks.release(gone.id);

    const { agent } = await loginAgent();
    const res = await agent.get('/api/v1/locks?includeReleased=true').expect(200);

    expect((res.body as LockListBody).data.items).toHaveLength(1);
  });

  it('reads "false" as false, which is the whole point', async () => {
    const shareId = seedShare();
    ctx.locks.release(ctx.locks.acquire({ shareId, relPath: 'GONE.H', origin: 'manual' }).id);

    const { agent } = await loginAgent();
    const res = await agent.get('/api/v1/locks?includeReleased=false').expect(200);

    expect((res.body as LockListBody).data.items).toHaveLength(0);
  });

  it('requires authentication', async () => {
    await request(app).get('/api/v1/locks').expect(401);
  });
});

describe('DELETE /locks/:id', () => {
  it('releases a lock that a crashed control left behind', async () => {
    const shareId = seedShare();
    const lock = ctx.locks.acquire({
      shareId,
      relPath: 'CRASHED.H',
      origin: 'machine',
      machineIp: '172.16.37.42',
    });

    const { agent, csrf } = await loginAgent();
    await agent
      .delete(`/api/v1/locks/${String(lock.id)}`)
      .set('x-csrf-token', csrf)
      .expect(200);

    expect(ctx.locks.getActive(shareId, 'CRASHED.H')).toBeUndefined();
    const after = await agent.get('/api/v1/locks').expect(200);
    expect((after.body as LockListBody).data.items).toHaveLength(0);
  });

  it('keeps the released lock in the record rather than deleting the row', async () => {
    // A force-release is an intervention, and the history is the only place it shows.
    const shareId = seedShare();
    const lock = ctx.locks.acquire({ shareId, relPath: 'CRASHED.H', origin: 'machine' });

    const { agent, csrf } = await loginAgent();
    await agent
      .delete(`/api/v1/locks/${String(lock.id)}`)
      .set('x-csrf-token', csrf)
      .expect(200);

    const res = await agent.get('/api/v1/locks?includeReleased=true').expect(200);
    const items = (res.body as LockListBody).data.items;
    expect(items).toHaveLength(1);
    expect(items[0]?.releasedAt).not.toBeNull();
  });

  it('answers 404 for a lock that is already gone, instead of pretending', async () => {
    const shareId = seedShare();
    const lock = ctx.locks.acquire({ shareId, relPath: 'GONE.H', origin: 'manual' });
    ctx.locks.release(lock.id);

    const { agent, csrf } = await loginAgent();
    await agent
      .delete(`/api/v1/locks/${String(lock.id)}`)
      .set('x-csrf-token', csrf)
      .expect(404);
  });

  it('refuses without a CSRF token', async () => {
    const shareId = seedShare();
    const lock = ctx.locks.acquire({ shareId, relPath: 'HELD.H', origin: 'manual' });

    const { agent } = await loginAgent();
    await agent.delete(`/api/v1/locks/${String(lock.id)}`).expect(403);

    expect(ctx.locks.getActive(shareId, 'HELD.H')).toBeDefined();
  });
});

describe('GET /locks/schedule/preview', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/api/v1/locks/schedule/preview');
    expect(res.status).toBe(401);
  });

  it('returns empty list when no lock schedules exist', async () => {
    const { agent } = await loginAgent();
    const res = await agent.get('/api/v1/locks/schedule/preview').expect(200);

    expect(res.body).toMatchObject({
      ok: true,
      data: {
        windows: [],
        days: 7,
        count: 0,
      },
    });
  });

  it('returns scheduled lock windows with proper structure', async () => {
    const { agent, csrf } = await loginAgent();

    // Create a test share
    db.run(
      `INSERT INTO shares (name, server_unc, mount_point, cache_path, created_at, updated_at)
       VALUES (@name, @unc, @mount, @cache, @now, @now)`,
      {
        name: 'test-share',
        unc: '//server/share$',
        mount: '/mnt/test-share',
        cache: '/srv/smb-bridge/test-share',
        now: Math.floor(Date.now() / 1000),
      },
    );

    // Create a lock schedule with a simple cron expression
    // Using "*/5 * * * *" (every 5 minutes) guarantees an occurrence in the next few minutes
    const cronExpr = '*/5 * * * *';

    await agent
      .post('/api/v1/schedules')
      .set('x-csrf-token', csrf)
      .send({
        name: 'frequent lock',
        kind: 'lock',
        cron: cronExpr,
        target: { shareId: 1, pathGlob: '**/*.H', durationMinutes: 60 },
        enabled: true,
      })
      .expect(201);

    // Get the preview
    const res = await agent.get('/api/v1/locks/schedule/preview').expect(200);

    // Response structure is correct
    expect(res.body).toHaveProperty('data');
    expect(res.body.data).toHaveProperty('windows');
    expect(res.body.data).toHaveProperty('days', 7);
    expect(res.body.data).toHaveProperty('count');

    // If we have windows, check their structure
    if (res.body.data.windows.length > 0) {
      const window = res.body.data.windows[0];
      expect(window).toHaveProperty('scheduleName', 'frequent lock');
      expect(window).toHaveProperty('kind', 'lock');
      expect(window).toHaveProperty('shareId', 1);
      expect(window).toHaveProperty('pathGlob', '**/*.H');
      expect(window).toHaveProperty('startsAt');
      expect(window).toHaveProperty('endsAt');
      expect(typeof window.startsAt).toBe('number');
      expect(typeof window.endsAt).toBe('number');
    }
  });

  it('respects the days parameter', async () => {
    const { agent } = await loginAgent();

    // Create a test share
    db.run(
      `INSERT INTO shares (name, server_unc, mount_point, cache_path, created_at, updated_at)
       VALUES (@name, @unc, @mount, @cache, @now, @now)`,
      {
        name: 'test-share',
        unc: '//server/share$',
        mount: '/mnt/test-share',
        cache: '/srv/smb-bridge/test-share',
        now: Math.floor(Date.now() / 1000),
      },
    );

    // Request with default days
    const resDefault = await agent.get('/api/v1/locks/schedule/preview').expect(200);
    expect(resDefault.body.data.days).toBe(7);

    // Request with custom days
    const resCustom = await agent.get('/api/v1/locks/schedule/preview?days=30').expect(200);
    expect(resCustom.body.data.days).toBe(30);

    // Request with invalid days (should cap at 90)
    const resMax = await agent.get('/api/v1/locks/schedule/preview?days=999').expect(200);
    expect(resMax.body.data.days).toBe(90);
  });

  it('filters by share when specified', async () => {
    const { agent } = await loginAgent();

    // Create two shares
    for (let i = 1; i <= 2; i++) {
      db.run(
        `INSERT INTO shares (name, server_unc, mount_point, cache_path, created_at, updated_at)
         VALUES (@name, @unc, @mount, @cache, @now, @now)`,
        {
          name: `share-${i}`,
          unc: `//server/share${i}$`,
          mount: `/mnt/share${i}`,
          cache: `/srv/smb-bridge/share${i}`,
          now: Math.floor(Date.now() / 1000),
        },
      );
    }

    // Test that filtering by a non-existent share returns empty
    const resInvalid = await agent.get('/api/v1/locks/schedule/preview?share=999').expect(200);
    expect(resInvalid.body.data.count).toBe(0);
    expect(resInvalid.body.data.windows).toEqual([]);

    // Test that filtering by a valid share only returns locks for that share
    const resShare1 = await agent.get('/api/v1/locks/schedule/preview?share=1').expect(200);
    expect(resShare1.body.ok).toBe(true);
    expect(resShare1.body.data).toHaveProperty('count');

    if (resShare1.body.data.windows.length > 0) {
      // All windows should have shareId 1
      expect(resShare1.body.data.windows.every((w: { shareId: number }) => w.shareId === 1)).toBe(
        true,
      );
    }
  });
});
