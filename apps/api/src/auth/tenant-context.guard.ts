import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { createParamDecorator, Inject, Injectable } from '@nestjs/common';
import type { TenantContext } from '@sher/core-application';
import { AppError, ErrorCode } from '@sher/core-contracts';
import type { Clock } from '@sher/shared-utils';
import type { Request } from 'express';

import { API_CONFIG, CLOCK } from '../infrastructure/tokens';
import type { ApiConfig } from '../config';
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
