import { Router } from 'express';

import { applyNetworkSideRequestSchema, type CertificateReissueOutcome } from '../../../shared';
import { NetworkApplyError, NetworkApplyService } from '../../network/apply-service';
import { reissueCertificateForHostname } from '../certificate-service';
import { type AppContext } from '../context';
import { HttpError } from '../envelope';
import { ok, requireCsrf, requireSession } from '../middleware';

/**
 * Applying the saved network configuration to the running system.
 *
 * Keyed by side rather than by MAC. The MAC is the right key for *storage* — it is what
 * survives a NIC being renamed across a reboot — but it is the wrong thing to ask an
 * operator for. They know which cable goes to the plant and which goes to the machines;
 * the configuration screen is organised that way, and so is this.
 */
export function networkApplyRoutes(ctx: AppContext): Router {
  const router = Router();
  const service = new NetworkApplyService({
    db: ctx.db,
    config: ctx.config,
    logger: ctx.logger,
  });

  router.post('/network/apply', requireSession(ctx), requireCsrf(ctx), (req, res) => {
    const { side } = applyNetworkSideRequestSchema.parse(req.body);
    try {
      // The local end of this connection is what tells the service whether the change
      // can cut the channel used to undo it.
      const result = service.apply(side, req.socket.localAddress);
      ctx.audit?.record({
        actor: 'admin',
        action: 'network.apply',
        target: `${side} (${result.interface})`,
        detail:
          result.status === 'applied'
            ? 'applied outright; this connection is not affected'
            : `awaiting confirmation until ${new Date((result.expiresAt ?? 0) * 1000).toISOString()}`,
        ...(req.ip === undefined ? {} : { ip: req.ip }),
      });
      ok(res, { ...result, certificate: certificateFor(ctx, result.renamedTo) });
    } catch (error) {
      throw toHttp(error);
    }
  });

  router.post('/network/confirm', requireSession(ctx), requireCsrf(ctx), (req, res) => {
    const { side } = applyNetworkSideRequestSchema.parse(req.body);
    try {
      service.confirm(side);
      ctx.audit?.record({
        actor: 'admin',
        action: 'network.confirm',
        target: side,
        ...(req.ip === undefined ? {} : { ip: req.ip }),
      });
      ok(res, { acknowledged: true as const });
    } catch (error) {
      throw toHttp(error);
    }
  });

  /**
   * Unauthenticated deliberately? No — but worth saying why it is not: the operator
   * reaching this after a change has had to log in again anyway, because the session
   * cookie is bound to the old address.
   */
  router.get('/network/pending', requireSession(ctx), (_req, res) => {
    const entries = service.pending();
    const first = entries[0];
    ok(res, {
      pending: first?.change ?? null,
      secondsRemaining: first?.secondsRemaining ?? null,
    });
  });

  return router;
}

/**
 * Keeps the self-signed certificate naming the host the appliance now answers to.
 *
 * Runs *after* the apply, deliberately. The rename has already happened by then and is
 * not part of what the revert timer would undo, so there is no state to be consistent
 * with beyond "what is the machine called now". Swapping the certificate does not drop
 * this connection — `setSecureContext` only affects handshakes that have yet to happen
 * — so the operator still receives this response, including the word that their next
 * page load will meet a certificate their browser has not seen before.
 */
function certificateFor(
  ctx: AppContext,
  renamedTo: { hostname: string; address: string | null } | null,
): CertificateReissueOutcome | null {
  if (renamedTo === null) {
    return null;
  }
  return reissueCertificateForHostname(
    ctx,
    renamedTo.hostname,
    renamedTo.address === null ? [] : [renamedTo.address],
  ).reason;
}

function toHttp(error: unknown): unknown {
  if (error instanceof NetworkApplyError) {
    return new HttpError(
      400,
      'VALIDATION_FAILED',
      error.message,
      error.issues.map((issue) => ({ path: issue.field, message: issue.message })),
    );
  }
  return error;
}
