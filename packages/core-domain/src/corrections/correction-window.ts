/**
 * When a correction posts, and under what name (§2.5, owner decision
 * 2026-08-30).
 *
 * Three cases, and the difference between them is the whole rule:
 *
 * - **The original month is open.** The correction carries the original
 *   business date, so the day it really happened is the day that changes.
 * - **The original month is closed.** Closed is final (Phase 7): nothing may
 *   post into it, ever. The correction therefore posts into the **current open
 *   period** as a **prior-period adjustment**, keeping the original date beside
 *   it so every screen can say what it is a correction *of*. Last month's
 *   totals — which somebody may already have printed, filed or shown to a
 *   lender — are never rewritten behind their back.
 * - **A cancellation** always carries the day it was cancelled. The goods or
 *   the money came back today; dating that to when the document was first
 *   posted would claim they never left.
 *
 * A reason is required whenever the correction cannot post on its own date,
 * because that is exactly when the ledger's own before/after values stop
 * explaining what happened.
 */

export type CorrectionEntryMode = 'CORRECTED' | 'PRIOR_PERIOD';

export interface CorrectionWindow {
  /** The business date the correction's entry is posted under. */
  readonly businessDate: string;
  readonly entryMode: CorrectionEntryMode;
  /** The day the corrected transaction really belongs to; kept when they differ. */
  readonly originalBusinessDate: string | null;
  /** True when the shopkeeper must say why before it will post. */
  readonly reasonRequired: boolean;
}

export function correctionWindow(
  originalBusinessDate: string,
  today: string,
  originalPeriodOpen: boolean,
): CorrectionWindow {
  if (!originalPeriodOpen) {
    return {
      businessDate: today,
      entryMode: 'PRIOR_PERIOD',
      originalBusinessDate,
      reasonRequired: true,
    };
  }

  return {
    businessDate: originalBusinessDate,
    entryMode: 'CORRECTED',
    // Same day, same meaning: nothing to keep, and a column repeating the
    // business date would only be one more thing that can disagree with it.
    originalBusinessDate: originalBusinessDate === today ? null : originalBusinessDate,
    // A correction dated before today is a backdated entry by §5.14's own
    // definition, and those have always required a reason.
    reasonRequired: originalBusinessDate !== today,
  };
}

/** A cancellation is posted on the day it is made, never on the original day. */
export function cancellationDate(today: string): string {
  return today;
}
