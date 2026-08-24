import { Body, Controller, Get, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import type {
  CashMovementService,
  CashSessionService,
  DailyCashService,
  TenantContext,
} from '@sher/core-application';
import type {
  CashMovementResponse,
  CashSessionResponse,
  DailyCashResponse,
  DayStatusResponse,
} from '@sher/core-contracts';
import {
  closeDayRequestSchema,
  dailyCashQuerySchema,
  recordCashMovementRequestSchema,
  reopenDayRequestSchema,
  startDayRequestSchema,
} from '@sher/core-contracts';

import { Ctx, TenantContextGuard } from '../auth/tenant-context.guard';
import { invalidBody } from './accounts.controller';
import { CASH_MOVEMENT_SERVICE, CASH_SESSION_SERVICE, DAILY_CASH_SERVICE } from './tokens';

/**
 * The business day at the drawer (Phase 4, §5.16).
 *
 * `GET /day` is the one the day chip calls from every screen, so it is
 * deliberately a single round trip carrying everything the chip decides with:
 * whether the shop tracks a drawer, whether a day is open, which earlier day is
 * blocking a new one, and whether this user may still undo today's close.
 */
@Controller('api/v1/money')
@UseGuards(TenantContextGuard)
export class CashSessionsController {
  constructor(
    @Inject(CASH_SESSION_SERVICE) private readonly sessions: CashSessionService,
    @Inject(CASH_MOVEMENT_SERVICE) private readonly movements: CashMovementService,
    @Inject(DAILY_CASH_SERVICE) private readonly daily: DailyCashService,
  ) {}

  @Get('day')
  async day(@Ctx() ctx: TenantContext): Promise<DayStatusResponse> {
    return this.sessions.status({ ctx });
  }

  @Get('daily-cash')
  async history(@Query() query: unknown, @Ctx() ctx: TenantContext): Promise<DailyCashResponse> {
    const parsed = dailyCashQuerySchema.safeParse(query);
    if (!parsed.success) throw invalidBody(parsed.error.issues);

    return this.daily.history({ ctx, ...parsed.data });
  }

  @Post('day/start')
  async start(
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: CashSessionResponse }> {
    const parsed = startDayRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);

    return { data: await this.sessions.startDay({ ctx, ...parsed.data }) };
  }

  @Post('day/:id/close')
  async close(
    @Param('id') id: string,
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: CashSessionResponse }> {
    const parsed = closeDayRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);

    return { data: await this.sessions.closeDay({ ctx, sessionId: id, ...parsed.data }) };
  }

  /** `ভুল করে বন্ধ করেছি` — undoing today's close (§5.16.4, 2026-08-24). */
  @Post('day/:id/reopen')
  async reopen(
    @Param('id') id: string,
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: CashSessionResponse }> {
    const parsed = reopenDayRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);

    return { data: await this.sessions.reopenDay({ ctx, sessionId: id, ...parsed.data }) };
  }

  @Post('movements')
  async record(
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: CashMovementResponse }> {
    const parsed = recordCashMovementRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);

    return { data: await this.movements.record({ ctx, ...parsed.data }) };
  }
}
