import { rejectEntry } from '../accounting/journal-entry';
import type { AccountCode } from '../accounting/account';
import type { JournalEntryDraft } from '../accounting/journal-entry';

/**
 * Money crossing from one named place to another (§5.16.3, §5.16.5).
 *
 * Owner injections and withdrawals, transfers between cash boxes, bank deposits
 * and withdrawals, and the Start Day opening adjustment are **one movement**
 * with two account sides — not five kinds of document. Every one of them is the
 * same event: value leaves somewhere named and arrives somewhere named.
 *
 * That is not a tidiness argument. §5.16.5 says cash always has a named
 * destination — "Case B has no 'unexplained' option" — and the way to make that
 * true in code is for the movement to be unable to exist without both sides.
 * A movement with a nullable other side would be an invitation to write one.
 *
 * `kind` is what the screen and the reports call it. The journal is built from
 * the two account codes alone, so a mislabelled kind can misdescribe a movement
 * but can never misplace the money.
 */

export const CASH_MOVEMENT_KINDS = [
  'OWNER_INJECTION',
  'OWNER_WITHDRAWAL',
  'TRANSFER',
  'OPENING_ADJUSTMENT',
  /*
   * Finance module, owner decision 2026-08-31. Taking a loan and repaying it
   * are the same two-sided movement as everything above — money arrives from
   * `LOAN:{id}` or goes back to it — so they are two more kinds rather than a
   * second document with a posting path of its own. Principal only: the
   * interest inside an instalment is a cost of running the shop and is
   * recorded as an expense, in the module that already owns expenses.
   */
  'LOAN_RECEIVED',
  'LOAN_REPAYMENT',
] as const;

export type CashMovementKind = (typeof CASH_MOVEMENT_KINDS)[number];

export interface CashMovementDraft {
  readonly kind: CashMovementKind;
  /** Where the money left. Credited. */
  readonly fromAccount: AccountCode;
  /** Where it arrived. Debited. */
  readonly toAccount: AccountCode;
  /** Always positive — the two sides carry the direction, not the sign. */
  readonly amountMinor: number;
}

export type CashMovementRejection =
  | 'MOVEMENT_AMOUNT_NOT_INTEGER_MINOR'
  | 'MOVEMENT_AMOUNT_NOT_POSITIVE'
  | 'MOVEMENT_SIDES_IDENTICAL';

export function rejectCashMovement(draft: CashMovementDraft): CashMovementRejection | null {
  if (!Number.isSafeInteger(draft.amountMinor)) return 'MOVEMENT_AMOUNT_NOT_INTEGER_MINOR';
  if (draft.amountMinor <= 0) return 'MOVEMENT_AMOUNT_NOT_POSITIVE';

  // Money that leaves an account and arrives at the same one has not moved. It
  // would post a self-cancelling pair and inflate the day's cash in *and* cash
  // out by an amount that never crossed the counter.
  if (draft.fromAccount === draft.toAccount) return 'MOVEMENT_SIDES_IDENTICAL';

  return null;
}

/**
 * Builds the two-line entry for a movement: debit where it arrived, credit
 * where it left.
 *
 * Every §5.16.5 case is this one function. An owner injection is
 * `OWNER_CURRENT_ACCOUNT → CASH:drawer`; money to the safe is
 * `CASH:drawer → CASH:safe`; a bank deposit is `CASH:drawer → BANK:x`. The
 * table in §5.16.5 is a table of which two codes to pass, nothing more.
 */
export function cashMovementPosting(draft: CashMovementDraft): JournalEntryDraft {
  const rejection = rejectCashMovement(draft);
  if (rejection !== null) throw new Error(`Cash movement refused: ${rejection}`);

  const journal: JournalEntryDraft = {
    lines: [
      { account: draft.toAccount, amountMinor: draft.amountMinor, partyId: null },
      { account: draft.fromAccount, amountMinor: -draft.amountMinor, partyId: null },
    ],
  };

  if (rejectEntry(journal) !== null) throw new Error('Cash movement journal is not balanced');
  return journal;
}

/**
 * Which way an opening adjustment points (§5.16.5 cases A and B).
 *
 * Case A — the drawer opens with *more* than last night's count: the extra came
 * from somewhere, so that somewhere is the `from` side.
 * Case B — it opens with *less*: the missing part went somewhere, so that
 * somewhere is the `to` side.
 *
 * Callers pass the signed difference and the counterpart the user declared; the
 * drawer is the other side either way.
 */
export function openingAdjustmentSides(
  drawerAccount: AccountCode,
  counterpart: AccountCode,
  differenceMinor: number,
): { readonly fromAccount: AccountCode; readonly toAccount: AccountCode; readonly amountMinor: number } {
  if (differenceMinor === 0) throw new Error('Opening adjustment with no difference');

  return differenceMinor > 0
    ? { fromAccount: counterpart, toAccount: drawerAccount, amountMinor: differenceMinor }
    : { fromAccount: drawerAccount, toAccount: counterpart, amountMinor: -differenceMinor };
}
