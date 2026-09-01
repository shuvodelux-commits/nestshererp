import { Qty } from '@sher/shared-utils';

/**
 * Goods lent to a vendor, and the rules for getting them back (Phase 8.3,
 * owner decision 2026-08-31: the mode is chosen per transaction).
 *
 * A **temporary issue** is custody, not commerce. The goods are still the
 * shop's, still in `INVENTORY` and still in its valuation; no journal entry
 * exists for one, because nothing has been bought, sold or owed. All that has
 * happened is that they are somewhere else — the same thing that happens when
 * stock moves between two of the shop's own locations.
 *
 * The one thing custody must not lose is **where each unit came from**. A
 * return puts the goods back into the very lots they left, at the cost they
 * left at, so FIFO order still means something afterwards and `INVENTORY` comes
 * back holding the number the shop actually paid. It is the same rule a
 * cancelled sales return follows, for the same reason.
 *
 * Pure: no clock, no I/O.
 */

export interface VendorIssueReturnDraft {
  readonly issuedQty: number;
  readonly returnedQty: number;
  readonly qty: number;
}

export type VendorIssueReturnRejection =
  | 'QTY_NOT_POSITIVE'
  | 'NOTHING_OUTSTANDING'
  | 'QTY_EXCEEDS_OUTSTANDING';

export function outstandingIssueQty(issuedQty: number, returnedQty: number): number {
  return Qty(issuedQty).subtract(Qty(returnedQty)).raw;
}

export function rejectVendorIssueReturn(
  draft: VendorIssueReturnDraft,
): VendorIssueReturnRejection | null {
  if (!Number.isSafeInteger(draft.qty) || draft.qty <= 0) return 'QTY_NOT_POSITIVE';
  const outstanding = outstandingIssueQty(draft.issuedQty, draft.returnedQty);
  if (outstanding <= 0) return 'NOTHING_OUTSTANDING';
  if (draft.qty > outstanding) return 'QTY_EXCEEDS_OUTSTANDING';
  return null;
}

/** One lot's share of a return, oldest issue-line first so provenance is stable. */
export interface IssueLotOutstanding {
  readonly id: string;
  readonly lotId: string;
  readonly unitCost: number;
  readonly qtyOutstanding: number;
}

export interface IssueLotRestore {
  readonly id: string;
  readonly lotId: string;
  readonly qty: number;
  readonly unitCost: number;
  readonly qtyOutstandingAfter: number;
}

/**
 * Spreads a partial return across the lots the goods left from.
 *
 * Deterministic and in the order the lots were taken, because the alternative —
 * putting the cheapest back first, say — would let a shopkeeper choose the
 * shop's own valuation by the order they hand goods back in.
 */
export function restoreToLots(
  lots: readonly IssueLotOutstanding[],
  qty: number,
): readonly IssueLotRestore[] {
  let remaining = Qty(qty).raw;
  const restores: IssueLotRestore[] = [];

  for (const lot of lots) {
    if (remaining === 0) break;
    if (lot.qtyOutstanding <= 0) continue;
    const take = Math.min(remaining, lot.qtyOutstanding);
    restores.push({
      id: lot.id,
      lotId: lot.lotId,
      qty: take,
      unitCost: lot.unitCost,
      qtyOutstandingAfter: Qty(lot.qtyOutstanding).subtract(Qty(take)).raw,
    });
    remaining = Qty(remaining).subtract(Qty(take)).raw;
  }

  if (remaining !== 0) {
    throw new RangeError('More goods were returned than this issue still has outstanding');
  }
  return restores;
}
