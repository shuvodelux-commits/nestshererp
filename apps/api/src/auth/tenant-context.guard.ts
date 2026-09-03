import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { createParamDecorator, Inject, Injectable } from '@nestjs/common';
import type { TenantContext } from '@sher/core-application';
import { AppError, ErrorCode } from '@sher/core-contracts';
import type { Clock } from '@sher/shared-utils';
import type { Request } from 'express';

import { API_CONFIG, CLOCK } from '../infrastructure/tokens';
import type { ApiConfig } from '../config';
import { SUPPORT_GRANT_HEADER, verifySupportGrant } from '../management/support-grant';
import { verifyToken } from './jwt';

interface RequestWithContext extends Request {
  tenantContext?: TenantContext;
}

/**
 * Builds TenantContext from the bearer token. Cheap early rejection only — the
 * authority on permissions is the use case (R-D2), because MCP, background jobs
 * and future offline writes never reach this guard.
 */
@Injectable()
export class TenantContextGuard implements CanActivate {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithContext>();

    /*
     * Phase 17 (§12, §13, §14): a signed vendor support grant is the other way
     * to become a tenant context on this request.
     *
     * It is checked **here**, in the one guard every route already uses, rather
     * than by adding a second guard to a few hundred controllers. That is the
     * whole reason a support session can drive the real ERP: the request that
     * follows goes through the same controller, the same application service,
     * the same domain rules and the same AuditWriter as a click at the counter,
     * because nothing downstream can tell the difference — and nothing
     * downstream should be able to.
     *
     * What it is not is a bypass. `verifySupportGrant` refuses an unsigned,
     * expired, foreign or out-of-scope grant, and refuses outright on the
     * routes that could change credentials or erase the evidence of the visit.
     */
    const supportHeader = request.headers[SUPPORT_GRANT_HEADER];
    if (typeof supportHeader === 'string' && supportHeader !== '') {
      request.tenantContext = verifySupportGrant(supportHeader, {
        supportPublicKey: this.config.supportPublicKey,
        path: (request.originalUrl ?? request.url).split('?')[0] ?? '',
        now: this.clock.now(),
      });
      return true;
    }

    const header = request.headers.authorization;
    if (header === undefined || !header.startsWith('Bearer ')) {
      throw new AppError(ErrorCode.UNAUTHENTICATED, 'Missing bearer token');
    }

    request.tenantContext = verifyToken(header.slice('Bearer '.length), this.config.jwtSecret, this.clock);
    return true;
  }
}

/** Injects the verified TenantContext into a controller argument. */
export const Ctx = createParamDecorator((_data: unknown, context: ExecutionContext): TenantContext => {
  const request = context.switchToHttp().getRequest<RequestWithContext>();
  if (request.tenantContext === undefined) {
    throw new AppError(ErrorCode.UNAUTHENTICATED, 'No tenant context on this request');
  }
  return request.tenantContext;
});
