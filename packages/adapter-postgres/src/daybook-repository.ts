import type {
  DaybookDayTotals, DaybookEntryRow, DaybookFilter, DaybookPrintRow, DaybookRepository,
  DaybookReviewRow, NewDaybookPrint, NewDaybookReview, TenantContext, Tx,
} from '@sher/core-application';
import { parseInstant } from '@sher/shared-utils';
import type { Clock } from '@sher/shared-utils';
import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';

import { daybookPrints } from './schema';
import { txOf } from './unit-of-work';

/**
 * Reading a day out of the ledger (§5.27).
 *
 * **One row on screen is one journal entry**, with its lines folded into the
 * three figures a person actually reads: how big it was, what it did to cash,
 * and which account it touched. Reading each module's own document tables
 * instead would let the daybook disagree with the ledger — which is what
 * INV-10 forbids and what gate G4 tests by requiring the daybook's totals to
 * equal the reports'.
 *
 * The document's status is joined back in per source type, because "cancelled"
 * is a fact about the sale, not about the entry that recorded it — and a
 * cancelled document must still be **shown**, struck through, with its
 * reversal linked (DR4). Hiding it is how a day's paper stops matching the
 * screen.
 */

function int(value: unknown): number {
  if (value === null || value === undefined) return 0;
  return typeof value === 'number' ? Math.round(value) : Math.round(Number(value));
}

/**
 * `created_at` comes back as a string from a raw statement and as a `Date`
 * from the query builder, so every instant is normalised in one place. The
 * parse goes through `shared-utils`, the only file allowed to touch `Date`
 * (R-C8).
 */
function instant(value: unknown): Date {
  if (value instanceof Date) return value;
  return parseInstant(typeof value === 'string' ? value : null) ?? EPOCH;
}

const EPOCH = parseInstant('1970-01-01T00:00:00.000Z') as Date;

/** Source types grouped as the kind filter names them (see `daybook-kinds.ts`). */
const SOURCE_TYPES_BY_KIND: Readonly<Record<string, readonly string[]>> = {
  SALE: ['SALE', 'SALE_CANCELLATION'],
  SALES_RETURN: ['SALES_RETURN'],
  PURCHASE: ['PURCHASE', 'PURCHASE_REVERSAL', 'PURCHASE_LANDED_COST'],
  PURCHASE_RETURN: ['PURCHASE_RETURN'],
  CUSTOMER_RECEIPT: ['CUSTOMER_RECEIPT'],
  SUPPLIER_PAYMENT: ['SUPPLIER_PAYMENT'],
  EXPENSE: ['EXPENSE'],
  CASH_MOVEMENT: ['CASH_MOVEMENT'],
  STOCK_ADJUSTMENT: ['STOCK_ADJUSTMENT'],
  STOCK_COUNT: ['STOCK_COUNT'],
  OPENING: [
    'OPENING_STOCK', 'OPENING_BALANCE', 'OPENING_BALANCE_CORRECTION',
    'ACCOUNT_OPENING', 'ACCOUNT_OPENING_CORRECTION',
  ],
  DAY_CLOSE: ['CASH_SESSION_CLOSE', 'CASH_SESSION_REOPEN'],
  WARRANTY: ['WARRANTY_CLAIM'],
  VENDOR_STOCK: ['VENDOR_STOCK_RECEIPT', 'VENDOR_STOCK_RETURN'],
};

/**
 * One entry, folded.
 *
 * `amount_minor` is the entry's size — the sum of its debits, which for a
 * balanced entry (INV-01) is what the document came to. `cash_effect_minor` is
 * what it did to cash and bank only, signed, and is what the day's money
 * summary adds up. `account_code` is the money account it moved, where exactly
 * one was involved; an entry touching two (a transfer) reports neither, and
 * the description carries it instead.
 */
const ENTRY_SELECT = sql`
  SELECT je.id AS id,
         je.source_document_type AS source_type,
         je.source_document_id AS source_id,
         je.source_number AS source_number,
         je.business_date::text AS business_date,
         je.created_at AS created_at,
         je.created_by AS created_by,
         COALESCE(u.display_name, u.username, '') AS created_by_name,
         je.entry_mode AS entry_mode,
         party.party_id AS party_id,
         pa.name AS party_name,
         money.account_code AS account_code,
         acct.name AS account_label,
         COALESCE(size.total, 0)::text AS amount_minor,
         COALESCE(money.effect, 0)::text AS cash_effect_minor,
         moved.qty::text AS qty,
         doc.status AS document_status,
         doc.version AS document_version,
         reversal.source_number AS reversed_by_number,
         redate.original_business_date::text AS original_business_date,
         redate.correction_reason AS correction_reason,
         note.text AS note
    FROM journal_entries je
    LEFT JOIN users u ON u.tenant_id = je.tenant_id AND u.id = je.created_by
    LEFT JOIN LATERAL (
      SELECT SUM(jl.amount_minor) AS total
        FROM journal_lines jl
       WHERE jl.tenant_id = je.tenant_id AND jl.journal_entry_id = je.id AND jl.amount_minor > 0
    ) size ON TRUE
    LEFT JOIN LATERAL (
      SELECT SUM(jl.amount_minor) AS effect,
             CASE WHEN COUNT(DISTINCT jl.account_code) = 1 THEN MIN(jl.account_code) END AS account_code
        FROM journal_lines jl
       WHERE jl.tenant_id = je.tenant_id AND jl.journal_entry_id = je.id
         AND (jl.account_code LIKE 'CASH:%' OR jl.account_code LIKE 'BANK:%')
    ) money ON TRUE
    LEFT JOIN LATERAL (
      SELECT jl.party_id
        FROM journal_lines jl
       WHERE jl.tenant_id = je.tenant_id AND jl.journal_entry_id = je.id AND jl.party_id IS NOT NULL
       LIMIT 1
    ) party ON TRUE
    LEFT JOIN parties pa ON pa.tenant_id = je.tenant_id AND pa.id = party.party_id
    LEFT JOIN accounts acct ON acct.tenant_id = je.tenant_id
         AND money.account_code = (CASE WHEN acct.type = 'CASH' THEN 'CASH:'
                                        WHEN acct.type = 'LOAN' THEN 'LOAN:'
                                        ELSE 'BANK:' END || acct.id)
    LEFT JOIN LATERAL (
      SELECT SUM(sm.qty) AS qty
        FROM stock_movements sm
       WHERE sm.tenant_id = je.tenant_id AND sm.source_document_id = je.source_document_id
    ) moved ON TRUE
    /*
     * The document's own status and version, from the module that owns it.
     * "Cancelled" is a fact about the sale, not about the entry that recorded
     * it — and the version is what a cancellation started from this screen
     * carries, so two people undoing the same thing cannot both succeed (D-32).
     */
    LEFT JOIN LATERAL (
      SELECT CASE je.source_document_type
               WHEN 'SALE' THEN (SELECT s.status FROM sales s WHERE s.tenant_id = je.tenant_id AND s.id = je.source_document_id)
               WHEN 'PURCHASE' THEN (SELECT p.status FROM purchases p WHERE p.tenant_id = je.tenant_id AND p.id = je.source_document_id)
               WHEN 'CUSTOMER_RECEIPT' THEN (SELECT r.status FROM customer_receipts r WHERE r.tenant_id = je.tenant_id AND r.id = je.source_document_id)
               WHEN 'SUPPLIER_PAYMENT' THEN (SELECT sp.status FROM supplier_payments sp WHERE sp.tenant_id = je.tenant_id AND sp.id = je.source_document_id)
               WHEN 'EXPENSE' THEN (SELECT e.status FROM expenses e WHERE e.tenant_id = je.tenant_id AND e.id = je.source_document_id)
               WHEN 'CASH_MOVEMENT' THEN (SELECT cm.status FROM cash_movements cm WHERE cm.tenant_id = je.tenant_id AND cm.id = je.source_document_id)
               WHEN 'STOCK_ADJUSTMENT' THEN (SELECT sa.status FROM stock_adjustments sa WHERE sa.tenant_id = je.tenant_id AND sa.id = je.source_document_id)
               WHEN 'SALES_RETURN' THEN (SELECT sr.status FROM sales_returns sr WHERE sr.tenant_id = je.tenant_id AND sr.id = je.source_document_id)
               WHEN 'PURCHASE_RETURN' THEN (SELECT pr.status FROM purchase_returns pr WHERE pr.tenant_id = je.tenant_id AND pr.id = je.source_document_id)
               ELSE NULL
             END AS status,
             CASE je.source_document_type
               WHEN 'SALE' THEN (SELECT s.version FROM sales s WHERE s.tenant_id = je.tenant_id AND s.id = je.source_document_id)
               WHEN 'PURCHASE' THEN (SELECT p.version FROM purchases p WHERE p.tenant_id = je.tenant_id AND p.id = je.source_document_id)
               WHEN 'CUSTOMER_RECEIPT' THEN (SELECT r.version FROM customer_receipts r WHERE r.tenant_id = je.tenant_id AND r.id = je.source_document_id)
               WHEN 'SUPPLIER_PAYMENT' THEN (SELECT sp.version FROM supplier_payments sp WHERE sp.tenant_id = je.tenant_id AND sp.id = je.source_document_id)
               WHEN 'EXPENSE' THEN (SELECT e.version FROM expenses e WHERE e.tenant_id = je.tenant_id AND e.id = je.source_document_id)
               WHEN 'CASH_MOVEMENT' THEN (SELECT cm.version FROM cash_movements cm WHERE cm.tenant_id = je.tenant_id AND cm.id = je.source_document_id)
               WHEN 'STOCK_ADJUSTMENT' THEN (SELECT sa.version FROM stock_adjustments sa WHERE sa.tenant_id = je.tenant_id AND sa.id = je.source_document_id)
               WHEN 'SALES_RETURN' THEN (SELECT sr.version FROM sales_returns sr WHERE sr.tenant_id = je.tenant_id AND sr.id = je.source_document_id)
               WHEN 'PURCHASE_RETURN' THEN (SELECT pr.version FROM purchase_returns pr WHERE pr.tenant_id = je.tenant_id AND pr.id = je.source_document_id)
               ELSE NULL
             END AS version
    ) doc ON TRUE
    LEFT JOIN LATERAL (
      SELECT rev.source_number
        FROM journal_entries rev
       WHERE rev.tenant_id = je.tenant_id
         AND rev.source_document_id = je.source_document_id
         AND rev.id <> je.id
         AND rev.source_document_type IN ('SALE_CANCELLATION', 'PURCHASE_REVERSAL')
       ORDER BY rev.created_at DESC
       LIMIT 1
    ) reversal ON TRUE
    LEFT JOIN LATERAL (
      SELECT CASE je.source_document_type
               WHEN 'EXPENSE' THEN (SELECT e.note FROM expenses e WHERE e.tenant_id = je.tenant_id AND e.id = je.source_document_id)
               WHEN 'CASH_MOVEMENT' THEN (SELECT cm.note FROM cash_movements cm WHERE cm.tenant_id = je.tenant_id AND cm.id = je.source_document_id)
               ELSE NULL
             END AS text
    ) note ON TRUE
    /*
     * Phase 11.2 — what the CORRECTED badge opens into. A document that has
     * been corrected or moved to another day keeps the day it came from and the
     * reason somebody gave, so the row can say *moved from 12 Aug* instead of
     * only that something was corrected. The four money vouchers are the only
     * documents a date can be changed on, so they are the only ones asked.
     */
    LEFT JOIN LATERAL (
      SELECT CASE je.source_document_type
               WHEN 'CUSTOMER_RECEIPT' THEN (SELECT r.original_business_date FROM customer_receipts r WHERE r.tenant_id = je.tenant_id AND r.id = je.source_document_id)
               WHEN 'SUPPLIER_PAYMENT' THEN (SELECT sp.original_business_date FROM supplier_payments sp WHERE sp.tenant_id = je.tenant_id AND sp.id = je.source_document_id)
               WHEN 'EXPENSE' THEN (SELECT e.original_business_date FROM expenses e WHERE e.tenant_id = je.tenant_id AND e.id = je.source_document_id)
               WHEN 'CASH_MOVEMENT' THEN (SELECT cm.original_business_date FROM cash_movements cm WHERE cm.tenant_id = je.tenant_id AND cm.id = je.source_document_id)
               ELSE NULL
             END AS original_business_date,
             CASE je.source_document_type
               WHEN 'CUSTOMER_RECEIPT' THEN (SELECT r.correction_reason FROM customer_receipts r WHERE r.tenant_id = je.tenant_id AND r.id = je.source_document_id)
               WHEN 'SUPPLIER_PAYMENT' THEN (SELECT sp.correction_reason FROM supplier_payments sp WHERE sp.tenant_id = je.tenant_id AND sp.id = je.source_document_id)
               WHEN 'EXPENSE' THEN (SELECT e.correction_reason FROM expenses e WHERE e.tenant_id = je.tenant_id AND e.id = je.source_document_id)
               WHEN 'CASH_MOVEMENT' THEN (SELECT cm.correction_reason FROM cash_movements cm WHERE cm.tenant_id = je.tenant_id AND cm.id = je.source_document_id)
               ELSE NULL
             END AS correction_reason
    ) redate ON TRUE
`;

interface EntryRecord extends Record<string, unknown> {
  id: string; source_type: string; source_id: string; source_number: string;
  business_date: string; created_at: Date; created_by: string; created_by_name: string;
  entry_mode: string; party_id: string | null; party_name: string | null;
  document_version: number | null;
  account_code: string | null; account_label: string | null;
  amount_minor: string; cash_effect_minor: string;
  qty: string | null; document_status: string | null; reversed_by_number: string | null;
  original_business_date: string | null; correction_reason: string | null;
  note: string | null;
}

function toRow(row: EntryRecord): DaybookEntryRow {
  return {
    id: row.id.trim(),
    sourceType: row.source_type,
    sourceId: row.source_id.trim(),
    sourceNumber: row.source_number,
    businessDate: row.business_date,
    createdAt: instant(row.created_at),
    createdBy: row.created_by.trim(),
    createdByName: row.created_by_name,
    partyId: row.party_id === null ? null : row.party_id.trim(),
    partyName: row.party_name,
    accountCode: row.account_code,
    accountLabel: row.account_label,
    amountMinor: int(row.amount_minor),
    cashEffectMinor: int(row.cash_effect_minor),
    entryMode: row.entry_mode,
    documentStatus: row.document_status,
    documentVersion: row.document_version,
    reversedByNumber: row.reversed_by_number,
    originalBusinessDate: row.original_business_date,
    correctionReason: row.correction_reason,
    qty: row.qty === null ? null : int(row.qty),
    note: row.note,
  };
}

export class PostgresDaybookRepository implements DaybookRepository {
  constructor(private readonly clock: Clock) {}

  async listEntries(
    tx: Tx,
    ctx: TenantContext,
    filter: DaybookFilter,
  ): Promise<readonly DaybookEntryRow[]> {
    /*
     * DR2 — Transaction Date mode orders by `business_date, created_at, id`
     * and Entry Date mode by `created_at, id`. Both are stable and
     * reproducible, which is what makes a printed page and the screen agree,
     * and what makes keyset paging correct rather than merely fast.
     */
    const range =
      filter.dateBasis === 'BUSINESS_DATE'
        ? sql`je.business_date BETWEEN ${filter.from} AND ${filter.to}`
        : sql`je.created_at >= ${filter.from}::date AND je.created_at < (${filter.to}::date + 1)`;

    const rows = await txOf(tx).execute<EntryRecord>(sql`
      ${ENTRY_SELECT}
       WHERE je.tenant_id = ${ctx.tenantId}
         AND ${range}
         AND ${conditions(filter)}
         AND ${cursorCondition(filter)}
       ORDER BY ${
         filter.dateBasis === 'BUSINESS_DATE'
           ? sql`je.business_date DESC, je.created_at DESC, je.id DESC`
           : sql`je.created_at DESC, je.id DESC`
       }
       LIMIT ${filter.limit}
    `);
    return rows.rows.map(toRow);
  }

  async listBackdated(
    tx: Tx,
    ctx: TenantContext,
    filter: DaybookFilter,
  ): Promise<readonly DaybookEntryRow[]> {
    /*
     * DR7, both halves: entries **dated** inside the range but typed outside
     * it, and entries **typed** inside the range that belong outside it.
     * Without this section a printed day-end report can be silently
     * invalidated by an entry somebody adds afterwards.
     */
    const rows = await txOf(tx).execute<EntryRecord>(sql`
      ${ENTRY_SELECT}
       WHERE je.tenant_id = ${ctx.tenantId}
         AND ${conditions(filter)}
         AND (
           (je.business_date BETWEEN ${filter.from} AND ${filter.to}
             AND (je.created_at < ${filter.from}::date OR je.created_at >= (${filter.to}::date + 1)))
           OR
           (je.created_at >= ${filter.from}::date AND je.created_at < (${filter.to}::date + 1)
             AND (je.business_date < ${filter.from} OR je.business_date > ${filter.to}))
         )
       ORDER BY je.business_date DESC, je.created_at DESC, je.id DESC
       LIMIT ${filter.limit}
    `);
    return rows.rows.map(toRow);
  }

  async dayTotals(
    tx: Tx,
    ctx: TenantContext,
    from: string,
    to: string,
    userId: string | null,
  ): Promise<readonly DaybookDayTotals[]> {
    /*
     * The section totals under the day's summary, from the accounts rather
     * than from each module's tables — so the daybook and the reports cannot
     * disagree about what a day came to (G4).
     */
    const mine = userId === null ? sql`TRUE` : sql`je.created_by = ${userId}`;
    const rows = await txOf(tx).execute<{
      business_date: string; sales: string; purchases: string; receipts: string;
      payments: string; expenses: string; returns: string; count: string;
    }>(sql`
      SELECT je.business_date::text AS business_date,
             COALESCE(SUM(CASE WHEN je.source_document_type = 'SALE' AND jl.account_code = 'SALES' THEN -jl.amount_minor ELSE 0 END), 0)::text AS sales,
             COALESCE(SUM(CASE WHEN je.source_document_type = 'PURCHASE' AND jl.account_code = 'INVENTORY' THEN jl.amount_minor ELSE 0 END), 0)::text AS purchases,
             COALESCE(SUM(CASE WHEN je.source_document_type = 'CUSTOMER_RECEIPT' AND (jl.account_code LIKE 'CASH:%' OR jl.account_code LIKE 'BANK:%') THEN jl.amount_minor ELSE 0 END), 0)::text AS receipts,
             COALESCE(SUM(CASE WHEN je.source_document_type = 'SUPPLIER_PAYMENT' AND (jl.account_code LIKE 'CASH:%' OR jl.account_code LIKE 'BANK:%') THEN -jl.amount_minor ELSE 0 END), 0)::text AS payments,
             COALESCE(SUM(CASE WHEN jl.account_code LIKE 'EXPENSE:%' THEN jl.amount_minor ELSE 0 END), 0)::text AS expenses,
             COALESCE(SUM(CASE WHEN je.source_document_type IN ('SALES_RETURN', 'PURCHASE_RETURN') AND jl.account_code = 'SALES' THEN jl.amount_minor ELSE 0 END), 0)::text AS returns,
             COUNT(DISTINCT je.id)::text AS count
        FROM journal_entries je
        JOIN journal_lines jl ON jl.tenant_id = je.tenant_id AND jl.journal_entry_id = je.id
       WHERE je.tenant_id = ${ctx.tenantId}
         AND je.business_date BETWEEN ${from} AND ${to}
         AND ${mine}
       GROUP BY je.business_date
       ORDER BY je.business_date DESC
    `);

    return rows.rows.map((row) => ({
      businessDate: row.business_date,
      salesMinor: int(row.sales),
      purchasesMinor: int(row.purchases),
      receiptsMinor: int(row.receipts),
      paymentsMinor: int(row.payments),
      expensesMinor: int(row.expenses),
      returnsMinor: int(row.returns),
      transactionCount: int(row.count),
    }));
  }

  async listReviews(
    tx: Tx,
    ctx: TenantContext,
    from: string,
    to: string,
  ): Promise<readonly DaybookReviewRow[]> {
    const rows = await txOf(tx).execute<{
      business_date: string; reviewed_at: Date; reviewed_by_name: string; note: string | null;
    }>(sql`
      SELECT m.business_date::text AS business_date, m.reviewed_at,
             COALESCE(u.display_name, u.username, '') AS reviewed_by_name, m.note
        FROM daybook_review_marks m
        LEFT JOIN users u ON u.tenant_id = m.tenant_id AND u.id = m.reviewed_by
       WHERE m.tenant_id = ${ctx.tenantId}
         AND m.business_date BETWEEN ${from} AND ${to}
    `);
    return rows.rows.map((row) => ({
      businessDate: row.business_date,
      reviewedAt: instant(row.reviewed_at),
      reviewedByName: row.reviewed_by_name,
      note: row.note,
    }));
  }

  async findReview(
    tx: Tx,
    ctx: TenantContext,
    businessDate: string,
  ): Promise<DaybookReviewRow | null> {
    const rows = await this.listReviews(tx, ctx, businessDate, businessDate);
    return rows[0] ?? null;
  }

  async saveReview(tx: Tx, ctx: TenantContext, review: NewDaybookReview): Promise<void> {
    // A day looked at twice is still a day looked at: the later review replaces
    // the earlier one rather than queueing behind it.
    await txOf(tx).execute(sql`
      INSERT INTO daybook_review_marks (
        id, tenant_id, business_date, reviewed_at, reviewed_by, note,
        created_at, updated_at, created_by, updated_by, version
      ) VALUES (
        ${review.id}, ${ctx.tenantId}, ${review.businessDate}, NOW(), ${ctx.userId}, ${review.note},
        NOW(), NOW(), ${ctx.userId}, ${ctx.userId}, 1
      )
      ON CONFLICT (tenant_id, business_date) DO UPDATE
        SET reviewed_at = NOW(),
            reviewed_by = EXCLUDED.reviewed_by,
            note = EXCLUDED.note,
            updated_at = NOW(),
            updated_by = EXCLUDED.updated_by,
            version = daybook_review_marks.version + 1
    `);
  }

  async insertPrint(
    tx: Tx,
    ctx: TenantContext,
    print: NewDaybookPrint,
  ): Promise<DaybookPrintRow> {
    const db = txOf(tx);
    // The serial is the number on the paper. Taken inside the same transaction
    // as the row, so two people printing at once cannot be handed one number.
    const next = await db.execute<{ serial: string }>(sql`
      SELECT COALESCE(MAX(p.print_serial), 0) + 1 AS serial
        FROM daybook_prints p
       WHERE p.tenant_id = ${ctx.tenantId}
    `);
    const printSerial = int(next.rows[0]?.serial) || 1;

    await db.insert(daybookPrints).values({
      id: print.id,
      tenantId: ctx.tenantId,
      fromDate: print.from,
      toDate: print.to,
      format: print.format,
      printSerial,
      printedAt: this.clock.now(),
      printedBy: ctx.userId,
      openingCashMinor: print.openingCashMinor,
      closingCashMinor: print.closingCashMinor,
      transactionCount: print.transactionCount,
      totalsJson: print.totals,
      reprintOfId: print.reprintOfId,
    });

    const saved = await this.findPrint(tx, ctx, print.id);
    if (saved === null) throw new Error('daybook print vanished after insert');
    return saved;
  }

  async findPrint(tx: Tx, ctx: TenantContext, id: string): Promise<DaybookPrintRow | null> {
    const rows = await this.readPrints(tx, ctx, sql`p.id = ${id}`, 1);
    return rows[0] ?? null;
  }

  async listPrints(
    tx: Tx,
    ctx: TenantContext,
    limit: number,
  ): Promise<readonly DaybookPrintRow[]> {
    return this.readPrints(tx, ctx, undefined, limit);
  }

  private async readPrints(
    tx: Tx,
    ctx: TenantContext,
    criterion: SQL | undefined,
    limit: number,
  ): Promise<DaybookPrintRow[]> {
    const rows = await txOf(tx).execute<{
      id: string; from_date: string; to_date: string; format: string; print_serial: number;
      printed_at: Date; printed_by_name: string; opening_cash_minor: string;
      closing_cash_minor: string; transaction_count: number; totals_json: Record<string, number>;
      reprint_of_id: string | null;
    }>(sql`
      SELECT p.id, p.from_date::text AS from_date, p.to_date::text AS to_date, p.format,
             p.print_serial, p.printed_at,
             COALESCE(u.display_name, u.username, '') AS printed_by_name,
             p.opening_cash_minor::text AS opening_cash_minor,
             p.closing_cash_minor::text AS closing_cash_minor,
             p.transaction_count, p.totals_json, p.reprint_of_id
        FROM daybook_prints p
        LEFT JOIN users u ON u.tenant_id = p.tenant_id AND u.id = p.printed_by
       WHERE p.tenant_id = ${ctx.tenantId}
         AND ${criterion === undefined ? sql`TRUE` : criterion}
       ORDER BY p.printed_at DESC
       LIMIT ${limit}
    `);

    return rows.rows.map((row) => ({
      id: row.id.trim(),
      from: row.from_date,
      to: row.to_date,
      format: row.format === 'THERMAL_80' ? 'THERMAL_80' : 'A4',
      printSerial: row.print_serial,
      printedAt: instant(row.printed_at),
      printedByName: row.printed_by_name,
      openingCashMinor: int(row.opening_cash_minor),
      closingCashMinor: int(row.closing_cash_minor),
      transactionCount: row.transaction_count,
      totals: row.totals_json,
      reprintOfId: row.reprint_of_id === null ? null : row.reprint_of_id.trim(),
    }));
  }
}

function conditions(filter: DaybookFilter): SQL {
  const parts: SQL[] = [];
  if (filter.kind !== null) {
    const types = SOURCE_TYPES_BY_KIND[filter.kind] ?? [];
    parts.push(
      types.length === 0
        ? sql`TRUE`
        : sql`je.source_document_type IN (${sql.join(types.map((type) => sql`${type}`), sql`, `)})`,
    );
  }
  if (filter.userId !== null) parts.push(sql`je.created_by = ${filter.userId}`);
  if (filter.partyId !== null) {
    parts.push(sql`EXISTS (
      SELECT 1 FROM journal_lines jl2
       WHERE jl2.tenant_id = je.tenant_id AND jl2.journal_entry_id = je.id
         AND jl2.party_id = ${filter.partyId}
    )`);
  }
  if (filter.accountCode !== null) {
    parts.push(sql`EXISTS (
      SELECT 1 FROM journal_lines jl3
       WHERE jl3.tenant_id = je.tenant_id AND jl3.journal_entry_id = je.id
         AND jl3.account_code = ${filter.accountCode}
    )`);
  }
  return parts.length === 0 ? sql`TRUE` : sql.join(parts, sql` AND `);
}

/** Keyset paging: everything after the last id we handed out (§3.9, no OFFSET). */
function cursorCondition(filter: DaybookFilter): SQL {
  if (filter.cursor === null) return sql`TRUE`;
  return sql`je.id < ${filter.cursor}`;
}
