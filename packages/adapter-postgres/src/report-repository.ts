import type {
  AccountMovementRow, DashboardFigures, DashboardSale, GroupedAmountRow, PartyLedgerEntry,
  ProductPerformanceRow, ProfitFigures, PurchaseGrouping, ReportPeriod, ReportRepository,
  SalesGrouping, SaveTargetInput, StoredTarget, TenantContext, Tx, WhySourceLine,
} from '@sher/core-application';
import { parseInstant } from '@sher/shared-utils';
import { and, eq, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';

import { profitTargets } from './schema';
import { txOf } from './unit-of-work';

/**
 * Reading the ledger for the report screens (§5.20).
 *
 * **Every amount here comes from `journal_lines`.** The sign convention is the
 * one the posting kernel writes: a debit is positive and a credit negative, so
 * `SALES` and `AP` hold negative balances while `AR`, `COGS` and `INVENTORY`
 * hold positive ones. Each query flips the sign once, where a figure becomes
 * something a shopkeeper reads, and never twice.
 *
 * **Where documents are read, and why that is still INV-10.** The journal has
 * no product, brand or category column: a `SALES` credit records what was
 * earned, not what was sold. The groupings that need those dimensions read the
 * sale and purchase lines that *produced* those journal lines, and the totals
 * remain comparable to the account they came from. A split that does not add
 * up to the ledger is a posting bug, and reading both is how it becomes
 * visible instead of invisible.
 *
 * Raw SQL rather than the query builder for the aggregates: these are GROUP BY
 * statements over three or four tables, and the builder's shape would obscure
 * exactly the arithmetic that has to stay reviewable. Every one is
 * tenant-scoped explicitly **and** runs under RLS.
 */

/** Postgres returns bigint and numeric as strings — never let one reach arithmetic. */
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

const EMPTY_ROW = { count: 0, qty: 0, amountMinor: 0, costMinor: 0, paidMinor: 0, dueMinor: 0 };

/** A money account's journal code, rebuilt the way `accountCodeFor` builds it. */
const ACCOUNT_CODE = sql`(CASE WHEN a.type = 'CASH' THEN 'CASH:'
  WHEN a.type = 'LOAN' THEN 'LOAN:' ELSE 'BANK:' END || a.id)`;

export class PostgresReportRepository implements ReportRepository {
  async salesGrouped(
    tx: Tx,
    ctx: TenantContext,
    period: ReportPeriod,
    groupBy: SalesGrouping,
    limit: number,
  ): Promise<readonly GroupedAmountRow[]> {
    const db = txOf(tx);

    if (groupBy === 'DATE') {
      /*
       * Straight off the accounts: revenue is what `SALES` moved and cost is
       * what `COGS` moved, so a day on this report carries the same figure the
       * profit statement and the daybook show — which is what gate G4 tests.
       * Returns and cancellations are included because they moved those same
       * accounts; the result is net sales, not gross.
       */
      const rows = await db.execute<{
        key: string; count: string; amount: string; cost: string;
      }>(sql`
        SELECT je.business_date::text AS key,
               COUNT(DISTINCT je.id)::text AS count,
               COALESCE(SUM(CASE WHEN jl.account_code = 'SALES' THEN -jl.amount_minor ELSE 0 END), 0)::text AS amount,
               COALESCE(SUM(CASE WHEN jl.account_code = 'COGS' THEN jl.amount_minor ELSE 0 END), 0)::text AS cost
          FROM journal_entries je
          JOIN journal_lines jl ON jl.tenant_id = je.tenant_id AND jl.journal_entry_id = je.id
         WHERE je.tenant_id = ${ctx.tenantId}
           AND je.business_date BETWEEN ${period.from} AND ${period.to}
           AND jl.account_code IN ('SALES', 'COGS')
         GROUP BY je.business_date
         ORDER BY je.business_date DESC
         LIMIT ${limit}
      `);
      return rows.rows.map((row) => ({
        ...EMPTY_ROW,
        key: row.key,
        label: row.key,
        secondary: null,
        count: int(row.count),
        amountMinor: int(row.amount),
        costMinor: int(row.cost),
      }));
    }

    if (groupBy === 'PAYMENT_METHOD') {
      /*
       * How the money arrived, from the payment rows the sale posted. The
       * unpaid remainder is a real row called Due rather than a missing one,
       * because "how much went out on credit today" is the question this
       * grouping is usually asked.
       */
      const rows = await db.execute<{ key: string; count: string; amount: string }>(sql`
        SELECT sp.account_code AS key, COUNT(DISTINCT sp.sale_id)::text AS count,
               COALESCE(SUM(sp.amount_minor), 0)::text AS amount
          FROM sale_payments sp
          JOIN sales s ON s.tenant_id = sp.tenant_id AND s.id = sp.sale_id
         WHERE sp.tenant_id = ${ctx.tenantId}
           AND s.status = 'POSTED'
           AND s.business_date BETWEEN ${period.from} AND ${period.to}
         GROUP BY sp.account_code
        UNION ALL
        SELECT 'DUE' AS key, COUNT(*)::text AS count,
               COALESCE(SUM(s.grand_total_minor - s.paid_minor), 0)::text AS amount
          FROM sales s
         WHERE s.tenant_id = ${ctx.tenantId}
           AND s.status = 'POSTED'
           AND s.business_date BETWEEN ${period.from} AND ${period.to}
           AND s.grand_total_minor > s.paid_minor
      `);
      const labels = await this.accountLabels(tx, ctx);
      return rows.rows
        .map((row) => ({
          ...EMPTY_ROW,
          key: row.key,
          label: row.key === 'DUE' ? 'On credit (due)' : (labels.get(row.key) ?? row.key),
          secondary: null,
          count: int(row.count),
          amountMinor: int(row.amount),
        }))
        .filter((row) => row.amountMinor !== 0 || row.count !== 0)
        .sort((a, b) => b.amountMinor - a.amountMinor)
        .slice(0, limit);
    }

    const grouping = SALES_GROUPINGS[groupBy];
    const rows = await db.execute<{
      key: string; label: string; secondary: string | null;
      count: string; qty: string; amount: string; cost: string;
    }>(sql`
      SELECT ${grouping.key} AS key, ${grouping.label} AS label, ${grouping.secondary} AS secondary,
             COUNT(DISTINCT s.id)::text AS count,
             COALESCE(SUM(sl.qty), 0)::text AS qty,
             COALESCE(SUM(sl.net_amount_minor), 0)::text AS amount,
             COALESCE(SUM(sl.cost_minor), 0)::text AS cost
        FROM sale_lines sl
        JOIN sales s ON s.tenant_id = sl.tenant_id AND s.id = sl.sale_id
        JOIN products p ON p.tenant_id = sl.tenant_id AND p.id = sl.product_id
        LEFT JOIN brands b ON b.tenant_id = p.tenant_id AND b.id = p.brand_id
        LEFT JOIN categories c ON c.tenant_id = p.tenant_id AND c.id = p.category_id
        LEFT JOIN parties pa ON pa.tenant_id = s.tenant_id AND pa.id = s.party_id
        LEFT JOIN users u ON u.tenant_id = s.tenant_id AND u.id = s.created_by
       WHERE sl.tenant_id = ${ctx.tenantId}
         AND s.status = 'POSTED'
         AND s.business_date BETWEEN ${period.from} AND ${period.to}
       GROUP BY ${grouping.key}, ${grouping.label}, ${grouping.secondary}
       ORDER BY 6 DESC
       LIMIT ${limit}
    `);

    return rows.rows.map((row) => ({
      ...EMPTY_ROW,
      key: row.key ?? '',
      label: row.label ?? 'Not set',
      secondary: row.secondary,
      count: int(row.count),
      qty: int(row.qty),
      amountMinor: int(row.amount),
      costMinor: int(row.cost),
    }));
  }

  async salesControlTotals(
    tx: Tx,
    ctx: TenantContext,
    period: ReportPeriod,
  ): Promise<{ revenueMinor: number; cogsMinor: number; count: number }> {
    const rows = await txOf(tx).execute<{ revenue: string; cogs: string; count: string }>(sql`
      SELECT COALESCE(SUM(CASE WHEN jl.account_code = 'SALES' THEN -jl.amount_minor ELSE 0 END), 0)::text AS revenue,
             COALESCE(SUM(CASE WHEN jl.account_code = 'COGS' THEN jl.amount_minor ELSE 0 END), 0)::text AS cogs,
             COUNT(DISTINCT je.id)::text AS count
        FROM journal_entries je
        JOIN journal_lines jl ON jl.tenant_id = je.tenant_id AND jl.journal_entry_id = je.id
       WHERE je.tenant_id = ${ctx.tenantId}
         AND je.business_date BETWEEN ${period.from} AND ${period.to}
         AND jl.account_code IN ('SALES', 'COGS')
    `);
    const row = rows.rows[0];
    return { revenueMinor: int(row?.revenue), cogsMinor: int(row?.cogs), count: int(row?.count) };
  }

  async purchasesGrouped(
    tx: Tx,
    ctx: TenantContext,
    period: ReportPeriod,
    groupBy: PurchaseGrouping,
    limit: number,
  ): Promise<readonly GroupedAmountRow[]> {
    const db = txOf(tx);

    if (groupBy === 'PRODUCT') {
      const rows = await db.execute<{
        key: string; label: string; secondary: string | null;
        count: string; qty: string; amount: string;
      }>(sql`
        SELECT pl.product_id AS key, p.name AS label, u.name AS secondary,
               COUNT(DISTINCT pl.purchase_id)::text AS count,
               COALESCE(SUM(pl.qty), 0)::text AS qty,
               COALESCE(SUM(pl.line_total_minor - pl.discount_share_minor + pl.extra_cost_share_minor), 0)::text AS amount
          FROM purchase_lines pl
          JOIN purchases pu ON pu.tenant_id = pl.tenant_id AND pu.id = pl.purchase_id
          JOIN products p ON p.tenant_id = pl.tenant_id AND p.id = pl.product_id
          LEFT JOIN units u ON u.tenant_id = p.tenant_id AND u.id = p.base_unit_id
         WHERE pl.tenant_id = ${ctx.tenantId}
           AND pu.status = 'POSTED'
           AND pu.business_date BETWEEN ${period.from} AND ${period.to}
         GROUP BY pl.product_id, p.name, u.name
         ORDER BY 6 DESC
         LIMIT ${limit}
      `);
      return rows.rows.map((row) => ({
        ...EMPTY_ROW,
        key: row.key,
        label: row.label,
        secondary: row.secondary,
        count: int(row.count),
        qty: int(row.qty),
        amountMinor: int(row.amount),
      }));
    }

    /*
     * A bill's own totals, and what is still owed on it — computed in the same
     * statement as the row and never stored, the argument 0015, 0016 and 0017
     * all make: an outstanding column is a figure that can drift.
     */
    const key = groupBy === 'DATE' ? sql`pu.business_date::text` : sql`pu.supplier_party_id`;
    const label = groupBy === 'DATE' ? sql`pu.business_date::text` : sql`pa.name`;
    const rows = await db.execute<{
      key: string; label: string; count: string; amount: string; paid: string; due: string;
    }>(sql`
      SELECT ${key} AS key, ${label} AS label,
             COUNT(*)::text AS count,
             COALESCE(SUM(pu.grand_total_minor), 0)::text AS amount,
             COALESCE(SUM(pu.paid_minor + COALESCE(alloc.amount, 0)), 0)::text AS paid,
             COALESCE(SUM(pu.grand_total_minor - pu.paid_minor - COALESCE(alloc.amount, 0)), 0)::text AS due
        FROM purchases pu
        LEFT JOIN parties pa ON pa.tenant_id = pu.tenant_id AND pa.id = pu.supplier_party_id
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(pay.amount_minor), 0) AS amount
            FROM payment_allocations pay
           WHERE pay.tenant_id = pu.tenant_id AND pay.purchase_id = pu.id
        ) alloc ON TRUE
       WHERE pu.tenant_id = ${ctx.tenantId}
         AND pu.status = 'POSTED'
         AND pu.business_date BETWEEN ${period.from} AND ${period.to}
       GROUP BY ${key}, ${label}
       ORDER BY 4 DESC
       LIMIT ${limit}
    `);

    return rows.rows.map((row) => ({
      ...EMPTY_ROW,
      key: row.key,
      label: row.label ?? 'Not set',
      secondary: null,
      count: int(row.count),
      amountMinor: int(row.amount),
      paidMinor: int(row.paid),
      dueMinor: int(row.due),
    }));
  }

  async cogsByDate(
    tx: Tx,
    ctx: TenantContext,
    period: ReportPeriod,
    limit: number,
  ): Promise<readonly GroupedAmountRow[]> {
    const rows = await txOf(tx).execute<{ key: string; count: string; amount: string }>(sql`
      SELECT je.business_date::text AS key, COUNT(DISTINCT je.id)::text AS count,
             COALESCE(SUM(jl.amount_minor), 0)::text AS amount
        FROM journal_entries je
        JOIN journal_lines jl ON jl.tenant_id = je.tenant_id AND jl.journal_entry_id = je.id
       WHERE je.tenant_id = ${ctx.tenantId}
         AND jl.account_code = 'COGS'
         AND je.business_date BETWEEN ${period.from} AND ${period.to}
       GROUP BY je.business_date
       ORDER BY je.business_date DESC
       LIMIT ${limit}
    `);
    return rows.rows.map((row) => ({
      ...EMPTY_ROW,
      key: row.key,
      label: row.key,
      secondary: null,
      count: int(row.count),
      amountMinor: int(row.amount),
      costMinor: int(row.amount),
    }));
  }

  async partyLedgerEntries(
    tx: Tx,
    ctx: TenantContext,
    account: 'AR' | 'AP',
    asOf: string,
  ): Promise<readonly PartyLedgerEntry[]> {
    /*
     * Ageing is built from the control account's own lines, which is what makes
     * it reconcile exactly rather than approximately: openings, sales, returns,
     * receipts and payments are all here because all of them moved `AR` or
     * `AP`, and ageing never has to know they exist.
     *
     * `due_date` comes from the document where there is one, so the overdue
     * flag is still possible — but the **age** is the entry's own business date
     * (owner decision 2026-08-30).
     */
    const rows = await txOf(tx).execute<{
      party_id: string; party_name: string; phone: string | null;
      business_date: string; due_date: string | null; amount: string;
    }>(sql`
      SELECT jl.party_id AS party_id, pa.name AS party_name, pa.phone AS phone,
             je.business_date::text AS business_date,
             COALESCE(s.due_date, pu.due_date)::text AS due_date,
             jl.amount_minor::text AS amount
        FROM journal_lines jl
        JOIN journal_entries je ON je.tenant_id = jl.tenant_id AND je.id = jl.journal_entry_id
        JOIN parties pa ON pa.tenant_id = jl.tenant_id AND pa.id = jl.party_id
        LEFT JOIN sales s ON s.tenant_id = je.tenant_id AND s.id = je.source_document_id
        LEFT JOIN purchases pu ON pu.tenant_id = je.tenant_id AND pu.id = je.source_document_id
       WHERE jl.tenant_id = ${ctx.tenantId}
         AND jl.account_code = ${account}
         AND jl.party_id IS NOT NULL
         AND je.business_date <= ${asOf}
       ORDER BY je.business_date ASC, je.created_at ASC, jl.id ASC
    `);

    return rows.rows.map((row) => ({
      partyId: row.party_id.trim(),
      partyName: row.party_name,
      phone: row.phone,
      businessDate: row.business_date,
      dueDate: row.due_date,
      amountMinor: int(row.amount),
    }));
  }

  async accountBalance(
    tx: Tx,
    ctx: TenantContext,
    accountCode: string,
    asOf: string,
  ): Promise<number> {
    const rows = await txOf(tx).execute<{ balance: string }>(sql`
      SELECT COALESCE(SUM(jl.amount_minor), 0)::text AS balance
        FROM journal_lines jl
        JOIN journal_entries je ON je.tenant_id = jl.tenant_id AND je.id = jl.journal_entry_id
       WHERE jl.tenant_id = ${ctx.tenantId}
         AND jl.account_code = ${accountCode}
         AND je.business_date <= ${asOf}
    `);
    return int(rows.rows[0]?.balance);
  }

  async accountMovements(
    tx: Tx,
    ctx: TenantContext,
    prefix: 'CASH' | 'BANK',
    period: ReportPeriod,
  ): Promise<readonly AccountMovementRow[]> {
    /*
     * Opening is everything posted before the range, in and out are the range
     * itself split by sign, and closing is the whole sum — one statement, so
     * the four figures cannot disagree with one another.
     */
    const pattern = `${prefix}:%`;
    const rows = await txOf(tx).execute<{
      account_code: string; label: string | null; opening: string; money_in: string;
      money_out: string; closing: string;
    }>(sql`
      SELECT jl.account_code AS account_code, a.name AS label,
             COALESCE(SUM(CASE WHEN je.business_date < ${period.from} THEN jl.amount_minor ELSE 0 END), 0)::text AS opening,
             COALESCE(SUM(CASE WHEN je.business_date BETWEEN ${period.from} AND ${period.to} AND jl.amount_minor > 0 THEN jl.amount_minor ELSE 0 END), 0)::text AS money_in,
             COALESCE(SUM(CASE WHEN je.business_date BETWEEN ${period.from} AND ${period.to} AND jl.amount_minor < 0 THEN -jl.amount_minor ELSE 0 END), 0)::text AS money_out,
             COALESCE(SUM(CASE WHEN je.business_date <= ${period.to} THEN jl.amount_minor ELSE 0 END), 0)::text AS closing
        FROM journal_lines jl
        JOIN journal_entries je ON je.tenant_id = jl.tenant_id AND je.id = jl.journal_entry_id
        LEFT JOIN accounts a ON a.tenant_id = jl.tenant_id AND jl.account_code = ${ACCOUNT_CODE}
       WHERE jl.tenant_id = ${ctx.tenantId}
         AND jl.account_code LIKE ${pattern}
       GROUP BY jl.account_code, a.name
       ORDER BY a.name NULLS LAST, jl.account_code
    `);

    return rows.rows.map((row) => ({
      accountCode: row.account_code,
      label: row.label ?? row.account_code,
      openingMinor: int(row.opening),
      inMinor: int(row.money_in),
      outMinor: int(row.money_out),
      closingMinor: int(row.closing),
    }));
  }

  async expensesByCategory(
    tx: Tx,
    ctx: TenantContext,
    period: ReportPeriod,
    limit: number,
  ): Promise<readonly GroupedAmountRow[]> {
    /*
     * An expense's category is half its account code (`EXPENSE:RENT`, Phase 7),
     * which is exactly why a month's rent is a balance here rather than a
     * filter over documents.
     */
    const rows = await txOf(tx).execute<{
      key: string; label: string | null; count: string; amount: string;
    }>(sql`
      SELECT jl.account_code AS key, ec.name AS label,
             COUNT(DISTINCT je.id)::text AS count,
             COALESCE(SUM(jl.amount_minor), 0)::text AS amount
        FROM journal_lines jl
        JOIN journal_entries je ON je.tenant_id = jl.tenant_id AND je.id = jl.journal_entry_id
        LEFT JOIN expense_categories ec ON ec.tenant_id = jl.tenant_id
             AND jl.account_code = ('EXPENSE:' || ec.code)
       WHERE jl.tenant_id = ${ctx.tenantId}
         AND jl.account_code LIKE 'EXPENSE:%'
         AND je.business_date BETWEEN ${period.from} AND ${period.to}
       GROUP BY jl.account_code, ec.name
       ORDER BY 4 DESC
       LIMIT ${limit}
    `);

    return rows.rows.map((row) => ({
      ...EMPTY_ROW,
      key: row.key,
      label: row.label ?? row.key.replace('EXPENSE:', ''),
      secondary: null,
      count: int(row.count),
      amountMinor: int(row.amount),
    }));
  }

  async profitFigures(tx: Tx, ctx: TenantContext, period: ReportPeriod): Promise<ProfitFigures> {
    const rows = await txOf(tx).execute<{
      sales: string; returns: string; cogs: string; expense: string; other: string;
    }>(sql`
      SELECT
        COALESCE(SUM(CASE WHEN jl.account_code = 'SALES' AND je.source_document_type = 'SALE' THEN -jl.amount_minor ELSE 0 END), 0)::text AS sales,
        COALESCE(SUM(CASE WHEN jl.account_code = 'SALES' AND je.source_document_type <> 'SALE' THEN jl.amount_minor ELSE 0 END), 0)::text AS returns,
        COALESCE(SUM(CASE WHEN jl.account_code = 'COGS' THEN jl.amount_minor ELSE 0 END), 0)::text AS cogs,
        COALESCE(SUM(CASE WHEN jl.account_code LIKE 'EXPENSE:%' THEN jl.amount_minor ELSE 0 END), 0)::text AS expense,
        COALESCE(SUM(CASE WHEN jl.account_code IN ('STOCK_ADJUSTMENT', 'CASH_SHORT_OVER', 'WARRANTY_EXPENSE', 'ROUNDING') THEN jl.amount_minor ELSE 0 END), 0)::text AS other
      FROM journal_lines jl
      JOIN journal_entries je ON je.tenant_id = jl.tenant_id AND je.id = jl.journal_entry_id
     WHERE jl.tenant_id = ${ctx.tenantId}
       AND je.business_date BETWEEN ${period.from} AND ${period.to}
    `);

    /*
     * D-06: a range containing a provisionally costed sale line cannot present
     * its profit as final. The flag travels with the figure rather than being
     * decided by the screen.
     */
    const provisional = await txOf(tx).execute<{ found: string }>(sql`
      SELECT COUNT(*)::text AS found
        FROM sale_lines sl
        JOIN sales s ON s.tenant_id = sl.tenant_id AND s.id = sl.sale_id
       WHERE sl.tenant_id = ${ctx.tenantId}
         AND sl.is_provisional_cost = TRUE
         AND s.business_date BETWEEN ${period.from} AND ${period.to}
    `);

    const row = rows.rows[0];
    return {
      salesMinor: int(row?.sales),
      returnsMinor: int(row?.returns),
      cogsMinor: int(row?.cogs),
      expenseMinor: int(row?.expense),
      otherMinor: int(row?.other),
      provisional: int(provisional.rows[0]?.found) > 0,
    };
  }

  async productPerformance(
    tx: Tx,
    ctx: TenantContext,
    period: ReportPeriod,
    limit: number,
  ): Promise<readonly ProductPerformanceRow[]> {
    /*
     * Units sold and what they earned and cost, with the stock held at each end
     * of the range so stock turn means something. The opening quantity is
     * today's wound back through the movements since the range began — the
     * movements are the record, so winding them back is reading them, not
     * estimating.
     */
    const rows = await txOf(tx).execute<{
      product_id: string; product_name: string; unit_name: string | null;
      units_sold: string; revenue: string; cost: string;
      closing_qty: string; moved_in: string; moved_out: string;
    }>(sql`
      WITH sold AS (
        SELECT sl.product_id,
               SUM(sl.qty) AS units_sold,
               SUM(sl.net_amount_minor) AS revenue,
               SUM(sl.cost_minor) AS cost
          FROM sale_lines sl
          JOIN sales s ON s.tenant_id = sl.tenant_id AND s.id = sl.sale_id
         WHERE sl.tenant_id = ${ctx.tenantId}
           AND s.status = 'POSTED'
           AND s.business_date BETWEEN ${period.from} AND ${period.to}
         GROUP BY sl.product_id
      ), moved AS (
        SELECT sm.product_id,
               SUM(CASE WHEN sm.direction = 'IN' THEN sm.qty ELSE 0 END) AS moved_in,
               SUM(CASE WHEN sm.direction = 'OUT' THEN sm.qty ELSE 0 END) AS moved_out
          FROM stock_movements sm
         WHERE sm.tenant_id = ${ctx.tenantId}
           AND sm.business_date BETWEEN ${period.from} AND ${period.to}
         GROUP BY sm.product_id
      )
      SELECT sold.product_id AS product_id, p.name AS product_name, u.name AS unit_name,
             sold.units_sold::text AS units_sold, sold.revenue::text AS revenue, sold.cost::text AS cost,
             COALESCE(cs.qty_on_hand, 0)::text AS closing_qty,
             COALESCE(moved.moved_in, 0)::text AS moved_in,
             COALESCE(moved.moved_out, 0)::text AS moved_out
        FROM sold
        JOIN products p ON p.tenant_id = ${ctx.tenantId} AND p.id = sold.product_id
        LEFT JOIN units u ON u.tenant_id = p.tenant_id AND u.id = p.base_unit_id
        LEFT JOIN moved ON moved.product_id = sold.product_id
        LEFT JOIN product_cost_state cs ON cs.tenant_id = p.tenant_id AND cs.product_id = p.id
       ORDER BY sold.revenue DESC
       LIMIT ${limit}
    `);

    return rows.rows.map((row) => {
      const closingQty = int(row.closing_qty);
      const openingQty = closingQty - int(row.moved_in) + int(row.moved_out);
      return {
        productId: row.product_id.trim(),
        productName: row.product_name,
        unitName: row.unit_name ?? '',
        unitsSold: int(row.units_sold),
        revenueMinor: int(row.revenue),
        costMinor: int(row.cost),
        openingQty,
        closingQty,
      };
    });
  }

  async whyLines(
    tx: Tx,
    ctx: TenantContext,
    subject: string,
    key: string,
    period: ReportPeriod,
    limit: number,
  ): Promise<readonly WhySourceLine[]> {
    const db = txOf(tx);

    if (subject === 'PRODUCT_STOCK') {
      /*
       * The stock answer is stock movements, not journal lines: "why 127" is a
       * question about goods, and the movements are what produced the 127.
       */
      const rows = await db.execute<{
        id: string; business_date: string; created_at: Date; source_document_type: string;
        source_document_id: string; source_number: string; qty: string; direction: string;
      }>(sql`
        SELECT sm.id, sm.business_date::text AS business_date, sm.created_at,
               sm.source_document_type, sm.source_document_id, sm.source_number,
               sm.qty::text AS qty, sm.direction
          FROM stock_movements sm
         WHERE sm.tenant_id = ${ctx.tenantId}
           AND sm.product_id = ${key}
           AND sm.business_date BETWEEN ${period.from} AND ${period.to}
         ORDER BY sm.business_date DESC, sm.created_at DESC
         LIMIT ${limit}
      `);
      return rows.rows.map((row) => ({
        id: row.id.trim(),
        businessDate: row.business_date,
        createdAt: instant(row.created_at),
        sourceType: row.source_document_type,
        sourceId: row.source_document_id.trim(),
        sourceNumber: row.source_number,
        description: `${row.source_document_type} ${row.source_number}`,
        partyName: null,
        amountMinor: null,
        qty: int(row.qty),
        direction: row.direction === 'IN' ? ('IN' as const) : ('OUT' as const),
      }));
    }

    const condition = whyCondition(subject, key);
    const rows = await db.execute<{
      id: string; business_date: string; created_at: Date; source_document_type: string;
      source_document_id: string; source_number: string; account_code: string;
      party_name: string | null; amount: string;
    }>(sql`
      SELECT jl.id, je.business_date::text AS business_date, je.created_at,
             je.source_document_type, je.source_document_id, je.source_number,
             jl.account_code, pa.name AS party_name, jl.amount_minor::text AS amount
        FROM journal_lines jl
        JOIN journal_entries je ON je.tenant_id = jl.tenant_id AND je.id = jl.journal_entry_id
        LEFT JOIN parties pa ON pa.tenant_id = jl.tenant_id AND pa.id = jl.party_id
       WHERE jl.tenant_id = ${ctx.tenantId}
         AND je.business_date BETWEEN ${period.from} AND ${period.to}
         AND ${condition}
       ORDER BY je.business_date DESC, je.created_at DESC, jl.id DESC
       LIMIT ${limit}
    `);

    return rows.rows.map((row) => {
      const amountMinor = int(row.amount);
      return {
        id: row.id.trim(),
        businessDate: row.business_date,
        createdAt: instant(row.created_at),
        sourceType: row.source_document_type,
        sourceId: row.source_document_id.trim(),
        sourceNumber: row.source_number,
        description: `${row.source_document_type} ${row.source_number}`,
        partyName: row.party_name,
        // Credits are negative in the ledger; somebody reading a drill-down
        // wants the size and the direction, not the sign convention.
        amountMinor: Math.abs(amountMinor),
        qty: null,
        direction: amountMinor >= 0 ? ('IN' as const) : ('OUT' as const),
      };
    });
  }

  async accountLabels(tx: Tx, ctx: TenantContext): Promise<ReadonlyMap<string, string>> {
    const rows = await txOf(tx).execute<{ code: string; name: string }>(sql`
      SELECT ${ACCOUNT_CODE} AS code, a.name AS name
        FROM accounts a
       WHERE a.tenant_id = ${ctx.tenantId}
    `);
    return new Map(rows.rows.map((row) => [row.code, row.name]));
  }

  async dashboardFigures(
    tx: Tx,
    ctx: TenantContext,
    businessDate: string,
  ): Promise<DashboardFigures> {
    const db = txOf(tx);
    const rows = await db.execute<{
      today_sales: string; today_cogs: string; today_expense: string; cash: string; bank: string;
      stock: string; receivable: string; payable: string;
    }>(sql`
      SELECT
        COALESCE(SUM(CASE WHEN je.business_date = ${businessDate} AND jl.account_code = 'SALES' THEN -jl.amount_minor ELSE 0 END), 0)::text AS today_sales,
        COALESCE(SUM(CASE WHEN je.business_date = ${businessDate} AND jl.account_code = 'COGS' THEN jl.amount_minor ELSE 0 END), 0)::text AS today_cogs,
        COALESCE(SUM(CASE WHEN je.business_date = ${businessDate} AND jl.account_code LIKE 'EXPENSE:%' THEN jl.amount_minor ELSE 0 END), 0)::text AS today_expense,
        COALESCE(SUM(CASE WHEN jl.account_code LIKE 'CASH:%' THEN jl.amount_minor ELSE 0 END), 0)::text AS cash,
        COALESCE(SUM(CASE WHEN jl.account_code LIKE 'BANK:%' THEN jl.amount_minor ELSE 0 END), 0)::text AS bank,
        COALESCE(SUM(CASE WHEN jl.account_code = 'INVENTORY' THEN jl.amount_minor ELSE 0 END), 0)::text AS stock,
        COALESCE(SUM(CASE WHEN jl.account_code = 'AR' THEN jl.amount_minor ELSE 0 END), 0)::text AS receivable,
        COALESCE(SUM(CASE WHEN jl.account_code = 'AP' THEN -jl.amount_minor ELSE 0 END), 0)::text AS payable
      FROM journal_lines jl
      JOIN journal_entries je ON je.tenant_id = jl.tenant_id AND je.id = jl.journal_entry_id
     WHERE jl.tenant_id = ${ctx.tenantId}
       AND je.business_date <= ${businessDate}
    `);

    const counts = await db.execute<{
      sale_count: string; low_stock: string; provisional: string;
    }>(sql`
      SELECT
        (SELECT COUNT(*)::text FROM sales s
          WHERE s.tenant_id = ${ctx.tenantId} AND s.status = 'POSTED' AND s.business_date = ${businessDate}) AS sale_count,
        (SELECT COUNT(*)::text FROM products p
           LEFT JOIN product_cost_state cs ON cs.tenant_id = p.tenant_id AND cs.product_id = p.id
          WHERE p.tenant_id = ${ctx.tenantId} AND p.deleted_at IS NULL AND p.status = 'ACTIVE'
            AND COALESCE(cs.qty_on_hand, 0) <= p.min_stock_qty) AS low_stock,
        (SELECT COUNT(*)::text FROM sale_lines sl
           JOIN sales s ON s.tenant_id = sl.tenant_id AND s.id = sl.sale_id
          WHERE sl.tenant_id = ${ctx.tenantId} AND sl.is_provisional_cost = TRUE
            AND s.business_date = ${businessDate}) AS provisional
    `);

    const row = rows.rows[0];
    const count = counts.rows[0];
    return {
      todaySalesMinor: int(row?.today_sales),
      todaySaleCount: int(count?.sale_count),
      todayCogsMinor: int(row?.today_cogs),
      todayExpenseMinor: int(row?.today_expense),
      cashInHandMinor: int(row?.cash),
      bankBalanceMinor: int(row?.bank),
      stockValueMinor: int(row?.stock),
      customerDueMinor: int(row?.receivable),
      supplierPayableMinor: int(row?.payable),
      lowStockCount: int(count?.low_stock),
      profitProvisional: int(count?.provisional) > 0,
    };
  }

  async recentSales(tx: Tx, ctx: TenantContext, limit: number): Promise<readonly DashboardSale[]> {
    const rows = await txOf(tx).execute<{
      id: string; sale_number: string; customer_name_snapshot: string;
      grand_total_minor: string; created_at: Date;
    }>(sql`
      SELECT s.id, s.sale_number, s.customer_name_snapshot,
             s.grand_total_minor::text AS grand_total_minor, s.created_at
        FROM sales s
       WHERE s.tenant_id = ${ctx.tenantId} AND s.status = 'POSTED'
       ORDER BY s.created_at DESC
       LIMIT ${limit}
    `);
    return rows.rows.map((row) => ({
      id: row.id.trim(),
      number: row.sale_number,
      customerName: row.customer_name_snapshot,
      grandTotalMinor: int(row.grand_total_minor),
      createdAt: instant(row.created_at),
    }));
  }

  async findTarget(tx: Tx, ctx: TenantContext, month: string): Promise<StoredTarget | null> {
    const rows = await txOf(tx)
      .select({
        id: profitTargets.id,
        month: profitTargets.month,
        basis: profitTargets.basis,
        amountMinor: profitTargets.amountMinor,
        version: profitTargets.version,
      })
      .from(profitTargets)
      .where(and(eq(profitTargets.tenantId, ctx.tenantId), eq(profitTargets.month, month)))
      .limit(1);

    const row = rows[0];
    if (row === undefined) return null;
    return {
      id: row.id.trim(),
      month: row.month.trim(),
      basis: row.basis === 'SALES' ? 'SALES' : 'PROFIT',
      amountMinor: row.amountMinor,
      version: row.version,
    };
  }

  async saveTarget(tx: Tx, ctx: TenantContext, input: SaveTargetInput): Promise<void> {
    // One target per month: setting it again replaces the figure and bumps the
    // version, rather than leaving two rows for one month to disagree.
    await txOf(tx).execute(sql`
      INSERT INTO profit_targets (
        id, tenant_id, month, basis, amount_minor,
        created_at, updated_at, created_by, updated_by, version
      ) VALUES (
        ${input.id}, ${ctx.tenantId}, ${input.month}, ${input.basis}, ${input.amountMinor},
        NOW(), NOW(), ${ctx.userId}, ${ctx.userId}, 1
      )
      ON CONFLICT (tenant_id, month) DO UPDATE
        SET basis = EXCLUDED.basis,
            amount_minor = EXCLUDED.amount_minor,
            updated_at = NOW(),
            updated_by = EXCLUDED.updated_by,
            version = profit_targets.version + 1
    `);
  }
}

/** The five groupings that need a dimension the journal does not carry. */
const SALES_GROUPINGS: Record<
  'PRODUCT' | 'CUSTOMER' | 'CASHIER' | 'BRAND' | 'CATEGORY',
  { key: SQL; label: SQL; secondary: SQL }
> = {
  PRODUCT: { key: sql`sl.product_id`, label: sql`p.name`, secondary: sql`b.name` },
  CUSTOMER: { key: sql`s.party_id`, label: sql`s.customer_name_snapshot`, secondary: sql`pa.phone` },
  CASHIER: {
    key: sql`s.created_by`,
    label: sql`COALESCE(u.display_name, u.username)`,
    secondary: sql`NULL::text`,
  },
  BRAND: {
    key: sql`COALESCE(p.brand_id, '')`,
    label: sql`COALESCE(b.name, 'No brand')`,
    secondary: sql`NULL::text`,
  },
  CATEGORY: {
    key: sql`COALESCE(p.category_id, '')`,
    label: sql`COALESCE(c.name, 'No category')`,
    secondary: sql`NULL::text`,
  },
};

/** Which journal lines answer "Why?" for each subject. */
function whyCondition(subject: string, key: string): SQL {
  switch (subject) {
    case 'PARTY_BALANCE':
      return sql`jl.party_id = ${key} AND jl.account_code IN ('AR', 'AP')`;
    case 'PRODUCT_SALES':
      return sql`je.source_document_type = 'SALE' AND jl.account_code = 'SALES' AND EXISTS (
        SELECT 1 FROM sale_lines sl
         WHERE sl.tenant_id = jl.tenant_id AND sl.sale_id = je.source_document_id AND sl.product_id = ${key}
      )`;
    case 'PRODUCT_PURCHASES':
      return sql`je.source_document_type = 'PURCHASE' AND jl.account_code = 'INVENTORY' AND EXISTS (
        SELECT 1 FROM purchase_lines pl
         WHERE pl.tenant_id = jl.tenant_id AND pl.purchase_id = je.source_document_id AND pl.product_id = ${key}
      )`;
    case 'SALES_TOTAL':
      return sql`jl.account_code = 'SALES'`;
    default:
      return sql`jl.account_code = ${key}`;
  }
}
