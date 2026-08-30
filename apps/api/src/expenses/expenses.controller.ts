import {
  Body, Controller, Delete, Get, Headers, Inject, Param, Patch, Post, Put, Query, UseGuards,
} from '@nestjs/common';
import type { ManageExpensesService, TenantContext } from '@sher/core-application';
import type {
  ExpenseCategoryResponse,
  ExpenseListResponse,
  ExpenseResponse,
} from '@sher/core-contracts';
import {
  AppError,
  ErrorCode,
  correctExpenseRequestSchema,
  recordExpenseRequestSchema,
  saveExpenseCategoryRequestSchema,
  voidDocumentRequestSchema,
} from '@sher/core-contracts';

import { Ctx, TenantContextGuard } from '../auth/tenant-context.guard';
import { MANAGE_EXPENSES_SERVICE } from './tokens';

/**
 * What the shop spends (§5.12). Validate shape → build command → call use case
 * → map result (R-B5). Which account may be paid from, whether the day is open
 * and what the category posts to are all decided in the use case.
 */
@Controller('api/v1/expenses')
@UseGuards(TenantContextGuard)
export class ExpensesController {
  constructor(@Inject(MANAGE_EXPENSES_SERVICE) private readonly expenses: ManageExpensesService) {}

  @Get()
  async list(
    @Query() query: Record<string, string | undefined>,
    @Ctx() ctx: TenantContext,
  ): Promise<ExpenseListResponse> {
    const limit = Number(query['limit'] ?? '20');
    return this.expenses.list(ctx, {
      search: query['search'] ?? null,
      categoryId: query['categoryId'] ?? null,
      fromDate: query['fromDate'] ?? null,
      toDate: query['toDate'] ?? null,
      cursor: query['cursor'] ?? null,
      limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 100) : 20,
    });
  }

  @Post()
  async record(
    @Body() body: unknown,
    @Headers('idempotency-key') operationId: string | undefined,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: ExpenseResponse }> {
    const parsed = recordExpenseRequestSchema.safeParse(body);
    if (!parsed.success) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid expense');
    if (operationId === undefined || operationId.length !== 26) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'An expense needs an operation id');
    }

    const request = parsed.data;
    return {
      data: await this.expenses.record({
        ctx,
        operationId,
        categoryId: request.categoryId,
        amountMinor: request.amountMinor,
        accountCode: request.accountCode,
        payeePartyId: request.payeePartyId,
        note: request.note,
        businessDate: request.businessDate,
        backdateReason: request.backdateReason,
      }),
    };
  }

  /**
   * Correcting a posted expense (Phase 9.2). `PATCH`, because the document
   * keeps its identity and its number — what changes is what it says.
   */
  @Patch(':id')
  async correct(
    @Param('id') id: string,
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: ExpenseResponse }> {
    const parsed = correctExpenseRequestSchema.safeParse(body);
    if (!parsed.success || id.length !== 26) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid correction');
    }
    const request = parsed.data;
    return {
      data: await this.expenses.correct({
        ctx,
        expenseId: id,
        version: request.version,
        reason: request.reason,
        /*
         * A correction is not a new operation: it carries the document's own id
         * where a create would carry an idempotency key, and a repeat is
         * refused by the version rather than replayed.
         */
        operationId: id,
        categoryId: request.categoryId,
        amountMinor: request.amountMinor,
        accountCode: request.accountCode,
        payeePartyId: request.payeePartyId,
        note: request.note,
        ...(request.businessDate === undefined ? {} : { businessDate: request.businessDate }),
        backdateReason: request.backdateReason,
      }),
    };
  }

  /** Cancelling a posted expense. A reason is required (owner rule). */
  @Post(':id/void')
  async void(
    @Param('id') id: string,
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: ExpenseResponse }> {
    const parsed = voidDocumentRequestSchema.safeParse(body);
    if (!parsed.success || id.length !== 26) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'A cancellation needs the document version and a reason');
    }
    return {
      data: await this.expenses.void({
        ctx,
        expenseId: id,
        version: parsed.data.version,
        reason: parsed.data.reason,
      }),
    };
  }

  @Post('categories')

  async addCategory(
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: ExpenseCategoryResponse }> {
    const parsed = saveExpenseCategoryRequestSchema.safeParse(body);
    if (!parsed.success) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid category');
    return { data: await this.expenses.saveCategory({ ctx, categoryId: null, name: parsed.data.name }) };
  }

  @Put('categories/:id')
  async renameCategory(
    @Param('id') id: string,
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: ExpenseCategoryResponse }> {
    const parsed = saveExpenseCategoryRequestSchema.safeParse(body);
    if (!parsed.success) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid category');
    return { data: await this.expenses.saveCategory({ ctx, categoryId: id, name: parsed.data.name }) };
  }

  @Delete('categories/:id')
  async archiveCategory(@Param('id') id: string, @Ctx() ctx: TenantContext): Promise<void> {
    await this.expenses.archiveCategory(ctx, id);
  }
}
