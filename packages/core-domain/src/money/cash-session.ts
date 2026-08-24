import { fixedAccount } from '../accounting/account';
import { rejectEntry } from '../accounting/journal-entry';
import type { AccountCode } from '../accounting/account';
import type { JournalEntryDraft } from '../accounting/journal-entry';

/**
 * The business day at the drawer (§5.16) — the arithmetic, and nothing else.
 *
 * §5.16.7 lists six quantities the system must never collapse into one another:
 * the previous day's expected, the previous day's counted, the new day's
 * opening, what moved between the two, the shortage or overage, and the reason
 * given. Every function here keeps them apart, and the two postings below are
 * the only ways a cash session moves value.
 *
 * **The expected figure is computed once and stored** (§5.16.4). Nothing in
 * this file recomputes it from a later state of the world: a correction posted
 * next month must not change what the system expected at the historical close,
 * or Daily Cash would quietly rewrite the past every time someone fixed an
 * invoice.
 *
 * Pure: no clock, no I/O. The application layer owns dates, numbering,
 * permissions and who may reopen.
 */

export type CashSessionStatus = 'OPEN' | 'CLOSED';

/** How a day's count came out, in the shop's terms rather than the ledger's. */
export type CashDifferenceKind = 'MATCHED' | 'SHORT' | 'OVER';

export interface CashSessionTotals {
  readonly openingAmountMinor: number;
  readonly cashInMinor: number;
  readonly cashOutMinor: number;
}

export interface CashCloseFigures extends CashSessionTotals {
  readonly expectedClosingMinor: number;
  readonly countedClosingMinor: number;
  readonly differenceMinor: number;
  readonly kind: CashDifferenceKind;
}

export type CashCloseRejection =
  | 'COUNT_NOT_INTEGER_MINOR'
  | 'COUNT_NEGATIVE'
  | 'REASON_REQUIRED_FOR_DIFFERENCE';

/** `Expected Closing Cash = Opening Cash + Cash In − Cash Out` (§5.16.4). */
export function expectedClosing(totals: CashSessionTotals): number {
  return totals.openingAmountMinor + totals.cashInMinor - totals.cashOutMinor;
}

/**
 * `Cash Difference = Actual Closing Cash − Expected Closing Cash` (§5.16.4).
 *
 * Signed, and the sign is the whole meaning: negative is money missing from the
 * drawer, positive is money that should not be there. Both are real and both
 * post — see `cashDifferencePosting`.
 */
export function cashDifference(expectedMinor: number, countedMinor: number): number {
  return countedMinor - expectedMinor;
}

export function differenceKindOf(differenceMinor: number): CashDifferenceKind {
  if (differenceMinor === 0) return 'MATCHED';
  return differenceMinor < 0 ? 'SHORT' : 'OVER';
}

/**
 * Everything a close records, computed together so the stored row cannot hold
 * an expected and a difference that disagree.
 */
export function closeFigures(totals: CashSessionTotals, countedMinor: number): CashCloseFigures {
  const expectedClosingMinor = expectedClosing(totals);
  const differenceMinor = cashDifference(expectedClosingMinor, countedMinor);

  return {
    ...totals,
    expectedClosingMinor,
    countedClosingMinor: countedMinor,
    differenceMinor,
    kind: differenceKindOf(differenceMinor),
  };
}

/** Returns the first reason the day cannot be closed with this count, or `null`. */
export function rejectCashClose(countedMinor: number): CashCloseRejection | null {
  if (!Number.isSafeInteger(countedMinor)) return 'COUNT_NOT_INTEGER_MINOR';

  // Zero is a legitimate count — a shop can bank everything and leave the
  // drawer empty. Negative is not something anyone can have counted.
  if (countedMinor < 0) return 'COUNT_NEGATIVE';

  return null;
}

/**
 * The second half of the close check, once the difference is known.
 *
 * Split from `rejectCashClose` because the reason is only required when the
 * count disagrees with the system (§5.16.4), and that is not knowable from the
 * count alone. A difference with no reason is the case §5.16.7 (6) exists to
 * prevent: a number nobody has to explain is a number nobody investigates.
 */
export function rejectCashCloseReason(
  differenceMinor: number,
  reason: string | null,
): CashCloseRejection | null {
  if (differenceMinor !== 0 && (reason === null || reason.trim().length === 0)) {
    return 'REASON_REQUIRED_FOR_DIFFERENCE';
  }
  return null;
}

/**
 * The shortage or overage posting made when the day closes (§5.16.4).
 *
 * | Shortage | `DR CASH_SHORT_OVER / CR CASH:{id}` |
 * | Overage  | `DR CASH:{id} / CR CASH_SHORT_OVER` |
 *
 * After it, `CASH:{id}` equals the counted cash — that is INV-07b, and it is
 * why the difference cannot live on the session row alone: a shortage that
 * never reached the journal would leave the ledger claiming money the drawer
 * does not contain, and the cash report and the accounts would disagree by
 * exactly the amount somebody needs to explain.
 *
 * A shortage is a real cost and lands in the P&L through `CASH_SHORT_OVER`. It
 * is never netted against the next day's opening (§5.16.5 case C).
 *
 * Returns `null` for a matched day: there is nothing to post, and an entry of
 * zero is refused by the kernel anyway.
 */
export function cashDifferencePosting(
  account: AccountCode,
  differenceMinor: number,
): JournalEntryDraft | null {
  if (differenceMinor === 0) return null;

  // The cash side simply *is* the difference: negative when money is missing
  // (a credit to cash), positive when there is more than expected.
  const journal: JournalEntryDraft = {
    lines: [
      { account, amountMinor: differenceMinor, partyId: null },
      { account: fixedAccount('CASH_SHORT_OVER'), amountMinor: -differenceMinor, partyId: null },
    ],
  };

  if (rejectEntry(journal) !== null) throw new Error('Cash difference journal is not balanced');
  return journal;
}

/**
 * The reversal posted when a day closed by mistake is reopened (§5.16.4, owner
 * decision 2026-08-24).
 *
 * Equal and opposite to the close's own difference posting, on the **same**
 * business date, so the day it belongs to carries both and nets to nothing. The
 * original entry is never edited or deleted — the shop can still see what was
 * counted, what it cost, and that it was undone.
 *
 * Returns `null` when the mistaken close posted nothing, which is the common
 * case: a day that matched has no difference to reverse.
 */
export function cashDifferenceReversal(
  account: AccountCode,
  differenceMinor: number,
): JournalEntryDraft | null {
  return cashDifferencePosting(account, -differenceMinor);
}

/**
 * Whether the day the shop is trying to open is the one that may be opened.
 *
 * §5.16 gives the drawer one day at a time and no way to run two. The previous
 * day must be closed first (owner decision 2026-08-24) — never auto-closed at
 * expected, because closing at expected declares a count nobody made and
 * collapses quantities (1) and (2) of §5.16.7 into each other.
 */
export type StartDayRejection =
  | 'PREVIOUS_DAY_NOT_CLOSED'
  | 'DAY_ALREADY_STARTED'
  | 'OPENING_NOT_INTEGER_MINOR'
  | 'OPENING_NEGATIVE'
  | 'OPENING_DIFFERENCE_NEEDS_COUNTERPART';

export interface StartDayDraft {
  /** The counted physical cash going into the drawer (§5.16.2). */
  readonly openingAmountMinor: number;
  /**
   * What the drawer's journal lines say it holds right now (INV-07).
   *
   * **This, not the previous close, is what the opening is measured against** —
   * and on every day after the shop's first they are the same number, because
   * the close's difference posting leaves `CASH:{id}` equal to what was counted
   * (§5.16.4, INV-07b). So §5.16.5's table is unchanged in normal trading.
   *
   * The day it matters is the first one. There is no previous close to compare
   * with, and a shop that puts ৳20,000 into the drawer on day one has cash the
   * ledger knows nothing about. Measuring against the previous close alone
   * would post nothing, and the drawer and the ledger would begin their life
   * disagreeing by exactly the opening — which is INV-07b false from the first
   * hour and never explained afterwards. Measuring against the ledger asks the
   * one useful question instead: that money came from somewhere, where?
   */
  readonly ledgerBalanceMinor: number;
  /** Whether an earlier day is still open. */
  readonly hasUnclosedEarlierDay: boolean;
  /** Whether this business date already has a session. */
  readonly dayAlreadyStarted: boolean;
  /**
   * The other side of an opening that differs from the previous close: another
   * cash account, a bank account, or the owner (§5.16.5). Cash never leaves or
   * arrives without a named counterpart, which is why this is an account code
   * and not a sentence.
   */
  readonly counterpart: AccountCode | null;
}

export function rejectStartDay(draft: StartDayDraft): StartDayRejection | null {
  if (draft.hasUnclosedEarlierDay) return 'PREVIOUS_DAY_NOT_CLOSED';
  if (draft.dayAlreadyStarted) return 'DAY_ALREADY_STARTED';
  if (!Number.isSafeInteger(draft.openingAmountMinor)) return 'OPENING_NOT_INTEGER_MINOR';
  if (draft.openingAmountMinor < 0) return 'OPENING_NEGATIVE';

  if (openingDifference(draft) !== 0 && draft.counterpart === null) {
    return 'OPENING_DIFFERENCE_NEEDS_COUNTERPART';
  }

  return null;
}

/**
 * How far the counted opening is from what the ledger already holds.
 *
 * On any day after the first this is §5.16.5's "difference from previous
 * actual" exactly, because the previous close left the account equal to what
 * was counted. On the first day it is the whole opening, which is the honest
 * answer: the drawer holds money the books have never seen, and §5.16.5's rule
 * that cash always has a named source is precisely what should apply to it.
 */
export function openingDifference(draft: {
  readonly openingAmountMinor: number;
  readonly ledgerBalanceMinor: number;
}): number {
  return draft.openingAmountMinor - draft.ledgerBalanceMinor;
}
