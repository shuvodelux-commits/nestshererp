import { Body, Controller, Get, HttpCode, Inject, Param, Post, UseGuards } from '@nestjs/common';
import type { ChangeTransactionDateService, TenantContext } from '@sher/core-application';
import type {
  ChangeTransactionDateResponse, TransactionDateContext,
} from '@sher/core-contracts';
import { changeTransactionDateRequestSchema, redatableDocumentSchema } from '@sher/core-contracts';

import { Ctx, TenantContextGuard } from '../auth/tenant-context.guard';
import { invalidBody } from '../money/accounts.controller';
import { CHANGE_TRANSACTION_DATE_SERVICE } from './tokens';

/**
 * Change Transaction Date (Phase 11.2, UI-72).
 *
 * **One route, however many screens offer the action.** Daybook, the party and
 * account ledgers and the reconciliation compare screen all post here; none of
 * them has its own endpoint, and none could grow a variant of the rule. That is
 * UI-72 expressed as routing.
 *
 * Validate shape → build command → call use case → map result (R-B5). Who may
 * move a date, which days are reachable, what a closed month costs and whether
 * a payment may precede its bill are all decided in the use case, never here.
 */
@Controller('api/v1/corrections/transaction-date')
@UseGuards(TenantContextGuard)
export class CorrectionsController {
  constructor(
    @Inject(CHANGE_TRANSACTION_DATE_SERVICE)
    private readonly dates: ChangeTransactionDateService,
  ) {}

  /** What the dialog needs before it can ask: the day, the locks, the limits. */
  @Get(':documentType/:documentId')
  async context(
    @Param('documentType') documentType: string,
    @Param('documentId') documentId: string,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: TransactionDateContext }> {
    const parsed = redatableDocumentSchema.safeParse(documentType);
    if (!parsed.success) throw invalidBody(parsed.error.issues);

    return { data: await this.dates.describe(ctx, parsed.data, documentId) };
  }

  @Post()
  @HttpCode(200)
  async change(
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: ChangeTransactionDateResponse }> {
    const parsed = changeTransactionDateRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);

    return { data: await this.dates.change({ ctx, ...parsed.data }) };
  }
}
