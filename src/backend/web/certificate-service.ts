import { type CertificateInfo } from '../../shared';

import { type AppContext } from './context';
import { HttpError } from './envelope';
import {
  type CertificateMaterial,
  describeCertificate,
  generateSelfSignedCertificate,
  loadCertificateMaterial,
  saveCertificateMaterial,
  validateCertificateMaterial,
} from './https-setup';

/**
 * Putting a certificate into service, and deciding when the appliance should do that
 * for itself.
 *
 * Lives outside `routes/certificates.ts` because the operator is not the only one who
 * replaces the certificate: renaming the host does too (see
 * {@link reissueCertificateForHostname}), and both paths have to observe the same
 * ordering rule, which is the delicate part of this file.
 */

/**
 * Validate → hot-swap → persist.
 *
 * The ordering is the whole point. A certificate the running server cannot serve locks
 * the operator out of the only interface they have for fixing it, on a headless
 * appliance, with no console. So: validate first, hot-swap into the live server second,
 * and only write to disk once the swap has succeeded. A failure at any step leaves both
 * the running server and `certDir` exactly as they were.
 *
 * Writing to disk *last* is deliberate and the opposite of the obvious order. Persisting
 * first would leave a certificate that survives a restart but that the live process
 * rejected — the worst of both, and invisible until the next reboot.
 */
export function installCertificate(
  ctx: AppContext,
  material: CertificateMaterial,
  action: string,
  ip: string | undefined,
): CertificateInfo {
  const validation = validateCertificateMaterial(material);
  if (!validation.ok) {
    ctx.audit?.recordDenied({
      actor: 'admin',
      action,
      detail: validation.issues.map((issue) => issue.message).join('; '),
      ...(ip === undefined ? {} : { ip }),
    });
    throw new HttpError(
      400,
      'VALIDATION_FAILED',
      'The certificate was rejected and nothing was changed',
      validation.issues.map((issue) => ({ path: issue.path, message: issue.message })),
    );
  }

  // No httpsManager means the process is serving over a listener it does not own — the
  // dev proxy, or a test. Persisting anyway would be a lie: the certificate on disk
  // would not be the one being served until a restart nobody asked for.
  if (ctx.httpsManager === undefined) {
    throw new HttpError(
      503,
      'SERVICE_UNAVAILABLE',
      'The HTTPS server is not under this process’s control, so the certificate cannot be replaced',
    );
  }

  try {
    ctx.httpsManager.reload(material, ctx.config.get('security').tlsMin);
  } catch (error) {
    ctx.audit?.recordDenied({
      actor: 'admin',
      action,
      detail: `hot-reload failed: ${error instanceof Error ? error.message : String(error)}`,
      ...(ip === undefined ? {} : { ip }),
    });
    throw new HttpError(
      400,
      'VALIDATION_FAILED',
      'The live server refused the certificate; the previous one is still in use',
    );
  }

  saveCertificateMaterial(ctx.certDir, material);

  const info = validation.info ?? describeCertificate(material.certPem);
  ctx.audit?.record({
    actor: 'admin',
    action,
    target: info.fingerprintSha256,
    detail: `subject=${info.subject} notAfter=${new Date(info.notAfter * 1000).toISOString()}`,
    ...(ip === undefined ? {} : { ip }),
  });
  return info;
}

/** Why a rename did or did not lead to a new certificate. Reported, never thrown. */
export type ReissueReason =
  /** A fresh self-signed certificate is now live and on disk. */
  | 'reissued'
  /** The old certificate already names this host — nothing to do. */
  | 'already_covered'
  /** Someone uploaded a CA-signed certificate; only they can replace it. */
  | 'custom_certificate'
  /** Nothing readable in `certDir`, so there is nothing to bring up to date. */
  | 'no_certificate'
  /** Generation or installation failed; the previous certificate is still in use. */
  | 'failed';

export interface ReissueOutcome {
  readonly reason: ReissueReason;
  readonly info?: CertificateInfo;
  /** Set when `reason` is `failed`. */
  readonly error?: string;
}

/**
 * Brings the self-signed certificate back in step with a hostname that has just changed.
 *
 * The operator renames the appliance in the network settings and then types the new name
 * into the address bar; without this the browser meets a certificate for a host that no
 * longer exists, and the only warning it can give is the one that looks like an attack.
 * The user's call, made explicitly: *"if you change something as fundamental as the
 * hostname, a network interruption is entirely legitimate."*
 *
 * Two things it will not do:
 *
 * - **Touch a certificate it did not issue.** A CA-signed certificate is the site's
 *   property; replacing it with a self-signed one over a rename would silently downgrade
 *   the appliance's identity, and nothing here can get the CA to sign a new name anyway.
 * - **Fail the rename.** The hostname is already set and the addressing already applied
 *   by the time this runs. An unreachable certificate authority, a full disk, a `certDir`
 *   nobody can read — none of those are a reason to report a network change as failed
 *   when it succeeded. Every failure comes back as {@link ReissueOutcome}, logged.
 *
 * The new certificate keeps the old one's validity *span*, so a deliberately short-lived
 * certificate does not quietly become a ten-year one on a rename.
 */
export function reissueCertificateForHostname(
  ctx: AppContext,
  hostname: string,
  additionalSans: readonly string[] = [],
): ReissueOutcome {
  if (hostname === '') {
    return { reason: 'already_covered' };
  }

  let current: CertificateInfo;
  try {
    current = describeCertificate(loadCertificateMaterial(ctx.certDir).certPem);
  } catch (error) {
    ctx.logger?.warn(
      { hostname, error: messageOf(error) },
      'hostname changed but no certificate could be read; leaving it alone',
    );
    return { reason: 'no_certificate' };
  }

  if (!current.selfSigned) {
    ctx.logger?.info(
      { hostname, subject: current.subject },
      'hostname changed but the certificate is CA-signed; only an operator can replace it',
    );
    ctx.audit?.record({
      actor: 'system',
      action: 'certificates.reissue.skipped',
      target: hostname,
      detail: 'the installed certificate is CA-signed and was left in place',
    });
    return { reason: 'custom_certificate', info: current };
  }

  // The name *and* every address the caller wants vouched for. Checking only the name
  // would call an address-only change "already covered" and send the operator to an
  // address the certificate does not carry — the same dead end, one field over.
  if (covers(current, [hostname, ...additionalSans])) {
    return { reason: 'already_covered', info: current };
  }

  try {
    const material = generateSelfSignedCertificate({
      commonName: hostname,
      validityYears: validityYearsOf(current),
      // Everything the outgoing certificate spoke for, plus what is new.
      //
      // The new address is passed in rather than left to `os.networkInterfaces()`,
      // which `generateSelfSignedCertificate` reads for itself: the interface may not
      // have finished coming up on it yet, and a certificate that misses the very
      // address the operator was told to browse to is the failure this exists to
      // prevent.
      //
      // The old names are carried over for the mirror image of that. An unconfirmed
      // apply reverts the addressing after five minutes, and the operator then arrives
      // on the *old* address — with a certificate naming only the new one, if this
      // rebuilt the list from scratch. It also keeps whatever an operator added by hand
      // on an earlier `certificates.regenerate`, which nothing else remembers.
      additionalSans: [hostname, ...additionalSans, ...current.subjectAltNames],
    });
    const info = installCertificate(ctx, material, 'certificates.reissue', undefined);
    ctx.logger?.info(
      { hostname, fingerprint: info.fingerprintSha256 },
      'reissued the self-signed certificate for the new hostname',
    );
    return { reason: 'reissued', info };
  } catch (error) {
    ctx.logger?.error(
      { hostname, error: messageOf(error) },
      'could not reissue the certificate for the new hostname; the previous one is still in use',
    );
    return { reason: 'failed', error: messageOf(error) };
  }
}

/** Whether the certificate already speaks for every one of `wanted`. */
function covers(info: CertificateInfo, wanted: readonly string[]): boolean {
  const known = new Set(info.subjectAltNames.map((name) => name.toLowerCase()));
  return wanted.every((name) => known.has(name.toLowerCase()));
}

/**
 * The validity span of the certificate being replaced, in whole years, clamped to what
 * {@link regenerateCertificateRequestSchema} accepts. Rounded up so a certificate with
 * eleven months left is renewed as a one-year one rather than a zero-year one.
 */
function validityYearsOf(info: CertificateInfo): number {
  const spanDays = (info.notAfter - info.notBefore) / 86_400;
  return Math.min(20, Math.max(1, Math.ceil(spanDays / 365)));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
