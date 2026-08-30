import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import type {
  MoneyReportResponse, PerformanceResponse, PurchaseReportResponse, SalesReportResponse,
  StockReportResponse, WhyResponse,
} from '@sher/core-contracts';
import {
  AppError, ErrorCode, moneyReportQuerySchema, performanceQuerySchema, purchaseReportQuerySchema,
  salesReportQuerySchema, stockReportQuerySchema, whyQuerySchema,
} from '@sher/core-contracts';
import type { ReportQueryService, TenantContext } from '@sher/core-application';

import { Ctx, TenantContextGuard } from '../auth/tenant-context.guard';
import { REPORT_QUERY_SERVICE } from './tokens';

/** §5.20's four screens and the "Why?" drill-down. Reads only. */
@Controller('api/v1/reports')
@UseGuards(TenantContextGuard)
export class ReportsController {
  constructor(@Inject(REPORT_QUERY_SERVICE) private readonly reports: ReportQueryService) {}

  @Get('sales')
  async sales(@Query() query: unknown, @Ctx() ctx: TenantContext): Promise<{ data: SalesReportResponse }> {
    const parsed = salesReportQuerySchema.safeParse(query);
    if (!parsed.success) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid sales report query');
    return { data: await this.reports.sales(ctx, parsed.data) };
  }

  @Get('purchases')
  async purchases(@Query() query: unknown, @Ctx() ctx: TenantContext): Promise<{ data: PurchaseReportResponse }> {
    const parsed = purchaseReportQuerySchema.safeParse(query);
    if (!parsed.success) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid purchase report query');
    return { data: await this.reports.purchases(ctx, parsed.data) };
  }

  @Get('stock')
  async stock(@Query() query: unknown, @Ctx() ctx: TenantContext): Promise<{ data: StockReportResponse }> {
    const parsed = stockReportQuerySchema.safeParse(query);
    if (!parsed.success) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid stock report query');
    return { data: await this.reports.stock(ctx, parsed.data) };
  }

  @Get('money')
  async money(@Query() query: unknown, @Ctx() ctx: TenantContext): Promise<{ data: MoneyReportResponse }> {
    const parsed = moneyReportQuerySchema.safeParse(query);
    if (!parsed.success) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid money report query');
    return { data: await this.reports.money(ctx, parsed.data) };
  }

  @Get('performance')
  async performance(@Query() query: unknown, @Ctx() ctx: TenantContext): Promise<{ data: PerformanceResponse }> {
    const parsed = performanceQuerySchema.safeParse(query);
    if (!parsed.success) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid performance query');
    return { data: await this.reports.performance(ctx, parsed.data) };
  }

  @Get('why')
  async why(@Query() query: unknown, @Ctx() ctx: TenantContext): Promise<{ data: WhyResponse }> {
    const parsed = whyQuerySchema.safeParse(query);
    if (!parsed.success) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid drill-down query');
    return { data: await this.reports.why(ctx, parsed.data) };
  }
}
