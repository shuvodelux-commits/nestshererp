import type { CanActivate } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import { AppError, ErrorCode } from '@sher/core-contracts';

import { API_CONFIG } from '../infrastructure/tokens';
import type { ApiConfig } from '../config';

/**
 * D-34: "When `SINGLE_TENANT_MODE=true`, registration routes return **404**,
 * not 403."
 *
 * The distinction is the whole rule. A 403 says "this exists and you may not
 * use it", which invites someone to go looking for the way in. A 404 says the
 * route is not there, which in an on-premise install is simply true: that build
 * has no signup, its single tenant is seeded by the installer, and there is
 * nothing behind the door to find.
 *
 * The routes are **disabled by configuration, never deleted** (§4.4's governing
 * rule) — SaaS and on-premise are the same build, and a separate on-premise
 * fork is forbidden. This guard is that configuration.
 */
@Injectable()
export class SingleTenantRegistrationGuard implements CanActivate {
  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {}

  canActivate(): boolean {
    if (this.config.singleTenantMode) {
      throw new AppError(ErrorCode.NOT_FOUND, 'No such endpoint');
    }
    return true;
  }
}
