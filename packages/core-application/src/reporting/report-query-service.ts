import {
  ageingTotals, marginBp, productPerformance, rankMovers, REPORT_AGEING_BUCKETS,
} from '@sher/core-domain';
import type { AgeingDocument } from '@sher/core-domain';
import { AppError, ErrorCode, Permission } from '@sher/core-contracts';
import type {
  AgeingReport, AgeingRow, MoneyReportQuery, MoneyReportResponse, PerformanceQuery,
  PerformanceResponse, PerformanceRow, PurchaseReportQuery, PurchaseReportResponse, ReportRow,
  ReportTotals, SalesReportQuery, SalesReportResponse, StockReportQuery, StockReportResponse,
  WhyQuery, WhyResponse,
} from '@sher/core-contracts';

import type { AccessControl } from '../ports/access-control';
import type { TenantContext } from '../ports/tenant-context';
import type { Tx, UnitOfWork } from '../ports/unit-of-work';
import type { GroupedAmountRow, PartyLedgerEntry, ReportPeriod, ReportRepository } from './report-repository';

/**
 * The four report screens and the "Why?" drill-down (§5.20).
 *
 * **Read-only, and structurally so** — this service is constructed without a
 * unit-of-work write path, a period guard, a numbering service or an outbox,
 * because it has nothing to post. A report that could change something would
 * be a second writer (A11), and the cheapest way to guarantee it never becomes
 * one is to not give it the tools.
 *
 * **What is withheld from whom.** Cost columns need `inventory.cost.view` and
 * profit columns need `report.profit.view`; both are **omitted from the
 * response object**, not blanked or zeroed (UI-40, R-E8), so the serialized
 * body is the proof. The two are separate questions: what one line cost the
 * shop, and what the shop earns.
 */
export class ReportQueryService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly access: AccessControl,
    private readonly reports: ReportRepository,
  ) {}

  async sales(ctx: TenantContext, query: SalesReportQuery): Promise<SalesReportResponse> {
    return this.uow.run(ctx, async (tx) => {
      await this.access.require(tx, ctx, Permission.REPORT_SALES_VIEW);
      const visibility = await this.visibility(tx, ctx);
      const period = assertRange(query);

      const rows = await this.reports.salesGrouped(tx, ctx, period, query.groupBy, query.limit);
      return {
        range: period,
        groupBy: query.groupBy,
        rows: rows.map((row) => toReportRow(row, visibility)),
        totals: totalsOf(rows, visibility),
      };
    });
  }

  async purchases(ctx: TenantContext, query: PurchaseReportQuery): Promise<PurchaseReportResponse> {
    return this.uow.run(ctx, async (tx) => {
      await this.access.require(tx, ctx, Permission.REPORT_PURCHASE_VIEW);
      const period = assertRange(query);

      const rows = await this.reports.purchasesGrouped(tx, ctx, period, query.groupBy, query.limit);
      /*
       * A purchase has no cost *of its own* — what the shop paid is the amount,
       * and there is no second figure to subtract from it. So the cost and
       * profit columns are absent here whatever the reader may see elsewhere:
       * a "profit" equal to the whole bill, which is what a zero cost would
       * produce, is a wrong number rather than a hidden one.
       */
      return {
        range: period,
        groupBy: query.groupBy,
        rows: rows.map((row) => toReportRow(row, NO_COST)),
        totals: totalsOf(rows, NO_COST),
      };
    });
  }

  /**
   * The two stock views that need sales data — cost of goods sold by day, and
   * margin per product. Everything else the Stock screen shows (valuation,
   * lots, movements, low stock, near expiry, cost adjustments) is served by
   * the Phase 3 inventory endpoints, which already own those questions.
   *
   * Both views are cost figures from end to end, so `inventory.cost.view` is a
   * refusal here rather than an omitted column: there would be nothing left.
   */
  async stock(ctx: TenantContext, query: StockReportQuery): Promise<StockReportResponse> {
    return this.uow.run(ctx, async (tx) => {
      await this.access.require(tx, ctx, Permission.REPORT_STOCK_VIEW);
      await this.access.require(tx, ctx, Permission.COST_VIEW);
      const visibility = await this.visibility(tx, ctx);
      const period = assertRange(query);

      const rows =
        query.view === 'COGS'
          ? await this.reports.cogsByDate(tx, ctx, period, query.limit)
          : (await this.reports.productPerformance(tx, ctx, period, query.limit)).map((row) => ({
              key: row.productId,
              label: row.productName,
              secondary: row.unitName,
              count: 0,
              qty: row.unitsSold,
              amountMinor: row.revenueMinor,
              costMinor: row.costMinor,
              paidMinor: 0,
              dueMinor: 0,
            }));

      return {
        range: period,
        view: query.view,
        rows: rows.map((row) => toReportRow(row, visibility)),
        totals: totalsOf(rows, visibility),
      };
    });
  }

  async money(ctx: TenantContext, query: MoneyReportQuery): Promise<MoneyReportResponse> {
    return this.uow.run(ctx, async (tx) => {
      await this.access.require(tx, ctx, Permission.REPORT_MONEY_VIEW);
      const period = assertRange(query);

      if (query.view === 'DUE_AGEING' || query.view === 'PAYABLE_AGEING') {
        const account = query.view === 'DUE_AGEING' ? 'AR' : 'AP';
        return { view: query.view, ageing: await this.ageing(tx, ctx, account, period.to) };
      }

      if (query.view === 'CASH' || query.view === 'BANK') {
        const rows = await this.reports.accountMovements(tx, ctx, query.view, period);
        return {
          view: query.view,
          accounts: {
            range: period,
            rows: [...rows],
            totals: {
              accountCode: 'TOTAL',
              label: 'All accounts',
              openingMinor: sum(rows, (row) => row.openingMinor),
              inMinor: sum(rows, (row) => row.inMinor),
              outMinor: sum(rows, (row) => row.outMinor),
              closingMinor: sum(rows, (row) => row.closingMinor),
            },
          },
        };
      }

      if (query.view === 'EXPENSE') {
        const rows = await this.reports.expensesByCategory(tx, ctx, period, query.limit);
        // What was spent has no cost and no margin either — same reason.
        return {
          view: query.view,
          expenses: {
            range: period,
            rows: rows.map((row) => toReportRow(row, NO_COST)),
            totals: totalsOf(rows, NO_COST),
          },
        };
      }

      // Profit is the one money view behind its own permission (§5.20, D-06).
      await this.access.require(tx, ctx, Permission.REPORT_PROFIT_VIEW);
      const figures = await this.reports.profitFigures(tx, ctx, period);
      const grossProfitMinor = figures.salesMinor - figures.returnsMinor - figures.cogsMinor;
      const netProfitMinor = grossProfitMinor - figures.expenseMinor - figures.otherMinor;
      const expenseRows = await this.reports.expensesByCategory(tx, ctx, period, query.limit);
      return {
        view: query.view,
        profit: {
          range: period,
          salesMinor: figures.salesMinor,
          returnsMinor: figures.returnsMinor,
          cogsMinor: figures.cogsMinor,
          grossProfitMinor,
          expenseMinor: figures.expenseMinor,
          otherMinor: figures.otherMinor,
          netProfitMinor,
          marginBp: marginBp(figures.salesMinor - figures.returnsMinor, figures.cogsMinor),
          // D-06: a range containing a provisionally costed sale is marked, and
          // the screen never presents it as final.
          provisional: figures.provisional,
          expenseRows: expenseRows.map((row) => toReportRow(row, NO_COST)),
        },
      };
    });
  }

  /**
   * Ageing, built by settling each party's credits against their oldest debits
   * (§5.20, owner decision 2026-08-30 — age from the document date).
   *
   * It is built from **journal lines on the control account**, not from
   * invoices, which is what makes the reconciliation exact rather than
   * approximate: the rows sum to the party's share of `AR` or `AP` by
   * construction, and openings, sales, returns, receipts and payments all age
   * by the same rule without ageing needing to know they exist.
   */
  private async ageing(
    tx: Tx,
    ctx: TenantContext,
    account: 'AR' | 'AP',
    asOf: string,
  ): Promise<AgeingReport> {
    const entries = await this.reports.partyLedgerEntries(tx, ctx, account, asOf);
    const controlAccountMinor = await this.reports.accountBalance(tx, ctx, account, asOf);

    const byParty = new Map<string, PartyLedgerEntry[]>();
    for (const entry of entries) {
      const list = byParty.get(entry.partyId) ?? [];
      list.push(entry);
      byParty.set(entry.partyId, list);
    }

    const rows: AgeingRow[] = [];
    for (const [partyId, list] of byParty) {
      const first = list[0];
      if (first === undefined) continue;

      // AR is a debit balance and AP a credit one, so what "owing" means flips
      // sign with the account. Everything below works in positive owing.
      const sign = account === 'AR' ? 1 : -1;
      const owing = list
        .map((entry) => ({ ...entry, amountMinor: entry.amountMinor * sign }))
        .sort((a, b) => (a.businessDate === b.businessDate ? 0 : a.businessDate < b.businessDate ? -1 : 1));

      let credit = owing.reduce((total, entry) => total + Math.min(entry.amountMinor, 0), 0);
      const open: AgeingDocument[] = [];
      for (const entry of owing) {
        if (entry.amountMinor <= 0) continue;
        // Oldest first: money received settles the oldest thing outstanding,
        // which is the same rule `allocateReceipt` uses when it is allocated.
        const settled = Math.min(entry.amountMinor, -credit);
        credit += settled;
        const left = entry.amountMinor - settled;
        if (left === 0) continue;
        open.push({ businessDate: entry.businessDate, dueDate: entry.dueDate, outstandingMinor: left });
      }

      const totals = ageingTotals(open, asOf);
      if (totals.totalMinor === 0 && open.length === 0) continue;
      rows.push({
        partyId,
        partyName: first.partyName,
        phone: first.phone,
        buckets: totals.buckets,
        totalMinor: totals.totalMinor,
        overdueMinor: totals.overdueMinor,
        oldestDate: open[0]?.businessDate ?? null,
      });
    }

    rows.sort((a, b) => b.totalMinor - a.totalMinor || a.partyName.localeCompare(b.partyName));

    const totals = {
      D0_30: sum(rows, (row) => row.buckets.D0_30),
      D31_60: sum(rows, (row) => row.buckets.D31_60),
      D61_90: sum(rows, (row) => row.buckets.D61_90),
      D90_PLUS: sum(rows, (row) => row.buckets.D90_PLUS),
    };
    const totalMinor = REPORT_AGEING_BUCKETS.reduce((all, bucket) => all + totals[bucket], 0);
    const expected = account === 'AR' ? controlAccountMinor : -controlAccountMinor;

    return {
      asOf,
      rows,
      totals,
      totalMinor,
      overdueMinor: sum(rows, (row) => row.overdueMinor),
      controlAccountMinor: expected,
      differenceMinor: totalMinor - expected,
      reconciled: totalMinor === expected,
    };
  }

  async performance(ctx: TenantContext, query: PerformanceQuery): Promise<PerformanceResponse> {
    return this.uow.run(ctx, async (tx) => {
      await this.access.require(tx, ctx, Permission.REPORT_SALES_VIEW);
      const visibility = await this.visibility(tx, ctx);
      const period = assertRange(query);

      const raw = await this.reports.productPerformance(tx, ctx, period, query.limit);
      const measured = raw.map((row) => ({
        row,
        performance: productPerformance({
          productId: row.productId,
          unitsSold: row.unitsSold,
          revenueMinor: row.revenueMinor,
          cogsMinor: row.costMinor,
          openingQty: row.openingQty,
          closingQty: row.closingQty,
        }),
      }));

      const toRow = (entry: (typeof measured)[number]): PerformanceRow => ({
        productId: entry.row.productId,
        productName: entry.row.productName,
        unitName: entry.row.unitName,
        unitsSold: entry.row.unitsSold,
        revenueMinor: entry.row.revenueMinor,
        ...(visibility.cost ? { costMinor: entry.row.costMinor } : {}),
        ...(visibility.profit
          ? {
              profitMinor: entry.performance.grossProfitMinor,
              marginBp: entry.performance.marginBp,
            }
          : {}),
        stockTurnBp: entry.performance.stockTurnBp,
      });

      const ranked = rankMovers(measured.map((entry) => entry.performance), 5);
      const byId = new Map(measured.map((entry) => [entry.row.productId, entry]));
      const pick = (ids: readonly { productId: string }[]): PerformanceRow[] =>
        ids.flatMap((entry) => {
          const found = byId.get(entry.productId);
          return found === undefined ? [] : [toRow(found)];
        });

      return {
        range: period,
        rows: measured.map(toRow),
        // Best and worst movers are a profit ranking, so they are only shown to
        // somebody allowed to see profit at all.
        best: visibility.profit ? pick(ranked.best) : [],
        worst: visibility.profit ? pick(ranked.worst) : [],
      };
    });
  }

  /**
   * "Why?" — the source lines behind one figure (§5.20).
   *
   * Which permission it needs follows the subject, because the drill-down must
   * not become a way around a report the user cannot open: money subjects need
   * the money report, stock subjects the stock report.
   */
  async why(ctx: TenantContext, query: WhyQuery): Promise<WhyResponse> {
    return this.uow.run(ctx, async (tx) => {
      const needed =
        query.subject === 'PRODUCT_STOCK'
          ? Permission.REPORT_STOCK_VIEW
          : query.subject === 'PRODUCT_PURCHASES'
            ? Permission.REPORT_PURCHASE_VIEW
            : query.subject === 'PRODUCT_SALES' || query.subject === 'SALES_TOTAL'
              ? Permission.REPORT_SALES_VIEW
              : Permission.REPORT_MONEY_VIEW;
      await this.access.require(tx, ctx, needed);
      const period = assertRange(query);

      const lines = await this.reports.whyLines(
        tx,
        ctx,
        query.subject,
        query.key,
        period,
        query.limit,
      );

      const amounts = lines.filter((line) => line.amountMinor !== null);
      const quantities = lines.filter((line) => line.qty !== null);
      return {
        subject: query.subject,
        key: query.key,
        title: titleFor(query.subject),
        range: period,
        lines: lines.map((line) => ({
          id: line.id,
          businessDate: line.businessDate,
          createdAt: line.createdAt.toISOString(),
          sourceType: line.sourceType,
          sourceId: line.sourceId,
          sourceNumber: line.sourceNumber,
          description: line.description,
          partyName: line.partyName,
          amountMinor: line.amountMinor,
          qty: line.qty,
          direction: line.direction,
        })),
        totalMinor: amounts.length === 0 ? null : sum(amounts, (line) => line.amountMinor ?? 0),
        totalQty: quantities.length === 0 ? null : sum(quantities, (line) => line.qty ?? 0),
        truncated: lines.length >= query.limit,
      };
    });
  }

  private async visibility(
    tx: Tx,
    ctx: TenantContext,
  ): Promise<{ cost: boolean; profit: boolean }> {
    const held = await this.access.permissionsOf(tx, ctx);
    return {
      cost: held.includes(Permission.COST_VIEW),
      profit: held.includes(Permission.REPORT_PROFIT_VIEW),
    };
  }
}

/** Reports whose rows have no cost behind them at all (see `purchases`). */
const NO_COST = { cost: false, profit: false };

/** A range that runs backwards is a typing mistake, and refusing it says so. */
function assertRange(query: { from: string; to: string }): ReportPeriod {
  if (query.to < query.from) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, 'The end date is before the start date');
  }
  return { from: query.from, to: query.to };
}

function toReportRow(
  row: GroupedAmountRow,
  visibility: { cost: boolean; profit: boolean },
): ReportRow {
  return {
    key: row.key,
    label: row.label,
    secondary: row.secondary,
    count: row.count,
    qty: row.qty,
    amountMinor: row.amountMinor,
    ...(visibility.cost ? { costMinor: row.costMinor } : {}),
    ...(visibility.profit
      ? {
          profitMinor: row.amountMinor - row.costMinor,
          marginBp: marginBp(row.amountMinor, row.costMinor),
        }
      : {}),
    ...(row.paidMinor === 0 && row.dueMinor === 0
      ? {}
      : { paidMinor: row.paidMinor, dueMinor: row.dueMinor }),
  };
}

function totalsOf(
  rows: readonly GroupedAmountRow[],
  visibility: { cost: boolean; profit: boolean },
): ReportTotals {
  const amountMinor = sum(rows, (row) => row.amountMinor);
  const costMinor = sum(rows, (row) => row.costMinor);
  const paidMinor = sum(rows, (row) => row.paidMinor);
  const dueMinor = sum(rows, (row) => row.dueMinor);
  return {
    count: sum(rows, (row) => row.count),
    qty: sum(rows, (row) => row.qty),
    amountMinor,
    ...(visibility.cost ? { costMinor } : {}),
    ...(visibility.profit
      ? { profitMinor: amountMinor - costMinor, marginBp: marginBp(amountMinor, costMinor) }
      : {}),
    ...(paidMinor === 0 && dueMinor === 0 ? {} : { paidMinor, dueMinor }),
  };
}

function sum<T>(rows: readonly T[], of: (row: T) => number): number {
  return rows.reduce((total, row) => total + of(row), 0);
}

function titleFor(subject: string): string {
  switch (subject) {
    case 'ACCOUNT':
      return 'What makes up this balance';
    case 'PARTY_BALANCE':
      return 'What this balance is made of';
    case 'PRODUCT_STOCK':
      return 'The movements behind this stock';
    case 'PRODUCT_SALES':
      return 'The sales behind this figure';
    case 'PRODUCT_PURCHASES':
      return 'The purchases behind this figure';
    case 'EXPENSE_CATEGORY':
      return 'The expenses behind this figure';
    default:
      return 'What makes up this figure';
  }
}
