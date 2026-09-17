import { hostname } from 'node:os';

import { Router } from 'express';

import {
  regenerateCertificateRequestSchema,
  uploadCertificateRequestSchema,
  type CertificateInfo,
} from '../../../shared';
import { installCertificate } from '../certificate-service';
import { type AppContext } from '../context';
import { HttpError } from '../envelope';
import { ok, requireCsrf, requireSession } from '../middleware';
import {
  CertificateError,
  type CertificateMaterial,
  describeCertificate,
  generateSelfSignedCertificate,
  loadCertificateMaterial,
} from '../https-setup';

/**
 * `/certificates` — the TLS material behind the admin interface itself.
 *
 * The delicate part — validate, then hot-swap, then persist, in that order and no other
 * — lives in {@link installCertificate}, because a rename replaces the certificate too
 * and both paths have to observe the same rule.
 */
export function certificateRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get('/certificates', requireSession(ctx), (_req, res) => {
    ok(res, currentCertificate(ctx));
  });

  /**
   * The public certificate, as a file.
   *
   * On an appliance with a self-signed certificate this is the only way out of the
   * browser warning: the operator downloads the certificate and installs it in their
   * own trust store. Copying it out of the filesystem means SSH, which is the thing the
   * web UI exists to avoid.
   *
   * The certificate only — never `key.pem`, and never the two together in one bundle.
   * The private key has no reason to leave the appliance, and an endpoint that can be
   * asked for it is an endpoint that can be tricked into handing it over.
   */
  router.get('/certificates/download', requireSession(ctx), (_req, res) => {
    let material;
    try {
      material = loadCertificateMaterial(ctx.certDir);
    } catch (error) {
      throw new HttpError(
        404,
        'NOT_FOUND',
        error instanceof CertificateError
          ? error.message
          : `No certificate could be read from ${ctx.certDir}`,
      );
    }

    // The chain is appended when there is one: a certificate that validates only with
    // its intermediates is not much use to whoever is importing it.
    const body =
      material.chainPem === undefined
        ? material.certPem
        : [material.certPem.trimEnd(), material.chainPem.trimEnd(), ''].join('\n');

    res.setHeader('content-type', 'application/x-pem-file');
    res.setHeader('content-disposition', 'attachment; filename="smb-bridge-cert.pem"');
    res.send(body);
  });

  router.post('/certificates', requireSession(ctx), requireCsrf(ctx), (req, res) => {
    const body = uploadCertificateRequestSchema.parse(req.body);
    const material: CertificateMaterial =
      body.chainPem === undefined
        ? { certPem: body.certPem, keyPem: body.keyPem }
        : { certPem: body.certPem, keyPem: body.keyPem, chainPem: body.chainPem };

    const info = installCertificate(ctx, material, 'certificates.upload', req.ip);
    ok(res, info);
  });

  router.post('/certificates/regenerate', requireSession(ctx), requireCsrf(ctx), (req, res) => {
    const body = regenerateCertificateRequestSchema.parse(req.body ?? {});
    const material = generateSelfSignedCertificate({
      commonName: hostname(),
      validityYears: body.validityYears,
      additionalSans: body.additionalSans,
    });

    const info = installCertificate(ctx, material, 'certificates.regenerate', req.ip);
    ok(res, info);
  });

  return router;
}

function currentCertificate(ctx: AppContext): CertificateInfo {
  try {
    return describeCertificate(loadCertificateMaterial(ctx.certDir).certPem);
  } catch (error) {
    throw new HttpError(
      404,
      'NOT_FOUND',
      error instanceof CertificateError
        ? error.message
        : `No certificate could be read from ${ctx.certDir}`,
    );
  }
}
