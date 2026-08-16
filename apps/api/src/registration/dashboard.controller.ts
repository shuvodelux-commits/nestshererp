import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import type { GetDashboardSummaryService, TenantContext } from '@sher/core-application';
import type { DashboardSummaryResponse } from '@sher/core-contracts';

import { Ctx, TenantContextGuard } from '../auth/tenant-context.guard';
import { GET_DASHBOARD_SUMMARY_SERVICE } from './tokens';

/** What the dashboard can honestly show after slice 1.1 — the business you are in. */
@Controller('api/v1/dashboard')
@UseGuards(TenantContextGuard)
export class DashboardController {
  constructor(
    @Inject(GET_DASHBOARD_SUMMARY_SERVICE) private readonly summary: GetDashboardSummaryService,
  ) {}

  @Get('summary')
  async get(@Ctx() ctx: TenantContext): Promise<{ data: DashboardSummaryResponse }> {
    return { data: await this.summary.execute(ctx) };
  }
}
