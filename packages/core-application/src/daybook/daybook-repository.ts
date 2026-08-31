import type { DaybookKind } from '@sher/core-contracts';

import type { TenantContext } from '../ports/tenant-context';
import type { Tx } from '../ports/unit-of-work';

/**
 * What Daybook reads (§5.27).
 *
 * **The reading model is the journal, not the modules' own tables** — rows
 * come from `journal_entries` and `journal_lines` ordered by
 * `business_date, created_at, id`, unioned with the `stock_movements` that
 * produce no journal entry. Reading each module's document tables would let
 * Daybook disagree with the ledger, which is exactly what INV-10 forbids and
 * what gate G4 tests: Daybook's totals must equal the Reports' totals.
 *
 * There is **no write method for a business document here, and there must
 * never be one** (DR1). The only writes are Daybook's own two facts: that a
 * day was reviewed, and that a day was printed.
 */

export interface DaybookFilter {
  readonly from: string;
  readonly to: string;
  readonly dateBasis: 'BUSINESS_DATE' | 'CREATED_AT';
  readonly kind: DaybookKind | null;
  readonly partyId: string | null;
  readonly userId: string | null;
  readonly accountCode: string | null;
  readonly cursor: string | null;
  readonly limit: number;
}

export interface DaybookEntryRow {
  readonly id: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly sourceNumber: string;
  readonly businessDate: string;
  readonly createdAt: Date;
  readonly createdBy: string;
  readonly createdByName: string;
  readonly partyId: string | null;
  readonly partyName: string | null;
  /** The account the money went to or came from, where one account dominates. */
  readonly accountCode: string | null;
  /** That account's own name, so a row reads "Cash Drawer" and not a code. */
  readonly accountLabel: string | null;
  /** Absolute size of the entry — the largest debit, which is its total. */
  readonly amountMinor: number;
  /** What this entry did to cash and bank accounts, signed: in (+), out (−). */
  readonly cashEffectMinor: number;
  readonly entryMode: string;
  /**
   * Phase 11.2 — the day the document sat on before it was last moved, and why.
   * Null on one that has never been corrected or re-dated.
   */
  readonly originalBusinessDate: string | null;
  readonly correctionReason: string | null;
  /** The document's own status, read from the module that owns it. */
  readonly documentStatus: string | null;
  /** The owning document's version, for the optimistic lock on a cancellation. */
  readonly documentVersion: number | null;
  readonly reversedByNumber: string | null;
  readonly qty: number | null;
  readonly note: string | null;
}

export interface DaybookDayTotals {
  readonly businessDate: string;
  readonly salesMinor: number;
  readonly purchasesMinor: number;
  readonly receiptsMinor: number;
  readonly paymentsMinor: number;
  readonly expensesMinor: number;
  readonly returnsMinor: number;
  readonly transactionCount: number;
}

export interface DaybookReviewRow {
  readonly businessDate: string;
  readonly reviewedAt: Date;
  readonly reviewedByName: string;
  readonly note: string | null;
}

export interface NewDaybookReview {
  readonly id: string;
  readonly businessDate: string;
  readonly note: string | null;
}

export interface NewDaybookPrint {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly format: 'A4' | 'THERMAL_80';
  readonly openingCashMinor: number;
  readonly closingCashMinor: number;
  readonly transactionCount: number;
  readonly totals: Record<string, number>;
  readonly reprintOfId: string | null;
}

export interface DaybookPrintRow {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly format: 'A4' | 'THERMAL_80';
  readonly printSerial: number;
  readonly printedAt: Date;
  readonly printedByName: string;
  readonly openingCashMinor: number;
  readonly closingCashMinor: number;
  readonly transactionCount: number;
  readonly totals: Record<string, number>;
  readonly reprintOfId: string | null;
}

export interface DaybookRepository {
  listEntries(tx: Tx, ctx: TenantContext, filter: DaybookFilter): Promise<readonly DaybookEntryRow[]>;

  /**
   * DR7 — entries dated inside the range but recorded outside it, and entries
   * recorded inside it but dated outside. Without this section a printed day
   * can be silently invalidated by a later backdated entry.
   */
  listBackdated(
    tx: Tx,
    ctx: TenantContext,
    filter: DaybookFilter,
  ): Promise<readonly DaybookEntryRow[]>;

  dayTotals(
    tx: Tx,
    ctx: TenantContext,
    from: string,
    to: string,
    userId: string | null,
  ): Promise<readonly DaybookDayTotals[]>;

  listReviews(
    tx: Tx,
    ctx: TenantContext,
    from: string,
    to: string,
  ): Promise<readonly DaybookReviewRow[]>;

  saveReview(tx: Tx, ctx: TenantContext, review: NewDaybookReview): Promise<void>;
  findReview(tx: Tx, ctx: TenantContext, businessDate: string): Promise<DaybookReviewRow | null>;

  insertPrint(tx: Tx, ctx: TenantContext, print: NewDaybookPrint): Promise<DaybookPrintRow>;
  findPrint(tx: Tx, ctx: TenantContext, id: string): Promise<DaybookPrintRow | null>;
  listPrints(tx: Tx, ctx: TenantContext, limit: number): Promise<readonly DaybookPrintRow[]>;
}
