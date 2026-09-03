import { createHash } from 'node:crypto';

import { Injectable, Inject, createParamDecorator } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import {
  AGENT_CLOCK_SKEW_SECONDS,
  AGENT_HEADER_INSTALLATION,
  AGENT_HEADER_ISSUED_AT,
  AGENT_HEADER_NONCE,
  AGENT_HEADER_SIGNATURE,
  AGENT_REQUEST_PREFIX,
  canonicalJson,
} from '@sher/control-contracts';
import type { Clock } from '@sher/shared-utils';
import type { Request } from 'express';
import type pg from 'pg';

import { ControlError, ControlErrorCode } from '../common/errors';
import { verifyEd25519 } from '../crypto/ed25519';
import { CONTROL_CLOCK, CONTROL_POOL } from '../db/tokens';

export interface AgentPrincipal {
  readonly installationId: string;
  readonly tenantId: string;
  readonly ip: string;
}

export const Agent = createParamDecorator((_data: unknown, ctx: ExecutionContext): AgentPrincipal => {
  const request = ctx.switchToHttp().getRequest<Request & { agent?: AgentPrincipal }>();
  if (request.agent === undefined) {
    throw new ControlError(ControlErrorCode.AGENT_UNAUTHENTICATED, 'Unauthenticated agent');
  }
  return request.agent;
});

/**
 * Every request a customer installation makes, checked (§3, §18).
 *
 * Five things must all be true, and each one closes a specific hole:
 *
 * 1. **The installation exists and is not revoked.** Revocation has to bite at
 *    the first check, before any work is done on the request's behalf.
 * 2. **The signature verifies against that installation's own key.** Not a
 *    shared secret — §3 is explicit, and a fleet-wide secret means one leaked
 *    shop is every shop.
 * 3. **The body hash inside the signed document matches the body received.**
 *    Without this, a signature is a token anyone who has seen it can attach to
 *    a different payload.
 * 4. **The clock is within five minutes.** Bounds how long a captured request
 *    is worth capturing.
 * 5. **The nonce has not been seen.** Closes the window that (4) leaves open;
 *    nonces are kept longer than the window is wide, so there is no seam
 *    between the two checks.
 *
 * The path is signed too, so a signed check-in cannot be re-pointed at the
 * command-result endpoint.
 */
@Injectable()
export class AgentAuthGuard implements CanActivate {
  constructor(
    @Inject(CONTROL_POOL) private readonly pool: pg.Pool,
    @Inject(CONTROL_CLOCK) private readonly clock: Clock,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<
      Request & { agent?: AgentPrincipal; rawBody?: Buffer }
    >();

    const installationId = header(request, AGENT_HEADER_INSTALLATION);
    const issuedAt = header(request, AGENT_HEADER_ISSUED_AT);
    const nonce = header(request, AGENT_HEADER_NONCE);
    const signature = header(request, AGENT_HEADER_SIGNATURE);
    if (installationId === '' || issuedAt === '' || nonce === '' || signature === '') {
      throw new ControlError(ControlErrorCode.AGENT_UNAUTHENTICATED, 'Unsigned request');
    }

    const found = await this.pool.query<{
      tenant_id: string;
      revoked_at: Date | null;
      public_key: string | null;
    }>(
      `SELECT i.tenant_id, i.revoked_at,
              (SELECT k.public_key FROM installation_keys k
                WHERE k.installation_id = i.id AND k.retired_at IS NULL
                ORDER BY k.created_at DESC LIMIT 1) AS public_key
         FROM installations i WHERE i.id = $1`,
      [installationId],
    );
    const row = found.rows[0];
    if (row === undefined || row.public_key === null) {
      throw new ControlError(ControlErrorCode.AGENT_UNAUTHENTICATED, 'Unknown installation');
    }
    if (row.revoked_at !== null) {
      throw new ControlError(ControlErrorCode.INSTALLATION_REVOKED, 'This installation is revoked');
    }

    const issued = Date.parse(issuedAt);
    const now = this.clock.now().getTime();
    if (Number.isNaN(issued) || Math.abs(now - issued) > AGENT_CLOCK_SKEW_SECONDS * 1000) {
      throw new ControlError(ControlErrorCode.AGENT_UNAUTHENTICATED, 'Request timestamp out of range');
    }

    const body = request.rawBody ?? Buffer.alloc(0);
    const document = {
      installation_id: installationId,
      method: request.method,
      // The path only — a query string is not part of this API's signed surface.
      path: (request.originalUrl ?? request.url).split('?')[0] ?? '',
      body_sha256: body.length === 0 ? '' : createHash('sha256').update(body).digest('hex'),
      issued_at: issuedAt,
      nonce,
    };
    const signed = `${AGENT_REQUEST_PREFIX}.${canonicalJson(document)}`;
    if (!verifyEd25519(signed, signature, row.public_key)) {
      throw new ControlError(ControlErrorCode.AGENT_UNAUTHENTICATED, 'Signature does not verify');
    }

    /*
     * The nonce insert is the replay check. A primary-key collision means this
     * exact request has been seen, and the refusal happens before any handler
     * runs — which is what makes replay protection independent of whether a
     * particular endpoint happens to be idempotent.
     */
    try {
      await this.pool.query('INSERT INTO agent_nonces (installation_id, nonce) VALUES ($1,$2)', [
        installationId,
        nonce,
      ]);
    } catch {
      throw new ControlError(ControlErrorCode.AGENT_UNAUTHENTICATED, 'Replayed request');
    }

    request.agent = { installationId, tenantId: row.tenant_id, ip: ipOf(request) };
    return true;
  }
}

function header(request: Request, name: string): string {
  const value = request.headers[name];
  return typeof value === 'string' ? value : '';
}

function ipOf(request: Request): string {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded !== '') return forwarded.split(',')[0]?.trim() ?? '';
  return request.ip ?? '';
}
