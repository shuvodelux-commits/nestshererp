import { fixedAccount } from '../accounting/account';
import type { AccountCode } from '../accounting/account';
import { rejectEntry } from '../accounting/journal-entry';
import type { JournalEntryDraft } from '../accounting/journal-entry';

/**
 * Money between the shop and a vendor (Phase 8.3, §5.6 M07, DR13.10, owner
 * decisions 2026-08-31).
 *
 * **Two of the four movements a vendor can make are not here**, because they
 * are not the vendor's own: goods charged to a vendor create an ordinary
 * receivable on `AR` and are settled by an ordinary customer receipt, and both
 * of those already have a posting of their own. What is left is what only a
 * vendor has — `VENDOR_PAYABLE`, which the deemed purchase creates when one of
 * their consignment items sells, and `VENDOR_ADVANCE`, which is money resting
 * with a vendor before any of it has sold.
 *
 * **The intent is given, never inferred.** A shopkeeper handing over cash knows
 * whether they are clearing a debt or paying ahead; the ledger afterwards
 * cannot tell, and a rule that guessed from the sign of the balance would post
 * the first advance of a new season as a settlement.
 *
 * Pure: no clock, no I/O, integer poisha in and out. Positive is a debit,
 * matching every other posting in this codebase.
 */

/** Which of a vendor's two balances the money is moving against. */
export type VendorPaymentIntent = 'SETTLE_PAYABLE' | 'ADVANCE';
export type VendorReceiptIntent = 'REFUND_ADVANCE';

export interface VendorPaymentDraft {
  readonly amountMinor: number;
  /**
   * What the shop owes this vendor right now, from the journal (INV-06).
   * Only consulted for a settlement — an advance is by definition paid when
   * nothing is owed yet.
   */
  readonly payableMinor: number;
  readonly intent: VendorPaymentIntent;
}

export type VendorPaymentRejection =
  | 'AMOUNT_NOT_INTEGER_MINOR'
  | 'AMOUNT_NOT_POSITIVE'
  | 'NOTHING_PAYABLE'
  | 'AMOUNT_EXCEEDS_PAYABLE';

export function rejectVendorPayment(draft: VendorPaymentDraft): VendorPaymentRejection | null {
  if (!Number.isSafeInteger(draft.amountMinor)) return 'AMOUNT_NOT_INTEGER_MINOR';
  if (draft.amountMinor <= 0) return 'AMOUNT_NOT_POSITIVE';

  /*
   * An advance is unbounded on purpose: there is nothing to exceed. A
   * settlement is bounded by what is owed, exactly as a supplier payment is —
   * paying past the debt would leave an advance sitting on the payable account,
   * where the workspace's own Advance action already puts it properly.
   */
  if (draft.intent === 'ADVANCE') return null;
  if (draft.payableMinor <= 0) return 'NOTHING_PAYABLE';
  if (draft.amountMinor > draft.payableMinor) return 'AMOUNT_EXCEEDS_PAYABLE';

  return null;
}

/**
 * `DR VENDOR_PAYABLE` (the debt shrinks) or `DR VENDOR_ADVANCE` (money now
 * resting with them), `CR` the account it left.
 *
 * Both carry the vendor's `party_id`, which is what puts the movement on their
 * ledger and into their balance (INV-06) without any balance column existing.
 */
export function vendorPaymentPosting(
  account: AccountCode,
  vendorPartyId: string,
  amountMinor: number,
  intent: VendorPaymentIntent,
): JournalEntryDraft {
  const journal: JournalEntryDraft = {
    lines: [
      {
        account: fixedAccount(intent === 'SETTLE_PAYABLE' ? 'VENDOR_PAYABLE' : 'VENDOR_ADVANCE'),
        amountMinor,
        partyId: vendorPartyId,
      },
      { account, amountMinor: -amountMinor, partyId: null },
    ],
  };

  if (rejectEntry(journal) !== null) throw new Error('Vendor payment journal is not balanced');
  return journal;
}

export interface VendorReceiptDraft {
  readonly amountMinor: number;
  /** The advance still sitting with this vendor, from the journal. */
  readonly advanceMinor: number;
}

export type VendorReceiptRejection =
  | 'AMOUNT_NOT_INTEGER_MINOR'
  | 'AMOUNT_NOT_POSITIVE'
  | 'NO_ADVANCE_HELD'
  | 'AMOUNT_EXCEEDS_ADVANCE';

export function rejectVendorReceipt(draft: VendorReceiptDraft): VendorReceiptRejection | null {
  if (!Number.isSafeInteger(draft.amountMinor)) return 'AMOUNT_NOT_INTEGER_MINOR';
  if (draft.amountMinor <= 0) return 'AMOUNT_NOT_POSITIVE';
  /*
   * A refund is bounded by the advance because it is the *return* of one. Money
   * arriving from a vendor beyond that is not a refund at all — it is either
   * settlement of goods charged to them, which is a customer receipt, or income
   * with no document behind it, which this module will not invent.
   */
  if (draft.advanceMinor <= 0) return 'NO_ADVANCE_HELD';
  if (draft.amountMinor > draft.advanceMinor) return 'AMOUNT_EXCEEDS_ADVANCE';
  return null;
}

/** `DR` the account the money arrived in, `CR VENDOR_ADVANCE` — it is spent. */
export function vendorReceiptPosting(
  account: AccountCode,
  vendorPartyId: string,
  amountMinor: number,
): JournalEntryDraft {
  const journal: JournalEntryDraft = {
    lines: [
      { account, amountMinor, partyId: null },
      { account: fixedAccount('VENDOR_ADVANCE'), amountMinor: -amountMinor, partyId: vendorPartyId },
    ],
  };

  if (rejectEntry(journal) !== null) throw new Error('Vendor receipt journal is not balanced');
  return journal;
}
