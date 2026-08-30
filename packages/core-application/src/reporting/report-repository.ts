import type { TenantContext } from '../ports/tenant-context';
import type { Tx } from '../ports/unit-of-work';

/**
 * What the report screens read (§5.20).
 *
 * **Where the figures come from, and why it is split this way.** §5.20 is
 * emphatic that reports read from journal lines and stock movements, never
 * from documents (INV-10). The journal is the authority on every *amount* —
 * revenue, cost, cash, dues, payables, profit — and every method here that
 * returns money reads it from `journal_lines`.
 *
 * The journal has no product, brand or category dimension: a `SALES` credit
 * knows what was earned, not what was sold. So the methods that split a total
 * **by product** read the document lines that produced those journal lines,
 * and the service proves the split against the journal total and shows any
 * difference rather than hiding it. A split that cannot be proved is a bug in
 * the posting path, and this is where it becomes visible.
 *
 * Nothing in this interface writes. The one exception in this module is the
 * profit target, which is not a business figure at all — it is what the owner
 * typed — and it lives in its own repository method pair below.
 */

export interface ReportPeriod {
  readonly from: string;
  readonly to: string;
}

/** A grouped row before the service adds cost, profit and margin. */
export interface GroupedAmountRow {
  readonly key: string;
  readonly label: string;
  readonly secondary: string | null;
  readonly count: number;
  readonly qty: number;
  readonly amountMinor: number;
  readonly costMinor: number;
  readonly paidMinor: number;
  readonly dueMinor: number;
}

export interface AccountMovementRow {
  readonly accountCode: string;
  readonly label: string;
  readonly openingMinor: number;
  readonly inMinor: number;
  readonly outMinor: number;
  readonly closingMinor: number;
}

/** One journal debit or credit on a party's control account, for ageing. */
export interface PartyLedgerEntry {
  readonly partyId: string;
  readonly partyName: string;
  readonly phone: string | null;
  readonly businessDate: string;
  readonly dueDate: string | null;
  readonly amountMinor: number;
}

export interface WhySourceLine {
  readonly id: string;
  readonly businessDate: string;
  readonly createdAt: Date;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly sourceNumber: string;
  readonly description: string;
  readonly partyName: string | null;
  readonly amountMinor: number | null;
  readonly qty: number | null;
  readonly direction: 'IN' | 'OUT' | null;
}

export interface ProductPerformanceRow {
  readonly productId: string;
  readonly productName: string;
  readonly unitName: string;
  readonly unitsSold: number;
  readonly revenueMinor: number;
  readonly costMinor: number;
  readonly openingQty: number;
  readonly closingQty: number;
}

export interface ProfitFigures {
  readonly salesMinor: number;
  readonly returnsMinor: number;
  readonly cogsMinor: number;
  readonly expenseMinor: number;
  readonly otherMinor: number;
  readonly provisional: boolean;
}

export interface DashboardFigures {
  readonly todaySalesMinor: number;
  readonly todaySaleCount: number;
  readonly todayCogsMinor: number;
  readonly todayExpenseMinor: number;
  readonly cashInHandMinor: number;
  readonly bankBalanceMinor: number;
  readonly stockValueMinor: number;
  readonly customerDueMinor: number;
  readonly supplierPayableMinor: number;
  readonly lowStockCount: number;
  readonly profitProvisional: boolean;
}

export interface DashboardSale {
  readonly id: string;
  readonly number: string;
  readonly customerName: string;
  readonly grandTotalMinor: number;
  readonly createdAt: Date;
}

export interface StoredTarget {
  readonly id: string;
  readonly month: string;
  readonly basis: 'PROFIT' | 'SALES';
  readonly amountMinor: number;
  readonly version: number;
}

export interface SaveTargetInput {
  readonly id: string;
  readonly month: string;
  readonly basis: 'PROFIT' | 'SALES';
  readonly amountMinor: number;
}

export type SalesGrouping =
  | 'DATE'
  | 'PRODUCT'
  | 'CUSTOMER'
  | 'CASHIER'
  | 'BRAND'
  | 'CATEGORY'
  | 'PAYMENT_METHOD';
export type PurchaseGrouping = 'DATE' | 'SUPPLIER' | 'PRODUCT';

export interface ReportRepository {
  /** Net sales grouped as asked; DATE reads the journal, the rest split it by document line. */
  salesGrouped(
    tx: Tx,
    ctx: TenantContext,
    period: ReportPeriod,
    groupBy: SalesGrouping,
    limit: number,
  ): Promise<readonly GroupedAmountRow[]>;

  /** What the `SALES` and `COGS` accounts actually moved, for the reconciliation line. */
  salesControlTotals(
    tx: Tx,
    ctx: TenantContext,
    period: ReportPeriod,
  ): Promise<{ revenueMinor: number; cogsMinor: number; count: number }>;

  purchasesGrouped(
    tx: Tx,
    ctx: TenantContext,
    period: ReportPeriod,
    groupBy: PurchaseGrouping,
    limit: number,
  ): Promise<readonly GroupedAmountRow[]>;

  /** Cost of goods sold by day, straight off the `COGS` account. */
  cogsByDate(
    tx: Tx,
    ctx: TenantContext,
    period: ReportPeriod,
    limit: number,
  ): Promise<readonly GroupedAmountRow[]>;

  /** Every open item on a control account, per party, for oldest-first ageing. */
  partyLedgerEntries(
    tx: Tx,
    ctx: TenantContext,
    account: 'AR' | 'AP',
    asOf: string,
  ): Promise<readonly PartyLedgerEntry[]>;

  /** The control account's own balance as of a date — what ageing must equal. */
  accountBalance(tx: Tx, ctx: TenantContext, accountCode: string, asOf: string): Promise<number>;

  /** Cash or bank accounts with opening, in, out and closing over a range. */
  accountMovements(
    tx: Tx,
    ctx: TenantContext,
    prefix: 'CASH' | 'BANK',
    period: ReportPeriod,
  ): Promise<readonly AccountMovementRow[]>;

  expensesByCategory(
    tx: Tx,
    ctx: TenantContext,
    period: ReportPeriod,
    limit: number,
  ): Promise<readonly GroupedAmountRow[]>;

  profitFigures(tx: Tx, ctx: TenantContext, period: ReportPeriod): Promise<ProfitFigures>;

  productPerformance(
    tx: Tx,
    ctx: TenantContext,
    period: ReportPeriod,
    limit: number,
  ): Promise<readonly ProductPerformanceRow[]>;

  whyLines(
    tx: Tx,
    ctx: TenantContext,
    subject: string,
    key: string,
    period: ReportPeriod,
    limit: number,
  ): Promise<readonly WhySourceLine[]>;

  /** The label a shopkeeper reads for an account code — the account's own name. */
  accountLabels(tx: Tx, ctx: TenantContext): Promise<ReadonlyMap<string, string>>;

  dashboardFigures(tx: Tx, ctx: TenantContext, businessDate: string): Promise<DashboardFigures>;
  recentSales(tx: Tx, ctx: TenantContext, limit: number): Promise<readonly DashboardSale[]>;

  findTarget(tx: Tx, ctx: TenantContext, month: string): Promise<StoredTarget | null>;
  saveTarget(tx: Tx, ctx: TenantContext, input: SaveTargetInput): Promise<void>;
}
