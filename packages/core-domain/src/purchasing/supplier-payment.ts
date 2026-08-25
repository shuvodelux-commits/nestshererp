import { fixedAccount } from '../accounting/account';
import type { AccountCode } from '../accounting/account';
import { rejectEntry } from '../accounting/journal-entry';
import type { JournalEntryDraft } from '../accounting/journal-entry';

/**
 * Money handed to a supplier against what the shop owes them (§5.9, §2.4).
 *
 * One movement, one party, one entry: `DR AP` (the debt shrinks) and `CR` the
 * account the money left. Which bills it settles is *allocation*, and allocation
 * moves no money — §5.9 is explicit that applying a payment "changes allocation
 * only". That is why the split is computed here and stored as links, and why
 * paying a whole supplier and paying one bill produce the same posting.
 */

export interface SupplierPaymentDraft {
  readonly amountMinor: number;
  /** What this supplier is owed right now, across every open bill. */
  readonly outstandingMinor: number;
}

export type SupplierPaymentRejection =
  | 'AMOUNT_NOT_INTEGER_MINOR'
  | 'AMOUNT_NOT_POSITIVE'
  | 'NOTHING_OUTSTANDING'
  | 'AMOUNT_EXCEEDS_OUTSTANDING';

export function rejectSupplierPayment(draft: SupplierPaymentDraft): SupplierPaymentRejection | null {
  if (!Number.isSafeInteger(draft.amountMinor)) return 'AMOUNT_NOT_INTEGER_MINOR';
  if (draft.amountMinor <= 0) return 'AMOUNT_NOT_POSITIVE';
  if (draft.outstandingMinor <= 0) return 'NOTHING_OUTSTANDING';

  /*
   * Paying more than is owed is refused in this slice rather than turned into a
   * supplier credit. §5.9 does define over-application as a credit, but the
   * screens that let a shopkeeper *see* and *apply* a credit are the next build;
   * accepting the money now would leave an advance sitting in the ledger with
   * nowhere in the app to spend it, which reads as money lost.
   */
  if (draft.amountMinor > draft.outstandingMinor) return 'AMOUNT_EXCEEDS_OUTSTANDING';

  return null;
}

export function supplierPaymentPosting(
  account: AccountCode,
  supplierPartyId: string,
  amountMinor: number,
): JournalEntryDraft {
  const journal: JournalEntryDraft = {
    lines: [
      { account: fixedAccount('AP'), amountMinor, partyId: supplierPartyId },
      { account, amountMinor: -amountMinor, partyId: null },
    ],
  };

  if (rejectEntry(journal) !== null) throw new Error('Supplier payment journal is not balanced');
  return journal;
}

/** One open bill, in the order it should be settled. */
export interface OpenBill {
  readonly purchaseId: string;
  readonly outstandingMinor: number;
}

export interface BillAllocation {
  readonly purchaseId: string;
  readonly amountMinor: number;
}

/**
 * Spreads a payment over the bills it settles, oldest first.
 *
 * Oldest-first is the owner's choice and the shop's habit: the supplier chasing
 * a shopkeeper is chasing the oldest bill, and a payment that quietly settled
 * the newest would leave that conversation unresolved while the ledger says the
 * money was paid. The caller supplies the order — this only fills bills up in
 * the order it is given, so "one exact bill" is the same function with a list
 * of one.
 */
export function allocateOldestFirst(
  bills: readonly OpenBill[],
  amountMinor: number,
): readonly BillAllocation[] {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new RangeError('A payment must be a positive whole amount');
  }

  const allocations: BillAllocation[] = [];
  let left = amountMinor;

  for (const bill of bills) {
    if (left === 0) break;
    if (bill.outstandingMinor <= 0) continue;
    const applied = Math.min(left, bill.outstandingMinor);
    allocations.push({ purchaseId: bill.purchaseId, amountMinor: applied });
    left -= applied;
  }

  // Every taka must land on a bill. Anything left over would be an advance, and
  // `rejectSupplierPayment` has already refused that case — reaching here means
  // the caller passed bills that do not add up to what it said was outstanding.
  if (left > 0) throw new RangeError('The payment is larger than the bills it was given');

  return allocations;
}
