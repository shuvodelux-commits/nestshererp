import { Body, Controller, Get, Inject, Post, UseGuards } from '@nestjs/common';
import type { ManagePeriodsService, TenantContext } from '@sher/core-application';
import type { PeriodListResponse, PeriodResponse } from '@sher/core-contracts';
import { AppError, closePeriodRequestSchema, ErrorCode } from '@sher/core-contracts';

import { Ctx, TenantContextGuard } from '../auth/tenant-context.guard';
import { MANAGE_PERIODS_SERVICE } from './tokens';

/**
 * Closing a month (§5.19, D-25). There is no unlock endpoint, deliberately: the
 * owner's decision is that a closed month is final, and an endpoint nobody may
 * call is still a door.
 */
@Controller('api/v1/periods')
@UseGuards(TenantContextGuard)
export class PeriodsController {
  constructor(@Inject(MANAGE_PERIODS_SERVICE) private readonly periods: ManagePeriodsService) {}

  @Get()
  async list(@Ctx() ctx: TenantContext): Promise<PeriodListResponse> {
    return this.periods.list(ctx);
  }

  @Post('close')
  async close(@Body() body: unknown, @Ctx() ctx: TenantContext): Promise<{ data: PeriodResponse }> {
    const parsed = closePeriodRequestSchema.safeParse(body);
    if (!parsed.success) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid month');
    return {
      data: await this.periods.close({
        ctx,
        year: parsed.data.year,
        month: parsed.data.month,
        note: parsed.data.note,
      }),
    };
  }
}
