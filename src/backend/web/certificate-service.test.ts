import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { pki } from 'node-forge';

import { cleanupTmpDbs, tmpDb, tmpDir } from '../../../tests/support/tmp-db';
import { ConfigManager } from '../config/config-manager';
import { type Db } from '../config/db';
import { runMigrations } from '../config/migrations/runner';
import { generateSecretKey } from '../config/secrets';
import { createShareCacheRootResolver } from '../config/share-paths';
import { ConflictResolver } from '../locking/conflict-resolver';
import { LockManager } from '../locking/lock-manager';
import { AuthLogWriter } from '../logging/auth-log';
import { createBridgeMetrics } from '../monitoring/registry';
import { JobRegistry } from '../scheduling/jobs';
import { Scheduler } from '../scheduling/scheduler';
import { AuditLog, installAuditGuards } from '../security/audit-log';
import { BlobStore } from '../versioning/blob-store';
import { VersionStore } from '../versioning/version-store';
import { AuthManager } from './auth';
import { reissueCertificateForHostname } from './certificate-service';
import { type AppContext } from './context';
import { EventBus } from './event-bus';
import {
  type CertificateMaterial,
  describeCertificate,
  generateSelfSignedCertificate,
  saveCertificateMaterial,
} from './https-setup';

/**
 * Renaming the appliance and the certificate that names it.
 *
 * Two of these are the ones that matter on a live machine: a CA-signed certificate must
 * survive a rename untouched, and no failure in here may be able to turn a successful
 * network change into a reported failure.
 */

let db: Db;
let ctx: AppContext;
let certDir: string;
let reloaded: CertificateMaterial[];
let reloadFails: boolean;

function buildContext(): AppContext {
  const config = ConfigManager.create({ db, secretKey: generateSecretKey() });
  installAuditGuards(db);
  return {
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
    certDir,
    version: '0.0.0-test',
    startedAt: Date.now() - 1000,
    now: () => Date.now(),
    httpsManager: {
      reload: (material: CertificateMaterial) => {
        if (reloadFails) {
          throw new Error('the live server refused this context');
        }
        reloaded.push(material);
      },
    } as NonNullable<AppContext['httpsManager']>,
  };
}

/**
 * A genuinely CA-signed leaf, built with node-forge.
 *
 * `selfsigned.generate()` cannot produce one — every certificate it makes has its own
 * subject as its issuer, which is exactly the property under test here, since
 * `describeCertificate` decides `selfSigned` by comparing those two.
 */
function caSignedMaterial(): CertificateMaterial {
  const caKeys = pki.rsa.generateKeyPair(1024);
  const caAttrs = [{ name: 'commonName', value: 'Example Issuing CA' }];
  const ca = pki.createCertificate();
  ca.publicKey = caKeys.publicKey;
  ca.serialNumber = '01';
  ca.validity.notBefore = new Date(Date.now() - 86_400_000);
  ca.validity.notAfter = new Date(Date.now() + 800 * 86_400_000);
  ca.setSubject(caAttrs);
  ca.setIssuer(caAttrs);
  ca.setExtensions([{ name: 'basicConstraints', cA: true }]);
  ca.sign(caKeys.privateKey);

  const leafKeys = pki.rsa.generateKeyPair(1024);
  const leaf = pki.createCertificate();
  leaf.publicKey = leafKeys.publicKey;
  leaf.serialNumber = '02';
  leaf.validity.notBefore = new Date(Date.now() - 86_400_000);
  leaf.validity.notAfter = new Date(Date.now() + 400 * 86_400_000);
  leaf.setSubject([{ name: 'commonName', value: 'bridge.example.com' }]);
  leaf.setIssuer(caAttrs);
  leaf.sign(caKeys.privateKey);

  return {
    certPem: pki.certificateToPem(leaf),
    keyPem: pki.privateKeyToPem(leafKeys.privateKey),
    chainPem: pki.certificateToPem(ca),
  };
}

beforeEach(() => {
  db = tmpDb();
  runMigrations(db);
  certDir = tmpDir('smb-tls-');
  reloaded = [];
  reloadFails = false;
  ctx = buildContext();
});

afterEach(() => {
  cleanupTmpDbs();
});

describe('reissueCertificateForHostname', () => {
  it('issues a certificate naming the new host, and puts it live before it hits disk', () => {
    saveCertificateMaterial(certDir, generateSelfSignedCertificate({ commonName: 'old-name' }));

    const outcome = reissueCertificateForHostname(ctx, 'new-name', ['172.16.35.70']);

    expect(outcome.reason).toBe('reissued');
    expect(outcome.info?.subject).toContain('new-name');
    expect(outcome.info?.subjectAltNames).toContain('new-name');
    // The address the operator was just told to browse to has to be in there too.
    expect(outcome.info?.subjectAltNames).toContain('172.16.35.70');
    expect(reloaded).toHaveLength(1);

    const onDisk = describeCertificate(readFileSync(join(certDir, 'cert.pem'), 'utf8'));
    expect(onDisk.fingerprintSha256).toBe(outcome.info?.fingerprintSha256);
    expect(onDisk.fingerprintSha256).toBe(
      describeCertificate(reloaded[0]!.certPem).fingerprintSha256,
    );
  });

  it('leaves a CA-signed certificate alone', () => {
    const material = caSignedMaterial();
    saveCertificateMaterial(certDir, material);

    const outcome = reissueCertificateForHostname(ctx, 'new-name');

    expect(outcome.reason).toBe('custom_certificate');
    expect(reloaded).toHaveLength(0);
    expect(readFileSync(join(certDir, 'cert.pem'), 'utf8')).toBe(material.certPem);
    // Visible to the operator afterwards, because nothing else will tell them their
    // certificate now names a host that no longer exists.
    expect(new AuditLog(db).query({ action: 'certificates.reissue.skipped' }).total).toBe(1);
  });

  it('does nothing when the certificate already speaks for the name', () => {
    saveCertificateMaterial(certDir, generateSelfSignedCertificate({ commonName: 'same-name' }));

    expect(reissueCertificateForHostname(ctx, 'same-name').reason).toBe('already_covered');
    expect(reloaded).toHaveLength(0);
  });

  it('matches the name case-insensitively, the way a host name compares', () => {
    saveCertificateMaterial(certDir, generateSelfSignedCertificate({ commonName: 'Bridge-01' }));

    expect(reissueCertificateForHostname(ctx, 'bridge-01').reason).toBe('already_covered');
  });

  it('keeps the previous certificate in force when the live server refuses the new one', () => {
    const previous = generateSelfSignedCertificate({ commonName: 'old-name' });
    saveCertificateMaterial(certDir, previous);
    reloadFails = true;

    const outcome = reissueCertificateForHostname(ctx, 'new-name');

    expect(outcome.reason).toBe('failed');
    // The invariant the whole ordering exists for: a refused swap changes no file.
    expect(readFileSync(join(certDir, 'cert.pem'), 'utf8')).toBe(previous.certPem);
  });

  it('reports rather than throws when there is no certificate to bring up to date', () => {
    expect(existsSync(join(certDir, 'cert.pem'))).toBe(false);

    expect(reissueCertificateForHostname(ctx, 'new-name').reason).toBe('no_certificate');
  });

  it('never throws, so a rename cannot be reported as a failed network change', () => {
    saveCertificateMaterial(certDir, generateSelfSignedCertificate({ commonName: 'old-name' }));
    // The dev proxy and the test harness both serve over a listener this process does
    // not own; installing into one is impossible and must still not escape.
    const detached: AppContext = { ...ctx };
    delete detached.httpsManager;

    expect(reissueCertificateForHostname(detached, 'new-name').reason).toBe('failed');
  });

  it('keeps the validity span of the certificate it replaces', () => {
    saveCertificateMaterial(
      certDir,
      generateSelfSignedCertificate({ commonName: 'old-name', validityYears: 2 }),
    );

    const outcome = reissueCertificateForHostname(ctx, 'new-name');

    const days = ((outcome.info?.notAfter ?? 0) - (outcome.info?.notBefore ?? 0)) / 86_400;
    expect(days).toBeGreaterThan(700);
    expect(days).toBeLessThan(760);
  });

  it('treats an empty hostname as nothing to do', () => {
    saveCertificateMaterial(certDir, generateSelfSignedCertificate({ commonName: 'old-name' }));

    expect(reissueCertificateForHostname(ctx, '').reason).toBe('already_covered');
    expect(reloaded).toHaveLength(0);
  });
});
