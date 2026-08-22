import { fixedAccount } from '../accounting/account';
import { rejectEntry } from '../accounting/journal-entry';
import type { JournalEntryDraft } from '../accounting/journal-entry';
import type { PartyRole } from './party';

/**
 * The opening receivable or payable a shop starts with (§5.0, §5.6, INV-06).
 *
 * A shop migrating onto SherERP already has customers who owe it money and
 * suppliers it owes. That figure has to enter the system somewhere, and §5.6 is
 * explicit that it must not be a column on the party — a typed balance is a
 * number with no journal behind it, so INV-06's "a balance is the sum of the
 * lines" would be false on day one and every statement would start from a
 * figure nothing explains.
 *
 * So an opening balance is a posted entry like any other, against
 * `OPENING_EQUITY`, exactly as opening stock is. This module decides which
 * account the party side lands on; the application layer owns the document,
 * the date and the numbering.
 */

/** Which way the opening points, in the shopkeeper's words. */
export type OpeningBalanceDirection = 'RECEIVABLE' | 'PAYABLE';

export type OpeningBalanceRejection =
  | 'OPENING_AMOUNT_NOT_INTEGER_MINOR'
  | 'OPENING_AMOUNT_NOT_POSITIVE'
  | 'OPENING_DIRECTION_NOT_VALID_FOR_ROLE';

export interface OpeningBalanceDraft {
  readonly partyId: string;
  /** The role this opening is being entered against — a party may hold several. */
  readonly role: PartyRole;
  readonly direction: OpeningBalanceDirection;
  /** Always positive; `direction` carries the sign. */
  readonly amountMinor: number;
}

export interface OpeningBalancePosting {
  readonly amountMinor: number;
  readonly direction: OpeningBalanceDirection;
  readonly journal: JournalEntryDraft;
}

/**
 * Which directions each role can legitimately open with.
 *
 * A customer normally owes the shop, and a supplier is normally owed — but both
 * reverse in practice: a customer who paid a deposit before go-live is a real
 * opening payable, and a supplier holding the shop's advance is a real opening
 * receivable. Refusing those would force a shopkeeper to lie about the
 * direction to get the number in, so both are allowed for both roles.
 *
 * `VENDOR` is payable-only. A vendor is someone the shop pays for work; a
 * vendor owing the shop money is not a case §5.6 describes, and silently
 * accepting it would post to `VENDOR_ADVANCE` on an opening where a mistyped
 * direction is far more likely than the real thing.
 */
const DIRECTIONS_BY_ROLE: Readonly<Record<PartyRole, readonly OpeningBalanceDirection[]>> = {
  CUSTOMER: ['RECEIVABLE', 'PAYABLE'],
  SUPPLIER: ['RECEIVABLE', 'PAYABLE'],
  VENDOR: ['PAYABLE'],
};

/**
 * The account a party's opening lands on, given their role and direction.
 *
 * A receivable from a customer is plain `AR`. A receivable from a supplier is
 * *not* `AR` — it is money paid ahead, which is `SUPPLIER_ADVANCE`, and posting
 * it to `AR` would put a supplier into the sales-side control account and make
 * the receivables report disagree with the customer statements under it.
 */
function accountFor(role: PartyRole, direction: OpeningBalanceDirection) {
  if (role === 'CUSTOMER') {
    return direction === 'RECEIVABLE' ? fixedAccount('AR') : fixedAccount('CUSTOMER_ADVANCE');
  }
  if (role === 'SUPPLIER') {
    return direction === 'RECEIVABLE' ? fixedAccount('SUPPLIER_ADVANCE') : fixedAccount('AP');
  }
  return fixedAccount('VENDOR_PAYABLE');
}

/** Returns the first reason the opening cannot be posted, or `null`. */
export function rejectOpeningBalance(draft: OpeningBalanceDraft): OpeningBalanceRejection | null {
  if (!Number.isSafeInteger(draft.amountMinor)) return 'OPENING_AMOUNT_NOT_INTEGER_MINOR';

  // Zero is refused rather than treated as "no opening". A caller with nothing
  // to open should not build a draft at all, and an entry of zero would be a
  // document in the ledger that moves nothing.
  if (draft.amountMinor <= 0) return 'OPENING_AMOUNT_NOT_POSITIVE';

  if (!DIRECTIONS_BY_ROLE[draft.role].includes(draft.direction)) {
    return 'OPENING_DIRECTION_NOT_VALID_FOR_ROLE';
  }

  return null;
}

/**
 * Builds the balanced entry for an opening balance.
 *
 * Throws on a draft `rejectOpeningBalance` would refuse: by this point the
 * application layer has already checked and turned any refusal into something
 * the user can read, so reaching here with a bad draft is a bug, not input.
 */
export function openingBalancePosting(draft: OpeningBalanceDraft): OpeningBalancePosting {
  const rejection = rejectOpeningBalance(draft);
  if (rejection !== null) throw new Error(`Opening balance refused: ${rejection}`);

  const account = accountFor(draft.role, draft.direction);
  // A receivable is a debit to the party side and a credit to opening equity;
  // a payable is the mirror. `direction` is the only thing that flips the sign.
  const partyAmount =
    draft.direction === 'RECEIVABLE' ? draft.amountMinor : -draft.amountMinor;

  const journal: JournalEntryDraft = {
    lines: [
      { account, amountMinor: partyAmount, partyId: draft.partyId },
      { account: fixedAccount('OPENING_EQUITY'), amountMinor: -partyAmount, partyId: null },
    ],
  };

  if (rejectEntry(journal) !== null) throw new Error('Opening balance journal is not balanced');

  return { amountMinor: draft.amountMinor, direction: draft.direction, journal };
}
