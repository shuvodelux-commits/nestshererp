import {
  Body, Controller, Get, Inject, Param, Patch, Post, Query, UseGuards,
} from '@nestjs/common';
import type {
  CashMovementService,
  CashSessionService,
  DailyCashService,
  MoneyMovementsService,
  TenantContext,
} from '@sher/core-application';
import type {
  CashMovementResponse,
  CashSessionResponse,
  DailyCashResponse,
  DayStatusResponse,
  MoneyMovementListResponse,
} from '@sher/core-contracts';
import {
  closeDayRequestSchema,
  correctCashMovementRequestSchema,
  dailyCashQuerySchema,
  moneyMovementListQuerySchema,
  recordCashMovementRequestSchema,
  reopenDayRequestSchema,
  startDayRequestSchema,
  voidDocumentRequestSchema,
} from '@sher/core-contracts';

import { Ctx, TenantContextGuard } from '../auth/tenant-context.guard';
import { invalidBody } from './accounts.controller';
import {
  CASH_MOVEMENT_SERVICE,
  CASH_SESSION_SERVICE,
  DAILY_CASH_SERVICE,
  MONEY_MOVEMENTS_SERVICE,
} from './tokens';

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
    @Inject(MONEY_MOVEMENTS_SERVICE) private readonly movementHistory: MoneyMovementsService,
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

  /**
   * What the shop has moved — the Transfer Money list, both Capital & Loans
   * sections and the Overview's recent list, by `group` (Finance module).
   */
  @Get('movements')
  async listMovements(
    @Query() query: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<MoneyMovementListResponse> {
    const parsed = moneyMovementListQuerySchema.safeParse(query);
    if (!parsed.success) throw invalidBody(parsed.error.issues);

    return this.movementHistory.list({ ctx, ...parsed.data });
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

  /**
   * Correcting a posted movement (Phase 9.2). `PATCH`, because the movement
   * keeps its identity and its number; what changes is what it says.
   */
  @Patch('movements/:id')
  async correctMovement(
    @Param('id') id: string,
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: { ok: true } }> {
    const parsed = correctCashMovementRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);
    await this.movements.correct({ ctx, movementId: id, operationId: id, ...parsed.data });
    return { data: { ok: true } };
  }

  /** Cancelling a posted movement. A reason is required (owner rule). */
  @Post('movements/:id/void')
  async voidMovement(
    @Param('id') id: string,
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: { ok: true } }> {
    const parsed = voidDocumentRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);
    await this.movements.void({ ctx, movementId: id, ...parsed.data });
    return { data: { ok: true } };
  }
}

