import { All, Controller, Inject, Param, Req, Res, UseGuards } from '@nestjs/common';
import { SUPPORT_FORBIDDEN_ROUTES, SUPPORT_HEADER_GRANT } from '@sher/control-contracts';
import type { Request, Response } from 'express';

import { ControlError, ControlErrorCode } from '../common/errors';
import { Operator, OperatorGuard, RequirePermission } from '../operators/operator.guard';
import type { OperatorPrincipal } from '../operators/operator.guard';
import type { SupportService } from './support.service';
import type { TunnelRegistry } from './tunnel-registry';
import { SUPPORT_SERVICE, TUNNEL_REGISTRY } from '../tokens';

/**
 * The support gateway — the vendor's browser, a shop's ERP, and nothing else in
 * between (§13, §16).
 *
 * Every request the operator's browser makes inside a session arrives here,
 * gets the session's signed grant attached, and is forwarded down the tunnel to
 * the shop's own ERP. **The gateway does not decide what the operator may do.**
 * It attaches the grant and forwards; the shop's ERP applies its own
 * permissions, its own domain rules and its own audit writer. That is what
 * makes §14 true — a correction made in here goes through exactly the code path
 * a correction made at the shop counter goes through, because it *is* the same
 * code path.
 *
 * Two things it does decide, and both are refusals:
 *
 * - **The forbidden routes.** `SUPPORT_FORBIDDEN_ROUTES` is checked at the edge
 *   as well as by permission inside the ERP, because a route that forgot to
 *   declare a permission would otherwise inherit the owner-equivalent ceiling
 *   by omission. Belt and braces on the two things an audit trail cannot
 *   repair: identity, and erasure.
 * - **The session must be live right now.** Not "was live when the page
 *   loaded". Expiry and revocation are the entire containment story for a
 *   pre-authorized session, so they are checked on every single request.
 *
 * There is no `Run SQL` here, and no shell. §13 and §27 forbid them, and the
 * way to keep them out is for the gateway to speak only HTTP to the ERP's own
 * API — a protocol in which neither of those things can be expressed.
 */
@Controller('api/control/support')
@UseGuards(OperatorGuard)
export class SupportGatewayController {
  constructor(
    @Inject(SUPPORT_SERVICE) private readonly support: SupportService,
    @Inject(TUNNEL_REGISTRY) private readonly tunnel: TunnelRegistry,
  ) {}

  @All(':sessionId/proxy/*')
  @RequirePermission('support.view')
  async proxy(
    @Param('sessionId') sessionId: string,
    @Req() request: Request & { rawBody?: Buffer },
    @Res() response: Response,
    @Operator() operator: OperatorPrincipal,
  ): Promise<void> {
    const session = await this.support.activeSession(sessionId);
    if (session === null) {
      throw new ControlError(
        ControlErrorCode.SUPPORT_SESSION_INACTIVE,
        'That support session has ended. Open a new one to continue.',
      );
    }
    /*
     * A session belongs to the operator who opened it. Another operator with
     * `support.view` may read the record — that is what an audit role is for —
     * but may not act through somebody else's grant, because the grant names an
     * operator and the audit trail would then be wrong.
     */
    if (session.operatorId !== operator.id) {
      throw new ControlError(
        ControlErrorCode.PERMISSION_DENIED,
        'That session belongs to another operator',
      );
    }

    const prefix = `/api/control/support/${sessionId}/proxy`;
    const target = (request.originalUrl ?? request.url).slice(prefix.length) || '/';
    const path = target.split('?')[0] ?? '/';

    if (SUPPORT_FORBIDDEN_ROUTES.some((route) => path.startsWith(route))) {
      await this.support.recordAction({
        sessionId,
        method: request.method,
        path,
        status: 403,
        documentRef: '',
      });
      throw new ControlError(
        ControlErrorCode.PERMISSION_DENIED,
        'A support session may not change credentials, users, roles, or erase or restore data',
      );
    }

    const renewed = await this.support.renew(sessionId);
    if (renewed === null) {
      throw new ControlError(ControlErrorCode.SUPPORT_SESSION_INACTIVE, 'That support session has ended');
    }

    const body = request.rawBody ?? Buffer.alloc(0);
    const forwarded = await this.tunnel.request(session.installationId, {
      method: request.method,
      path: target,
      headers: {
        'content-type': String(request.headers['content-type'] ?? 'application/json'),
        accept: String(request.headers['accept'] ?? '*/*'),
        // The grant travels with every request. The ERP verifies it against the
        // pinned support public key on its own, so nothing here is trusted
        // merely because it arrived through the tunnel.
        [SUPPORT_HEADER_GRANT]: Buffer.from(
          JSON.stringify({ grant: renewed.grant, signature: renewed.signature }),
          'utf8',
        ).toString('base64'),
      },
      body: body.length === 0 ? '' : body.toString('base64'),
    });

    await this.support.recordAction({
      sessionId,
      method: request.method,
      path,
      status: forwarded.status,
      // A mutation's target, so a corrected document can be found again later
      // (§15's "before/after references"). The ERP's own audit rows hold the
      // values; this holds the pointer to them.
      documentRef: request.method === 'GET' ? '' : path,
    });

    for (const [name, value] of Object.entries(forwarded.headers)) {
      // Hop-by-hop headers describe the shop's connection, not this one, and
      // re-emitting them corrupts the response the browser receives.
      if (HOP_BY_HOP.includes(name.toLowerCase())) continue;
      response.setHeader(name, value);
    }
    /*
     * The one deliberate header change (§13, owner decision 2026-09-03).
     *
     * The ERP sends `X-Frame-Options: DENY` to its own users and must keep
     * doing so — that header is what stops a shop's session being clickjacked.
     * The console embeds the ERP in an iframe, so this one response, inside
     * this one session, is allowed to be framed by this one origin. The
     * exception is scoped to the gateway, never applied to traffic a shop's own
     * users receive, and never widened to `*`.
     */
    response.removeHeader('X-Frame-Options');
    response.setHeader('Content-Security-Policy', `frame-ancestors ${consoleOriginOf(request)}`);
    response.status(forwarded.status).end(Buffer.from(forwarded.body, 'base64'));
  }
}

const HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'content-encoding',
  'x-frame-options',
  'content-security-policy',
];

/** The console's own origin — never a value taken from the shop's response. */
function consoleOriginOf(request: Request): string {
  const origin = request.headers.origin;
  return typeof origin === 'string' && origin !== '' ? origin : "'self'";
}
