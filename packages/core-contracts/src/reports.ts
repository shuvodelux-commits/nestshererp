import { z } from 'zod';

/**
 * Reports (§5.20) — four screens, each with its own Group By, and one "Why?"
 * endpoint that every total on all of them drills into.
 *
 * Everything here is read-only. No schema in this file describes a write to a
 * business document, because a report that could change something would be a
 * second posting path (INV-10, A11).
 *
 * Cost, profit and margin fields are **optional and omitted** without
 * `inventory.cost.view` / `report.profit.view` — omitted, never blanked or
 * zeroed (UI-40, R-E8), so the response body itself is the proof.
 */

const ULID = z.string().length(26);
const BUSINESS_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const MONTH = z.string().regex(/^\d{4}-\d{2}$/);

export const reportRangeSchema = z.object({ from: BUSINESS_DATE, to: BUSINESS_DATE }).strict();
export type ReportRange = z.infer<typeof reportRangeSchema>;

/**
 * One row of a grouped report, whatever it is grouped by.
 *
 * A single row shape across Sales, Purchase and Stock is deliberate: the four
 * screens then share one table component, one CSV writer and one print block,
 * and a shopkeeper who has learnt to read one has learnt to read all of them
 * (owner decision 2026-08-30 — few screens, many filters).
 */
export const reportRowSchema = z
  .object({
    /** Stable id of the thing grouped by — a product id, a date, an account code. */
    key: z.string(),
    label: z.string(),
    /** The smaller second line: a brand under a product, a phone under a customer. */
    secondary: z.string().nullable(),
    /** How many documents the row is made of. */
    count: z.number().int(),
    qty: z.number().int(),
    amountMinor: z.number().int(),
    costMinor: z.number().int().optional(),
    profitMinor: z.number().int().optional(),
    marginBp: z.number().int().optional(),
    paidMinor: z.number().int().optional(),
    dueMinor: z.number().int().optional(),
  })
  .strict();
export type ReportRow = z.infer<typeof reportRowSchema>;

export const reportTotalsSchema = z
  .object({
    count: z.number().int(),
    qty: z.number().int(),
    amountMinor: z.number().int(),
    costMinor: z.number().int().optional(),
    profitMinor: z.number().int().optional(),
    marginBp: z.number().int().optional(),
    paidMinor: z.number().int().optional(),
    dueMinor: z.number().int().optional(),
  })
  .strict();
export type ReportTotals = z.infer<typeof reportTotalsSchema>;

/* --------------------------------------------------------------- sales */

export const salesGroupBySchema = z.enum([
  'DATE',
  'PRODUCT',
  'CUSTOMER',
  'CASHIER',
  'BRAND',
  'CATEGORY',
  'PAYMENT_METHOD',
]);
export type SalesGroupBy = z.infer<typeof salesGroupBySchema>;

export const salesReportQuerySchema = z
  .object({
    from: BUSINESS_DATE,
    to: BUSINESS_DATE,
    groupBy: salesGroupBySchema.default('DATE'),
    limit: z.coerce.number().int().min(1).max(1000).default(500),
  })
  .strict();
export type SalesReportQuery = z.infer<typeof salesReportQuerySchema>;

export const salesReportResponseSchema = z
  .object({
    range: reportRangeSchema,
    groupBy: salesGroupBySchema,
    rows: z.array(reportRowSchema),
    totals: reportTotalsSchema,
  })
  .strict();
export type SalesReportResponse = z.infer<typeof salesReportResponseSchema>;

/* ------------------------------------------------------------ purchase */

export const purchaseGroupBySchema = z.enum(['DATE', 'SUPPLIER', 'PRODUCT']);
export type PurchaseGroupBy = z.infer<typeof purchaseGroupBySchema>;

export const purchaseReportQuerySchema = z
  .object({
    from: BUSINESS_DATE,
    to: BUSINESS_DATE,
    groupBy: purchaseGroupBySchema.default('DATE'),
    limit: z.coerce.number().int().min(1).max(1000).default(500),
  })
  .strict();
export type PurchaseReportQuery = z.infer<typeof purchaseReportQuerySchema>;

export const purchaseReportResponseSchema = z
  .object({
    range: reportRangeSchema,
    groupBy: purchaseGroupBySchema,
    rows: z.array(reportRowSchema),
    totals: reportTotalsSchema,
  })
  .strict();
export type PurchaseReportResponse = z.infer<typeof purchaseReportResponseSchema>;

/* --------------------------------------------------------------- stock */

/**
 * The Stock screen's own two groupings.
 *
 * Valuation, lots, movements, low stock, out of stock, near expiry and cost
 * adjustments are **not** here: they already exist on `/api/v1/inventory*`
 * from Phase 3, and the screen calls those. Adding a second definition of
 * "what is on the shelf" is precisely what INV-10 forbids, so this endpoint
 * covers only the two views that need sales data Inventory does not have.
 */
export const stockReportViewSchema = z.enum(['COGS', 'MARGIN']);
export type StockReportView = z.infer<typeof stockReportViewSchema>;

export const stockReportQuerySchema = z
  .object({
    from: BUSINESS_DATE,
    to: BUSINESS_DATE,
    view: stockReportViewSchema.default('COGS'),
    limit: z.coerce.number().int().min(1).max(1000).default(500),
  })
  .strict();
export type StockReportQuery = z.infer<typeof stockReportQuerySchema>;

export const stockReportResponseSchema = z
  .object({
    range: reportRangeSchema,
    view: stockReportViewSchema,
    rows: z.array(reportRowSchema),
    totals: reportTotalsSchema,
  })
  .strict();
export type StockReportResponse = z.infer<typeof stockReportResponseSchema>;

/* --------------------------------------------------------------- money */

export const moneyReportViewSchema = z.enum([
  'DUE_AGEING',
  'PAYABLE_AGEING',
  'CASH',
  'BANK',
  'EXPENSE',
  'PROFIT',
]);
export type MoneyReportView = z.infer<typeof moneyReportViewSchema>;

export const moneyReportQuerySchema = z
  .object({
    from: BUSINESS_DATE,
    to: BUSINESS_DATE,
    view: moneyReportViewSchema.default('DUE_AGEING'),
    limit: z.coerce.number().int().min(1).max(1000).default(500),
  })
  .strict();
export type MoneyReportQuery = z.infer<typeof moneyReportQuerySchema>;

export const ageingBucketsSchema = z
  .object({
    D0_30: z.number().int(),
    D31_60: z.number().int(),
    D61_90: z.number().int(),
    D90_PLUS: z.number().int(),
  })
  .strict();
export type AgeingBuckets = z.infer<typeof ageingBucketsSchema>;

export const ageingRowSchema = z
  .object({
    partyId: ULID,
    partyName: z.string(),
    phone: z.string().nullable(),
    buckets: ageingBucketsSchema,
    totalMinor: z.number().int(),
    overdueMinor: z.number().int(),
    oldestDate: BUSINESS_DATE.nullable(),
  })
  .strict();
export type AgeingRow = z.infer<typeof ageingRowSchema>;

/**
 * Ageing carries its own reconciliation, because §5.20 requires the totals to
 * equal the journal control account as of the same business date. The screen
 * shows the difference rather than hiding it: a mismatch is a real finding,
 * not a rendering problem.
 */
export const ageingReportSchema = z
  .object({
    asOf: BUSINESS_DATE,
    rows: z.array(ageingRowSchema),
    totals: ageingBucketsSchema,
    totalMinor: z.number().int(),
    overdueMinor: z.number().int(),
    controlAccountMinor: z.number().int(),
    differenceMinor: z.number().int(),
    reconciled: z.boolean(),
  })
  .strict();
export type AgeingReport = z.infer<typeof ageingReportSchema>;

export const accountBalanceRowSchema = z
  .object({
    accountCode: z.string(),
    label: z.string(),
    openingMinor: z.number().int(),
    inMinor: z.number().int(),
    outMinor: z.number().int(),
    closingMinor: z.number().int(),
  })
  .strict();
export type AccountBalanceRow = z.infer<typeof accountBalanceRowSchema>;

export const accountReportSchema = z
  .object({
    range: reportRangeSchema,
    rows: z.array(accountBalanceRowSchema),
    totals: accountBalanceRowSchema,
  })
  .strict();
export type AccountReport = z.infer<typeof accountReportSchema>;

/**
 * The profit statement, and D-06's honesty rule in one field.
 *
 * `provisional` is true when any sale in the range was costed provisionally
 * (§5.20, D-06). The screen marks the figure rather than hiding the report —
 * but it is never presented as final while that flag is up.
 */
export const profitReportSchema = z
  .object({
    range: reportRangeSchema,
    salesMinor: z.number().int(),
    returnsMinor: z.number().int(),
    cogsMinor: z.number().int(),
    grossProfitMinor: z.number().int(),
    expenseMinor: z.number().int(),
    otherMinor: z.number().int(),
    netProfitMinor: z.number().int(),
    marginBp: z.number().int(),
    provisional: z.boolean(),
    expenseRows: z.array(reportRowSchema),
  })
  .strict();
export type ProfitReport = z.infer<typeof profitReportSchema>;

export const moneyReportResponseSchema = z
  .object({
    view: moneyReportViewSchema,
    ageing: ageingReportSchema.optional(),
    accounts: accountReportSchema.optional(),
    profit: profitReportSchema.optional(),
    expenses: z
      .object({
        range: reportRangeSchema,
        rows: z.array(reportRowSchema),
        totals: reportTotalsSchema,
      })
      .strict()
      .optional(),
  })
  .strict();
export type MoneyReportResponse = z.infer<typeof moneyReportResponseSchema>;

/* ----------------------------------------------------------------- why */

/**
 * "Why?" (§5.20) — the drill-down every important total supports.
 *
 * One endpoint with a subject rather than a drill-down per report: the answer
 * is always the same kind of thing, a list of the journal lines or stock
 * movements that add up to the figure. It is also the practical test of
 * INV-10 — a total that cannot name its sources was computed the wrong way.
 */
export const whySubjectSchema = z.enum([
  'ACCOUNT',
  'PARTY_BALANCE',
  'PRODUCT_STOCK',
  'PRODUCT_SALES',
  'PRODUCT_PURCHASES',
  'SALES_TOTAL',
  'EXPENSE_CATEGORY',
]);
export type WhySubject = z.infer<typeof whySubjectSchema>;

export const whyQuerySchema = z
  .object({
    subject: whySubjectSchema,
    /** Account code, party id, product id or category id — whichever the subject names. */
    key: z.string().max(64),
    from: BUSINESS_DATE,
    to: BUSINESS_DATE,
    limit: z.coerce.number().int().min(1).max(500).default(200),
  })
  .strict();
export type WhyQuery = z.infer<typeof whyQuerySchema>;

export const whyLineSchema = z
  .object({
    id: ULID,
    businessDate: BUSINESS_DATE,
    createdAt: z.string(),
    sourceType: z.string(),
    sourceId: ULID,
    sourceNumber: z.string(),
    description: z.string(),
    partyName: z.string().nullable(),
    amountMinor: z.number().int().nullable(),
    qty: z.number().int().nullable(),
    direction: z.enum(['IN', 'OUT']).nullable(),
  })
  .strict();
export type WhyLine = z.infer<typeof whyLineSchema>;

export const whyResponseSchema = z
  .object({
    subject: whySubjectSchema,
    key: z.string(),
    title: z.string(),
    range: reportRangeSchema,
    lines: z.array(whyLineSchema),
    totalMinor: z.number().int().nullable(),
    totalQty: z.number().int().nullable(),
    truncated: z.boolean(),
  })
  .strict();
export type WhyResponse = z.infer<typeof whyResponseSchema>;

/* --------------------------------------------------- performance & target */

export const performanceQuerySchema = z
  .object({
    from: BUSINESS_DATE,
    to: BUSINESS_DATE,
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .strict();
export type PerformanceQuery = z.infer<typeof performanceQuerySchema>;

export const performanceRowSchema = z
  .object({
    productId: ULID,
    productName: z.string(),
    unitName: z.string(),
    unitsSold: z.number().int(),
    revenueMinor: z.number().int(),
    costMinor: z.number().int().optional(),
    profitMinor: z.number().int().optional(),
    marginBp: z.number().int().optional(),
    stockTurnBp: z.number().int(),
  })
  .strict();
export type PerformanceRow = z.infer<typeof performanceRowSchema>;

export const performanceResponseSchema = z
  .object({
    range: reportRangeSchema,
    rows: z.array(performanceRowSchema),
    best: z.array(performanceRowSchema),
    worst: z.array(performanceRowSchema),
  })
  .strict();
export type PerformanceResponse = z.infer<typeof performanceResponseSchema>;

export const targetBasisSchema = z.enum(['PROFIT', 'SALES']);

export const setTargetRequestSchema = z
  .object({
    month: MONTH,
    basis: targetBasisSchema,
    amountMinor: z.number().int().nonnegative(),
  })
  .strict();
export type SetTargetRequest = z.infer<typeof setTargetRequestSchema>;

export const targetQuerySchema = z.object({ month: MONTH }).strict();
export type TargetQuery = z.infer<typeof targetQuerySchema>;

/**
 * `projectedMinor` is an **estimate** and is named so on every surface that
 * shows it (§5.20). It is never added into a posted total, and it is returned
 * beside the actual rather than instead of it.
 */
export const targetResponseSchema = z
  .object({
    month: MONTH,
    basis: targetBasisSchema,
    targetMinor: z.number().int().nullable(),
    actualMinor: z.number().int(),
    achievedBp: z.number().int().nullable(),
    projectedMinor: z.number().int(),
    projectedGapMinor: z.number().int().nullable(),
    elapsedDays: z.number().int(),
    daysInMonth: z.number().int(),
  })
  .strict();
export type TargetResponse = z.infer<typeof targetResponseSchema>;

/* ----------------------------------------------------------- dashboard */

export const dashboardSaleRowSchema = z
  .object({
    id: ULID,
    number: z.string(),
    customerName: z.string(),
    grandTotalMinor: z.number().int(),
    createdAt: z.string(),
  })
  .strict();
export type DashboardSaleRow = z.infer<typeof dashboardSaleRowSchema>;

/**
 * The dashboard's fixed card set (owner decision 2026-08-30).
 *
 * Every card is **optional in the response**: a card the user may not see is
 * absent from the body rather than sent and hidden by the browser (UI-40).
 * `profitProvisional` carries D-06 to the screen, which marks the card instead
 * of presenting a half-costed profit as final.
 */
export const dashboardResponseSchema = z
  .object({
    businessName: z.string(),
    businessDate: BUSINESS_DATE,
    todaySalesMinor: z.number().int().optional(),
    todaySaleCount: z.number().int().optional(),
    cashInHandMinor: z.number().int().optional(),
    bankBalanceMinor: z.number().int().optional(),
    stockValueMinor: z.number().int().optional(),
    customerDueMinor: z.number().int().optional(),
    supplierPayableMinor: z.number().int().optional(),
    lowStockCount: z.number().int().optional(),
    todayProfitMinor: z.number().int().optional(),
    profitProvisional: z.boolean().optional(),
    recentSales: z.array(dashboardSaleRowSchema).optional(),
    target: targetResponseSchema.optional(),
  })
  .strict();
export type DashboardResponse = z.infer<typeof dashboardResponseSchema>;
