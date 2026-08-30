import { Body, Controller, Get, HttpCode, Inject, Post, Query, UseGuards } from '@nestjs/common';
import type {
  DaybookPrint, DaybookResponse, DayReview,
} from '@sher/core-contracts';
import {
  AppError, daybookPrintRequestSchema, daybookQuerySchema, ErrorCode,
  markDayReviewedRequestSchema,
} from '@sher/core-contracts';
import type {
  GetDaybookService, MarkDayReviewedService, PrintDaybookService, TenantContext,
} from '@sher/core-application';

import { Ctx, TenantContextGuard } from '../auth/tenant-context.guard';
import { GET_DAYBOOK_SERVICE, MARK_DAY_REVIEWED_SERVICE, PRINT_DAYBOOK_SERVICE } from './tokens';

/**
 * Daybook (§5.27). Four endpoints, and **not one of them mutates a business
 * document** — a correction launched from a daybook row goes to the owning
 * module's own endpoint, carrying that module's own permission.
 */
@Controller('api/v1/daybook')
@UseGuards(TenantContextGuard)
export class DaybookController {
  constructor(
    @Inject(GET_DAYBOOK_SERVICE) private readonly daybook: GetDaybookService,
    @Inject(MARK_DAY_REVIEWED_SERVICE) private readonly reviews: MarkDayReviewedService,
    @Inject(PRINT_DAYBOOK_SERVICE) private readonly prints: PrintDaybookService,
  ) {}

  @Get()
  async list(@Query() query: unknown, @Ctx() ctx: TenantContext): Promise<{ data: DaybookResponse }> {
    const parsed = daybookQuerySchema.safeParse(query);
    if (!parsed.success) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid daybook query');
    return { data: await this.daybook.execute(ctx, parsed.data) };
  }

  @Post('review') @HttpCode(200)
  async review(@Body() body: unknown, @Ctx() ctx: TenantContext): Promise<{ data: DayReview }> {
    const parsed = markDayReviewedRequestSchema.safeParse(body);
    if (!parsed.success) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid review');
    return { data: await this.reviews.execute(ctx, parsed.data) };
  }

  @Post('print') @HttpCode(201)
  async print(
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: { print: DaybookPrint; daybook: DaybookResponse } }> {
    const parsed = daybookPrintRequestSchema.safeParse(body);
    if (!parsed.success) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid print request');
    return { data: await this.prints.execute(ctx, parsed.data) };
  }

  @Get('prints')
  async history(@Ctx() ctx: TenantContext): Promise<{ data: readonly DaybookPrint[] }> {
    return { data: await this.prints.history(ctx, 50) };
  }
}
