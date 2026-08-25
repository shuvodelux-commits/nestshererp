import { Body, Controller, Get, Headers, Inject, Post, Query, UseGuards } from '@nestjs/common';
import type { StockCountService, TenantContext } from '@sher/core-application';
import type { StockCountResponse } from '@sher/core-contracts';
import { AppError, ErrorCode, postStockCountRequestSchema } from '@sher/core-contracts';

import { Ctx, TenantContextGuard } from '../auth/tenant-context.guard';
import { STOCK_COUNT_SERVICE } from './tokens';

/**
 * Counting the shelf (§5.13). Validate shape → build command → call use case →
 * map result (R-B5). Which lots a shortage consumes, what a surplus comes in
 * at, and whether anything moved while the sheet was open are all decided in
 * the use case.
 */
@Controller('api/v1/stock-counts')
@UseGuards(TenantContextGuard)
export class StockCountsController {
  constructor(@Inject(STOCK_COUNT_SERVICE) private readonly counts: StockCountService) {}

  @Get()
  async list(
    @Query() query: Record<string, string | undefined>,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: readonly StockCountResponse[] }> {
    const limit = Number(query['limit'] ?? '20');
    return { data: await this.counts.list(ctx, Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 50) : 20) };
  }

  @Post()
  async post(
    @Body() body: unknown,
    @Headers('idempotency-key') operationId: string | undefined,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: StockCountResponse }> {
    const parsed = postStockCountRequestSchema.safeParse(body);
    if (!parsed.success) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid count sheet');
    if (operationId === undefined || operationId.length !== 26) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'A count needs an operation id');
    }

    const request = parsed.data;
    return {
      data: await this.counts.post({
        ctx,
        operationId,
        scopeLabel: request.scopeLabel,
        note: request.note,
        lines: request.lines,
        businessDate: request.businessDate,
        backdateReason: request.backdateReason,
        acceptMoved: request.acceptMoved,
      }),
    };
  }
}
