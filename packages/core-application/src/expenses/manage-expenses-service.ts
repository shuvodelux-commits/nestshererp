import { parameterisedAccount, rejectEntry } from '@sher/core-domain';
import { AppError, ErrorCode, Permission } from '@sher/core-contracts';
import type {
  ExpenseCategoryResponse,
  ExpenseListResponse,
  ExpenseResponse,
} from '@sher/core-contracts';
import { Ulid } from '@sher/shared-utils';
import type { Clock } from '@sher/shared-utils';

import { entryModeFor } from '../notes/create-note-service';
import type { PartyRepository } from '../parties/party-repository';
import type { AccessControl } from '../ports/access-control';
import type { AuditWriter } from '../ports/audit-writer';
import type { IdempotencyStore } from '../ports/idempotency-store';
import type { MoneyRepository } from '../money/money-repository';
import type { NumberingService } from '../ports/numbering-service';
import type { Outbox } from '../ports/outbox';
import type { PeriodGuard } from '../ports/period-guard';
import type { TenantContext } from '../ports/tenant-context';
import type { Tx, UnitOfWork } from '../ports/unit-of-work';
import { resolvePaymentAccount } from '../purchasing/payment-account';
import type { ExpenseFilter, ExpenseRepository, ExpenseRow } from './expense-repository';

/**
 * Recording what the shop spends (§5.12, Phase 7, owner decisions 2026-08-26).
 *
 * **WRITE CLASS: T** (R-D). One transaction: permission → idempotency → period
 * guard → the category → the account the money left → the document and one
 * journal entry → audit and outbox.
 *
 * **The category is the account.** §2.4 lists `EXPENSE:{cat}`, so rent posts to
 * `EXPENSE:RENT` and "what did we spend on rent" is a balance, not a filter
 * over rows that any later report could compute differently.
 *
 * Cash goes through `resolvePaymentAccount`, the same helper a purchase and a
 * refund use, so an expense on a day nobody started refuses with
 * `CASH_DAY_NOT_STARTED` and the screen can offer to open the day (§5.16.1).
 *
 * A payee is optional and is a **party**, not a name typed twice: salary paid
 * to Belal points at Belal, so his history is one list. The snapshot beside it
 * is what the document keeps saying if the party is later renamed.
 */

export interface RecordExpenseCommand {
  readonly ctx: TenantContext;
  readonly operationId: string;
  readonly categoryId: string;
  readonly amountMinor: number;
  readonly accountCode: string;
  readonly payeePartyId: string | null;
  readonly note: string | null;
  readonly businessDate?: string | undefined;
  readonly backdateReason: string | null;
}

export interface SaveCategoryCommand {
  readonly ctx: TenantContext;
  readonly categoryId: string | null;
  readonly name: string;
}

export class ManageExpensesService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly access: AccessControl,
    private readonly idempotency: IdempotencyStore,
    private readonly periods: PeriodGuard,
    private readonly parties: PartyRepository,
    private readonly money: MoneyRepository,
    private readonly expenses: ExpenseRepository,
    private readonly numbering: NumberingService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly clock: Clock,
  ) {}

  async record(command: RecordExpenseCommand): Promise<ExpenseResponse> {
    const fingerprint = JSON.stringify([
      command.categoryId,
      command.amountMinor,
      command.accountCode,
      command.payeePartyId,
      command.businessDate ?? null,
    ]);

    return this.uow.run(command.ctx, async (tx) => {
      const { ctx } = command;
      await this.access.require(tx, ctx, Permission.EXPENSE_RECORD);

      const replay = await this.idempotency.find(tx, ctx, command.operationId);
      if (replay !== null) {
        if (replay.requestFingerprint !== fingerprint) {
          throw new AppError(
            ErrorCode.IDEMPOTENCY_KEY_REUSED,
            'This operation id was already used for a different expense',
          );
        }
        return replay.response as ExpenseResponse;
      }
      const posted = await this.expenses.findExpenseIdByOperationId(tx, ctx, command.operationId);
      if (posted !== null) return this.detail(tx, ctx, posted);

      if (command.amountMinor <= 0) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'An expense must be more than zero');
      }

      const today = this.clock.businessDate(ctx.timezone);
      const businessDate = command.businessDate ?? today;
      const backdateReason = await this.guardDate(
        tx,
        ctx,
        businessDate,
        today,
        command.backdateReason,
      );

      const category = await this.expenses.findCategoryById(tx, ctx, command.categoryId);
      if (category === null) throw new AppError(ErrorCode.NOT_FOUND, 'That category was not found');
      if (category.status !== 'ACTIVE') {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'That category is archived');
      }

      const account = await resolvePaymentAccount(
        { access: this.access, money: this.money },
        tx,
        ctx,
        command.accountCode,
        businessDate,
      );

      let payeeName: string | null = null;
      if (command.payeePartyId !== null) {
        const payee = await this.parties.findById(tx, ctx, command.payeePartyId);
        if (payee === null) throw new AppError(ErrorCode.NOT_FOUND, 'That payee was not found');
        payeeName = payee.name;
      }

      /*
       * Two lines and nothing else: the money left an account the shop can
       * count, and it became a cost under the name the shop files it under.
       * The payee rides on the expense line, so a party's history can show what
       * was paid to them without a second document type.
       */
      const journal = {
        lines: [
          {
            account: parameterisedAccount('EXPENSE', category.code),
            amountMinor: command.amountMinor,
            partyId: command.payeePartyId,
          },
          { account: account.code, amountMinor: -command.amountMinor, partyId: null },
        ],
      };
      if (rejectEntry(journal) !== null) {
        throw new AppError(ErrorCode.INTERNAL_ERROR, 'This expense does not balance');
      }

      const expenseId = Ulid.generate(this.clock);
      const number = await this.numbering.allocate(
        tx,
        ctx,
        'EXPENSE',
        Number(businessDate.slice(0, 4)),
      );

      await this.expenses.insertExpense(tx, ctx, {
        id: expenseId,
        number,
        categoryId: category.id,
        categoryCode: category.code,
        categoryName: category.name,
        payeePartyId: command.payeePartyId,
        payeeName,
        amountMinor: command.amountMinor,
        accountCode: account.code,
        sessionId: account.sessionId,
        note: command.note,
        businessDate,
        entryMode: entryModeFor(businessDate, today),
        backdateReason,
        operationId: command.operationId,
        journalEntryId: Ulid.generate(this.clock),
        journalLines: journal.lines.map((line) => ({
          id: Ulid.generate(this.clock),
          account: line.account,
          amountMinor: line.amountMinor,
          partyId: line.partyId,
        })),
      });

      await this.audit.append(tx, ctx, {
        entityType: 'expense',
        entityId: expenseId,
        action: 'CREATE',
        before: null,
        after: {
          number,
          category: category.name,
          amountMinor: String(command.amountMinor),
          account: account.name,
          businessDate,
        },
        source: 'API',
      });
      await this.outbox.append(tx, ctx, {
        eventType: 'expense.recorded',
        aggregateType: 'expense',
        aggregateId: expenseId,
        payload: { number, categoryCode: category.code, amountMinor: command.amountMinor },
      });

      const response = await this.detail(tx, ctx, expenseId);
      await this.idempotency.save(tx, ctx, {
        operationId: command.operationId,
        requestFingerprint: fingerprint,
        response,
      });
      return response;
    });
  }

  async list(ctx: TenantContext, filter: ExpenseFilter): Promise<ExpenseListResponse> {
    return this.uow.run(ctx, async (tx) => {
      await this.access.require(tx, ctx, Permission.EXPENSE_VIEW);
      const page = await this.expenses.listExpenses(tx, ctx, filter);
      const categories = await this.expenses.listCategories(tx, ctx, {
        fromDate: filter.fromDate,
        toDate: filter.toDate,
      });
      return {
        expenses: page.expenses.map(toExpenseResponse),
        nextCursor: page.nextCursor,
        totalMinor: page.totalMinor,
        categories: categories.map((category) => ({
          id: category.id,
          code: category.code,
          name: category.name,
          isSystem: category.isSystem,
          status: category.status,
          spentMinor: category.spentMinor,
        })),
      };
    });
  }

  /**
   * Adding or renaming a category.
   *
   * The **code is derived once, from the first name, and never changes**: it is
   * half an account code, and moving it would strand every rupee already posted
   * under the old one on an account no screen reads.
   */
  async saveCategory(command: SaveCategoryCommand): Promise<ExpenseCategoryResponse> {
    return this.uow.run(command.ctx, async (tx) => {
      const { ctx } = command;
      await this.access.require(tx, ctx, Permission.EXPENSE_RECORD);
      const name = command.name.trim();
      if (name.length < 2) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'Give the category a name');
      }

      if (command.categoryId !== null) {
        const existing = await this.expenses.findCategoryById(tx, ctx, command.categoryId);
        if (existing === null) throw new AppError(ErrorCode.NOT_FOUND, 'That category was not found');
        await this.expenses.renameCategory(tx, ctx, existing.id, name);
        await this.audit.append(tx, ctx, {
          entityType: 'expense_category',
          entityId: existing.id,
          action: 'UPDATE',
          before: { name: existing.name },
          after: { name },
          source: 'API',
        });
        return { ...existing, name };
      }

      const code = codeFor(name);
      if ((await this.expenses.findCategoryByCode(tx, ctx, code)) !== null) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'A category with that name already exists');
      }

      const id = Ulid.generate(this.clock);
      await this.expenses.insertCategory(tx, ctx, { id, code, name });
      await this.audit.append(tx, ctx, {
        entityType: 'expense_category',
        entityId: id,
        action: 'CREATE',
        before: null,
        after: { code, name },
        source: 'API',
      });
      return { id, code, name, isSystem: false, status: 'ACTIVE', spentMinor: 0 };
    });
  }

  async archiveCategory(ctx: TenantContext, categoryId: string): Promise<void> {
    return this.uow.run(ctx, async (tx) => {
      await this.access.require(tx, ctx, Permission.EXPENSE_RECORD);
      const existing = await this.expenses.findCategoryById(tx, ctx, categoryId);
      if (existing === null) throw new AppError(ErrorCode.NOT_FOUND, 'That category was not found');
      await this.expenses.archiveCategory(tx, ctx, categoryId);
      await this.audit.append(tx, ctx, {
        entityType: 'expense_category',
        entityId: categoryId,
        action: 'UPDATE',
        before: { status: existing.status },
        after: { status: 'ARCHIVED' },
        source: 'API',
      });
    });
  }

  /** Today needs nothing; an earlier date needs the permission and a reason. */
  private async guardDate(
    tx: Tx,
    ctx: TenantContext,
    businessDate: string,
    today: string,
    reason: string | null,
  ): Promise<string | null> {
    if (businessDate > today) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'An expense cannot be dated in the future');
    }
    if (businessDate !== today) {
      await this.access.require(tx, ctx, Permission.PERIOD_BACKDATE);
      if (reason === null || reason.trim() === '') {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'Say why this expense is being entered on an earlier date',
        );
      }
    }
    await this.periods.assertOpen(tx, ctx, businessDate);
    return businessDate === today ? null : reason;
  }

  private async detail(tx: Tx, ctx: TenantContext, expenseId: string): Promise<ExpenseResponse> {
    const row = await this.expenses.findExpenseById(tx, ctx, expenseId);
    if (row === null) throw new AppError(ErrorCode.NOT_FOUND, 'Expense not found');
    return toExpenseResponse(row);
  }
}

export function toExpenseResponse(row: ExpenseRow): ExpenseResponse {
  return {
    id: row.id,
    number: row.number,
    categoryId: row.categoryId,
    categoryName: row.categoryName,
    payeePartyId: row.payeePartyId,
    payeeName: row.payeeName,
    amountMinor: row.amountMinor,
    accountCode: row.accountCode,
    accountName: row.accountName,
    note: row.note,
    businessDate: row.businessDate,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * A durable code from the first name — `Tea & snacks` → `TEA_SNACKS`.
 *
 * The same shape a role code takes, and constrained to what an account segment
 * accepts, because this one becomes `EXPENSE:TEA_SNACKS` the moment anything
 * posts to it.
 */
function codeFor(name: string): string {
  const slug = name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug === '' ? 'OTHER' : slug.slice(0, 40);
}
