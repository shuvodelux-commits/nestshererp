import type {
  ExpenseCategoryRow,
  ExpenseFilter,
  ExpenseRepository,
  ExpenseRow,
  NewExpense,
  NewExpenseCategory,
  TenantContext,
  Tx,
} from '@sher/core-application';
import type { Clock } from '@sher/shared-utils';
import { and, asc, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';

import {
  accounts,
  expenseCategories,
  expenses,
  journalEntries,
  journalLines,
  parties,
} from './schema';
import { txOf } from './unit-of-work';

/**
 * Expenses over PostgreSQL. No business rule lives here (R-B6).
 *
 * A category's spend is summed **in the same statement as the category row**,
 * over the same date range the list is showing — so the tiles, the manager and
 * the table are three readings of one expression rather than three numbers that
 * can drift.
 */
function spentMinor(range: {
  readonly fromDate: string | null;
  readonly toDate: string | null;
}): SQL<number> {
  const from = range.fromDate === null ? sql`TRUE` : sql`e.business_date >= ${range.fromDate}`;
  const to = range.toDate === null ? sql`TRUE` : sql`e.business_date <= ${range.toDate}`;
  return sql<number>`COALESCE((
    SELECT SUM(e.amount_minor)
      FROM expenses e
     WHERE e.category_id = ${expenseCategories.id}
       AND e.status = 'POSTED'
       AND e.deleted_at IS NULL
       AND ${from}
       AND ${to}
  ), 0)::bigint`;
}

export class PostgresExpenseRepository implements ExpenseRepository {
  constructor(private readonly clock: Clock) {}

  async listCategories(
    tx: Tx,
    ctx: TenantContext,
    range: { readonly fromDate: string | null; readonly toDate: string | null },
  ): Promise<readonly ExpenseCategoryRow[]> {
    const rows = await txOf(tx)
      .select({
        id: expenseCategories.id,
        code: expenseCategories.code,
        name: expenseCategories.name,
        isSystem: expenseCategories.isSystem,
        status: expenseCategories.status,
        spentMinor: spentMinor(range),
      })
      .from(expenseCategories)
      .where(
        and(eq(expenseCategories.tenantId, ctx.tenantId), isNull(expenseCategories.deletedAt)),
      )
      .orderBy(asc(expenseCategories.name));

    return rows.map(toCategory);
  }

  async findCategoryById(
    tx: Tx,
    ctx: TenantContext,
    categoryId: string,
  ): Promise<ExpenseCategoryRow | null> {
    const rows = await txOf(tx)
      .select({
        id: expenseCategories.id,
        code: expenseCategories.code,
        name: expenseCategories.name,
        isSystem: expenseCategories.isSystem,
        status: expenseCategories.status,
        spentMinor: spentMinor({ fromDate: null, toDate: null }),
      })
      .from(expenseCategories)
      .where(
        and(
          eq(expenseCategories.tenantId, ctx.tenantId),
          eq(expenseCategories.id, categoryId),
          isNull(expenseCategories.deletedAt),
        ),
      )
      .limit(1);

    const row = rows[0];
    return row === undefined ? null : toCategory(row);
  }

  async findCategoryByCode(
    tx: Tx,
    ctx: TenantContext,
    code: string,
  ): Promise<ExpenseCategoryRow | null> {
    const rows = await txOf(tx)
      .select({
        id: expenseCategories.id,
        code: expenseCategories.code,
        name: expenseCategories.name,
        isSystem: expenseCategories.isSystem,
        status: expenseCategories.status,
        spentMinor: spentMinor({ fromDate: null, toDate: null }),
      })
      .from(expenseCategories)
      .where(
        and(
          eq(expenseCategories.tenantId, ctx.tenantId),
          eq(expenseCategories.code, code),
          isNull(expenseCategories.deletedAt),
        ),
      )
      .limit(1);

    const row = rows[0];
    return row === undefined ? null : toCategory(row);
  }

  async insertCategory(tx: Tx, ctx: TenantContext, category: NewExpenseCategory): Promise<void> {
    const now = this.clock.now();
    await txOf(tx).insert(expenseCategories).values({
      id: category.id,
      tenantId: ctx.tenantId,
      code: category.code,
      name: category.name,
      isSystem: false,
      status: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
      version: 1,
    });
  }

  async renameCategory(
    tx: Tx,
    ctx: TenantContext,
    categoryId: string,
    name: string,
  ): Promise<void> {
    const now = this.clock.now();
    await txOf(tx)
      .update(expenseCategories)
      .set({
        name,
        updatedAt: now,
        updatedBy: ctx.userId,
        version: sql`${expenseCategories.version} + 1`,
      })
      .where(
        and(eq(expenseCategories.tenantId, ctx.tenantId), eq(expenseCategories.id, categoryId)),
      );
  }

  /** Archived, never deleted: posted history keeps pointing at it (§3.6). */
  async archiveCategory(tx: Tx, ctx: TenantContext, categoryId: string): Promise<void> {
    const now = this.clock.now();
    await txOf(tx)
      .update(expenseCategories)
      .set({
        status: 'ARCHIVED',
        updatedAt: now,
        updatedBy: ctx.userId,
        version: sql`${expenseCategories.version} + 1`,
      })
      .where(
        and(eq(expenseCategories.tenantId, ctx.tenantId), eq(expenseCategories.id, categoryId)),
      );
  }

  async insertExpense(tx: Tx, ctx: TenantContext, expense: NewExpense): Promise<void> {
    const db = txOf(tx);
    const now = this.clock.now();

    await db.insert(expenses).values({
      id: expense.id,
      tenantId: ctx.tenantId,
      expenseNumber: expense.number,
      categoryId: expense.categoryId,
      categoryCodeSnapshot: expense.categoryCode,
      categoryNameSnapshot: expense.categoryName,
      payeePartyId: expense.payeePartyId,
      payeeNameSnapshot: expense.payeeName,
      amountMinor: expense.amountMinor,
      accountCode: expense.accountCode,
      sessionId: expense.sessionId,
      note: expense.note,
      businessDate: expense.businessDate,
      entryMode: expense.entryMode,
      backdateReason: expense.backdateReason,
      status: 'POSTED',
      operationId: expense.operationId,
      createdAt: now,
      updatedAt: now,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
      version: 1,
    });

    await db.insert(journalEntries).values({
      id: expense.journalEntryId,
      tenantId: ctx.tenantId,
      createdAt: now,
      createdBy: ctx.userId,
      businessDate: expense.businessDate,
      sourceDocumentType: 'EXPENSE',
      sourceDocumentId: expense.id,
      sourceNumber: expense.number,
      entryMode: expense.entryMode,
    });

    for (const line of expense.journalLines) {
      await db.insert(journalLines).values({
        id: line.id,
        tenantId: ctx.tenantId,
        createdAt: now,
        createdBy: ctx.userId,
        journalEntryId: expense.journalEntryId,
        accountCode: line.account,
        amountMinor: line.amountMinor,
        partyId: line.partyId,
      });
    }
  }

  async findExpenseById(
    tx: Tx,
    ctx: TenantContext,
    expenseId: string,
  ): Promise<ExpenseRow | null> {
    const rows = await this.readExpenses(tx, ctx, [eq(expenses.id, expenseId)], 1);
    return rows[0] ?? null;
  }

  async findExpenseIdByOperationId(
    tx: Tx,
    ctx: TenantContext,
    operationId: string,
  ): Promise<string | null> {
    const rows = await txOf(tx)
      .select({ id: expenses.id })
      .from(expenses)
      .where(and(eq(expenses.tenantId, ctx.tenantId), eq(expenses.operationId, operationId)))
      .limit(1);
    return rows[0]?.id.trim() ?? null;
  }

  async listExpenses(
    tx: Tx,
    ctx: TenantContext,
    filter: ExpenseFilter,
  ): Promise<{
    readonly expenses: readonly ExpenseRow[];
    readonly nextCursor: string | null;
    readonly totalMinor: number;
  }> {
    const conditions: SQL[] = [];
    if (filter.categoryId !== null) conditions.push(eq(expenses.categoryId, filter.categoryId));
    if (filter.fromDate !== null) {
      conditions.push(sql`${expenses.businessDate} >= ${filter.fromDate}`);
    }
    if (filter.toDate !== null) conditions.push(sql`${expenses.businessDate} <= ${filter.toDate}`);
    if (filter.search !== null && filter.search.trim() !== '') {
      const term = `%${filter.search.trim().toLowerCase()}%`;
      conditions.push(
        sql`(LOWER(${expenses.expenseNumber}) LIKE ${term}
          OR LOWER(${expenses.categoryNameSnapshot}) LIKE ${term}
          OR LOWER(COALESCE(${expenses.payeeNameSnapshot}, '')) LIKE ${term}
          OR LOWER(COALESCE(${expenses.note}, '')) LIKE ${term})`,
      );
    }
    if (filter.cursor !== null) conditions.push(lt(expenses.id, filter.cursor));

    const totals = await txOf(tx)
      .select({ total: sql<number>`COALESCE(SUM(${expenses.amountMinor}), 0)::bigint` })
      .from(expenses)
      .where(
        and(
          eq(expenses.tenantId, ctx.tenantId),
          eq(expenses.status, 'POSTED'),
          isNull(expenses.deletedAt),
          ...conditions,
        ),
      );

    const rows = await this.readExpenses(tx, ctx, conditions, filter.limit + 1);
    const hasMore = rows.length > filter.limit;
    const page = hasMore ? rows.slice(0, filter.limit) : rows;

    return {
      expenses: page,
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
      totalMinor: Number(totals[0]?.total ?? 0),
    };
  }

  private async readExpenses(
    tx: Tx,
    ctx: TenantContext,
    conditions: readonly SQL[],
    limit: number,
  ): Promise<readonly ExpenseRow[]> {
    const rows = await txOf(tx)
      .select({
        id: expenses.id,
        number: expenses.expenseNumber,
        categoryId: expenses.categoryId,
        categoryName: expenses.categoryNameSnapshot,
        payeePartyId: expenses.payeePartyId,
        payeeName: expenses.payeeNameSnapshot,
        amountMinor: expenses.amountMinor,
        accountCode: expenses.accountCode,
        accountName: accounts.name,
        note: expenses.note,
        businessDate: expenses.businessDate,
        status: expenses.status,
        createdAt: expenses.createdAt,
      })
      .from(expenses)
      .leftJoin(
        accounts,
        sql`${accounts.id} = SUBSTRING(${expenses.accountCode} FROM POSITION(':' IN ${expenses.accountCode}) + 1)`,
      )
      .where(and(eq(expenses.tenantId, ctx.tenantId), isNull(expenses.deletedAt), ...conditions))
      .orderBy(desc(expenses.businessDate), desc(expenses.id))
      .limit(limit);

    return rows.map((row) => ({
      id: row.id.trim(),
      number: row.number,
      categoryId: row.categoryId.trim(),
      categoryName: row.categoryName,
      payeePartyId: row.payeePartyId === null ? null : row.payeePartyId.trim(),
      payeeName: row.payeeName,
      amountMinor: Number(row.amountMinor),
      accountCode: row.accountCode,
      accountName: row.accountName,
      note: row.note,
      businessDate: row.businessDate,
      status: row.status === 'VOIDED' ? 'VOIDED' : 'POSTED',
      createdAt: row.createdAt,
    }));
  }
}

function toCategory(row: {
  id: string;
  code: string;
  name: string;
  isSystem: boolean;
  status: string;
  spentMinor: number;
}): ExpenseCategoryRow {
  return {
    id: row.id.trim(),
    code: row.code,
    name: row.name,
    isSystem: row.isSystem,
    status: row.status === 'ARCHIVED' ? 'ARCHIVED' : 'ACTIVE',
    spentMinor: Number(row.spentMinor),
  };
}
