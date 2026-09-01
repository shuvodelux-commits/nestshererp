import { fixedAccount } from '../accounting/account';
import { rejectEntry } from '../accounting/journal-entry';
import type { AccountCode } from '../accounting/account';
import type { JournalEntryDraft } from '../accounting/journal-entry';

/**
 * The cash or bank balance a migrating shop starts with (§5.6, §5.16, INV-07).
 *
 * The twin of `openingBalancePosting` for parties and `openingStockPosting` for
 * goods, and deliberately identical in shape: the money already in the till on
 * day one is a posted entry against `OPENING_EQUITY`, not a typed column on the
 * account. INV-07 defines a cash account's balance as the sum of its journal
 * lines, so an opening that did not post would make that false on day one and
 * every statement would begin from a figure nothing explains.
 */

export interface AccountOpeningDraft {
  /** `CASH:{id}`, `BANK:{id}` or `LOAN:{id}` — built by `accountCodeFor`. */
  readonly account: AccountCode;
  /** Always positive; there is no direction, so there is no sign to carry. */
  readonly amountMinor: number;
  /**
   * True for a liability — a loan the shop already owes on day one.
   *
   * The figure a shopkeeper types is the same positive number, but it means the
   * opposite thing: the account is **credited** and `OPENING_EQUITY` debited,
   * because a shop starting with a ৳50,000 loan starts ৳50,000 poorer, not
   * richer. Without this the loan would open as an asset and every money total
   * would be wrong by the size of the debt.
   */
  readonly owed?: boolean;
}

export type AccountOpeningRejection =
  | 'ACCOUNT_OPENING_AMOUNT_NOT_INTEGER_MINOR'
  | 'ACCOUNT_OPENING_AMOUNT_NOT_POSITIVE';

export function rejectAccountOpening(draft: AccountOpeningDraft): AccountOpeningRejection | null {
  if (!Number.isSafeInteger(draft.amountMinor)) return 'ACCOUNT_OPENING_AMOUNT_NOT_INTEGER_MINOR';
  // Zero is refused rather than posted as an empty document: an account with
  // nothing in it opens by simply having no opening, exactly as a party with no
  // outstanding balance does.
  if (draft.amountMinor <= 0) return 'ACCOUNT_OPENING_AMOUNT_NOT_POSITIVE';
  return null;
}

/**
 * Builds the balanced entry for an opening cash or bank balance.
 *
 * Debit the account, credit opening equity: the money exists, and what put it
 * there is the shop's own history from before SherERP knew about it.
 */
export function accountOpeningPosting(draft: AccountOpeningDraft): JournalEntryDraft {
  const rejection = rejectAccountOpening(draft);
  if (rejection !== null) throw new Error(`Account opening refused: ${rejection}`);

  const signed = draft.owed === true ? -draft.amountMinor : draft.amountMinor;
  const journal: JournalEntryDraft = {
    lines: [
      { account: draft.account, amountMinor: signed, partyId: null },
      { account: fixedAccount('OPENING_EQUITY'), amountMinor: -signed, partyId: null },
    ],
  };

  if (rejectEntry(journal) !== null) throw new Error('Account opening journal is not balanced');
  return journal;
}

/**
 * Correcting an opening that was typed wrong (§2.5).
 *
 * The same rule the party opening follows: nothing posted is edited. The
 * correction posts the **delta** between what was recorded and what it should
 * have been, so the account's balance lands on the right figure while both the
 * original entry and the correction stay on the statement. A shopkeeper reading
 * it sees what was first entered, that it was corrected, and what it became.
 *
 * Returns `null` when the figure has not actually changed — a correction of
 * nothing is a document that moves nothing, and §2.5 has no use for one.
 */
export function accountOpeningCorrectionPosting(
  account: AccountCode,
  previousAmountMinor: number,
  nextAmountMinor: number,
  /** True for a loan: a bigger opening debt is a bigger credit, not a debit. */
  owed = false,
): JournalEntryDraft | null {
  const change = nextAmountMinor - previousAmountMinor;
  if (change === 0) return null;
  const deltaMinor = owed ? -change : change;

  const journal: JournalEntryDraft = {
    lines: [
      { account, amountMinor: deltaMinor, partyId: null },
      { account: fixedAccount('OPENING_EQUITY'), amountMinor: -deltaMinor, partyId: null },
    ],
  };

  if (rejectEntry(journal) !== null) throw new Error('Account opening correction is not balanced');
  return journal;
}
