import type { TenantContext } from '../ports/tenant-context';
import type { Tx } from '../ports/unit-of-work';

/**
 * What the shop spends (§5.12, Phase 7).
 *
 * Nothing here totals anything the journal already knows: a category's spend is
 * summed from the expenses in the range being shown, in the same query as the
 * rows, so a tile and its table cannot disagree.
 */

export interface ExpenseCategoryRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly isSystem: boolean;
  readonly status: 'ACTIVE' | 'ARCHIVED';
  readonly spentMinor: number;
}

export interface NewExpenseCategory {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

export interface NewExpense {
  readonly id: string;
  readonly number: string;
  readonly categoryId: string;
  readonly categoryCode: string;
  readonly categoryName: string;
  readonly payeePartyId: string | null;
  readonly payeeName: string | null;
  readonly amountMinor: number;
  readonly accountCode: string;
  readonly sessionId: string | null;
  readonly note: string | null;
  readonly businessDate: string;
  readonly entryMode: string;
  readonly backdateReason: string | null;
  readonly operationId: string;
  readonly journalEntryId: string;
  readonly journalLines: readonly {
    readonly id: string;
    readonly account: string;
    readonly amountMinor: number;
    readonly partyId: string | null;
  }[];
}

export interface ExpenseRow {
  readonly id: string;
  readonly number: string;
  readonly categoryId: string;
  readonly categoryName: string;
  readonly payeePartyId: string | null;
  readonly payeeName: string | null;
  readonly amountMinor: number;
  readonly accountCode: string;
  readonly accountName: string | null;
  readonly note: string | null;
  readonly businessDate: string;
  readonly status: 'POSTED' | 'VOIDED';
  /** `ON_TIME`, `BACKDATED`, `CORRECTED` or `PRIOR_PERIOD` (Phase 9.2). */
  readonly entryMode: string;
  readonly voidReason: string | null;
  readonly correctionReason: string | null;
  readonly originalBusinessDate: string | null;
  readonly version: number;
  readonly createdAt: Date;
}

/**
 * Re-posting a corrected expense **under its own number** (Phase 9.2).
 *
 * The document row is updated in place and a fresh journal entry is written;
 * the reversal of the original was posted moments earlier in the same
 * transaction, so the ledger holds all three facts — what was posted, that it
 * was taken back, and what it became (§2.5). The columns show the corrected
 * figures because the journal, not the row, is the history.
 */
export interface RepostExpense {
  readonly id: string;
  readonly expectedVersion: number;
  readonly categoryId: string;
  readonly categoryCode: string;
  readonly categoryName: string;
  readonly payeePartyId: string | null;
  readonly payeeName: string | null;
  readonly amountMinor: number;
  readonly accountCode: string;
  readonly sessionId: string | null;
  readonly note: string | null;
  readonly businessDate: string;
  readonly entryMode: string;
  readonly correctionReason: string | null;
  readonly originalBusinessDate: string | null;
  readonly journalEntryId: string;
  readonly journalLines: readonly {
    readonly id: string;
    readonly account: string;
    readonly amountMinor: number;
    readonly partyId: string | null;
  }[];
}

export interface ExpenseFilter {
  readonly search: string | null;
  readonly categoryId: string | null;
  readonly fromDate: string | null;
  readonly toDate: string | null;
  readonly cursor: string | null;
  readonly limit: number;
}

export interface ExpenseRepository {
  listCategories(
    tx: Tx,
    ctx: TenantContext,
    range: { readonly fromDate: string | null; readonly toDate: string | null },
  ): Promise<readonly ExpenseCategoryRow[]>;
  findCategoryById(
    tx: Tx,
    ctx: TenantContext,
    categoryId: string,
  ): Promise<ExpenseCategoryRow | null>;
  insertCategory(tx: Tx, ctx: TenantContext, category: NewExpenseCategory): Promise<void>;
  renameCategory(tx: Tx, ctx: TenantContext, categoryId: string, name: string): Promise<void>;
  /** Archived rather than deleted: history keeps pointing at it (§3.6). */
  archiveCategory(tx: Tx, ctx: TenantContext, categoryId: string): Promise<void>;
  findCategoryByCode(tx: Tx, ctx: TenantContext, code: string): Promise<ExpenseCategoryRow | null>;

  insertExpense(tx: Tx, ctx: TenantContext, expense: NewExpense): Promise<void>;
  /** Returns false when somebody else changed the expense first (D-32). */
  repostExpense(tx: Tx, ctx: TenantContext, expense: RepostExpense): Promise<boolean>;
  findExpenseById(tx: Tx, ctx: TenantContext, expenseId: string): Promise<ExpenseRow | null>;
  findExpenseIdByOperationId(
    tx: Tx,
    ctx: TenantContext,
    operationId: string,
  ): Promise<string | null>;
  listExpenses(
    tx: Tx,
    ctx: TenantContext,
    filter: ExpenseFilter,
  ): Promise<{
    readonly expenses: readonly ExpenseRow[];
    readonly nextCursor: string | null;
    readonly totalMinor: number;
  }>;
}
