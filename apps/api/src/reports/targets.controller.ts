import { Body, Controller, Get, Inject, Put, Query, UseGuards } from '@nestjs/common';
import type { DashboardResponse, TargetResponse } from '@sher/core-contracts';
import { AppError, ErrorCode, setTargetRequestSchema, targetQuerySchema } from '@sher/core-contracts';
import type { DashboardService, ProfitTargetService, TenantContext } from '@sher/core-application';

import { Ctx, TenantContextGuard } from '../auth/tenant-context.guard';
import { DASHBOARD_SERVICE, PROFIT_TARGET_SERVICE } from './tokens';

/**
 * The monthly target and the dashboard cards (§5.20).
 *
 * `PUT` rather than `POST` for the target: one month has one target, so
 * setting it twice is the same act repeated, not two records — and it needs no
 * idempotency key for exactly that reason.
 */
@Controller('api/v1')
@UseGuards(TenantContextGuard)
export class TargetsController {
  constructor(
    @Inject(PROFIT_TARGET_SERVICE) private readonly targets: ProfitTargetService,
    @Inject(DASHBOARD_SERVICE) private readonly dashboard: DashboardService,
  ) {}

  @Get('reports/target')
  async target(@Query() query: unknown, @Ctx() ctx: TenantContext): Promise<{ data: TargetResponse }> {
    const parsed = targetQuerySchema.safeParse(query);
    if (!parsed.success) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid month');
    return { data: await this.targets.get(ctx, parsed.data.month) };
  }

  @Put('reports/target')
  async setTarget(@Body() body: unknown, @Ctx() ctx: TenantContext): Promise<{ data: TargetResponse }> {
    const parsed = setTargetRequestSchema.safeParse(body);
    if (!parsed.success) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid target');
    return { data: await this.targets.set(ctx, parsed.data) };
  }

  @Get('dashboard/cards')
  async cards(@Ctx() ctx: TenantContext): Promise<{ data: DashboardResponse }> {
    return { data: await this.dashboard.execute(ctx) };
  }
}
