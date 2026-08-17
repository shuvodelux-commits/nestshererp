import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import type { GetMyAccessService, TenantContext } from '@sher/core-application';
import type { MyAccessResponse } from '@sher/core-contracts';

import { Ctx, TenantContextGuard } from '../auth/tenant-context.guard';
import { GET_MY_ACCESS_SERVICE } from './tokens';

/**
 * Who is signed in and what they may do (UI-09).
 *
 * Ungated on purpose: refusing to tell someone what they may do would leave the
 * app unable to draw itself for them, and reveals nothing they could not learn
 * by clicking. It is not an authorisation decision — every use case still
 * checks for itself (§5.26).
 */
@Controller('api/v1/me')
@UseGuards(TenantContextGuard)
export class MeController {
  constructor(@Inject(GET_MY_ACCESS_SERVICE) private readonly access: GetMyAccessService) {}

  @Get()
  async get(@Ctx() ctx: TenantContext): Promise<{ data: MyAccessResponse }> {
    return { data: await this.access.execute(ctx) };
  }
}
