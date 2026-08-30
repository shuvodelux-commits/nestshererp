/**
 * How an unpaid amount is aged on the Money reports (§5.20, owner decision
 * 2026-08-30).
 *
 * Age is counted from the **document date** — the day the invoice or the bill
 * was made — never from the due date. Phase 5 made the due date optional
 * because most suppliers here never name one, so ageing from it would put two
 * equally old amounts in different buckets depending on whether somebody
 * happened to type a day. Overdue is a separate flag on the rows that do carry
 * a due date, not a bucket of its own.
 *
 * `ageingBucket` in `sales/sale.ts` is a different rule for a different
 * question — what one invoice's own header says about itself — and is left
 * alone deliberately.
 */

export type ReportAgeingBucket = 'D0_30' | 'D31_60' | 'D61_90' | 'D90_PLUS';

export const REPORT_AGEING_BUCKETS: readonly ReportAgeingBucket[] = [
  'D0_30',
  'D31_60',
  'D61_90',
  'D90_PLUS',
];

/** Whole days between two `YYYY-MM-DD` business dates, in UTC (§3.5). */
export function daysOutstanding(businessDate: string, asOf: string): number {
  const start = Date.parse(`${businessDate}T00:00:00Z`);
  const end = Date.parse(`${asOf}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) throw new RangeError('Invalid business date');
  return Math.round((end - start) / 86_400_000);
}

export function reportAgeingBucket(businessDate: string, asOf: string): ReportAgeingBucket {
  // A document dated in the future ages as zero days rather than negative: it
  // is money owed today, and no bucket below D0_30 exists to put it in.
  const days = Math.max(daysOutstanding(businessDate, asOf), 0);
  if (days <= 30) return 'D0_30';
  if (days <= 60) return 'D31_60';
  if (days <= 90) return 'D61_90';
  return 'D90_PLUS';
}

/** Overdue is only ever a statement about a document that named a day. */
export function isOverdue(dueDate: string | null, asOf: string): boolean {
  return dueDate !== null && asOf > dueDate;
}

export interface AgeingDocument {
  readonly businessDate: string;
  readonly dueDate: string | null;
  readonly outstandingMinor: number;
}

export interface AgeingTotals {
  readonly buckets: Readonly<Record<ReportAgeingBucket, number>>;
  readonly totalMinor: number;
  readonly overdueMinor: number;
}

/**
 * Totals a set of outstanding documents into the four buckets.
 *
 * The sum of the buckets is the total, always — which is what lets the screen
 * claim the total reconciles to the AR or AP control account (§5.20). Nothing
 * is dropped, so a document with a zero or negative outstanding still lands in
 * a bucket rather than quietly disappearing from the reconciliation.
 */
export function ageingTotals(documents: readonly AgeingDocument[], asOf: string): AgeingTotals {
  const buckets: Record<ReportAgeingBucket, number> = {
    D0_30: 0, D31_60: 0, D61_90: 0, D90_PLUS: 0,
  };
  let totalMinor = 0;
  let overdueMinor = 0;

  for (const item of documents) {
    const bucket = reportAgeingBucket(item.businessDate, asOf);
    buckets[bucket] += item.outstandingMinor;
    totalMinor += item.outstandingMinor;
    if (isOverdue(item.dueDate, asOf)) overdueMinor += item.outstandingMinor;
  }

  return { buckets, totalMinor, overdueMinor };
}
