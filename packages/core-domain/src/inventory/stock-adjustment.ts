import { Qty } from '@sher/shared-utils';

import { fixedAccount } from '../accounting/account';
import type { AccountCode } from '../accounting/account';
import { rejectEntry } from '../accounting/journal-entry';
import type { JournalEntryDraft } from '../accounting/journal-entry';

/**
 * Correcting stock that is already on the shelf (§5.10, §5.13).
 *
 * This is the routine face of stock reconciliation: a shopkeeper finds five
 * broken pipes, or counts the shelf and it comes up two short. §5.13's rule is
 * that there is **no direct silent quantity manipulation** — the correction is
 * a posted document with a movement and a journal entry behind it, exactly like
 * a purchase, not an edit of a displayed number.
 *
 * The value goes to `STOCK_ADJUSTMENT` (§2.4, owner decision 2026-08-20), the
 * stock twin of `CASH_SHORT_OVER`. It is deliberately not `COGS` — goods lost
 * to damage were never sold, and burying them in cost of sales would quietly
 * ruin the margin figure — and not `OPENING_EQUITY`, which is for openings.
 *
 * Pure: no clock, no I/O, no floating point.
 */

/**
 * Why the stock changed. Closed, because the Damaged & Written-off report
 * groups by it, and free text cannot be grouped.
 *
 * `RECOUNT` is a physical count that disagreed with the system and is the
 * §5.13 case; `THEFT_LOSS` is shrinkage; `DAMAGE` is goods that still exist but
 * cannot be sold. `OTHER` exists so a shop is never forced to file something
 * under a wrong reason, and is the only one that demands a note.
 */
export const STOCK_ADJUSTMENT_REASONS = ['DAMAGE', 'RECOUNT', 'THEFT_LOSS', 'OTHER'] as const;

export type StockAdjustmentReason = (typeof STOCK_ADJUSTMENT_REASONS)[number];

export type StockAdjustmentRejection =
  | 'QUANTITY_IS_ZERO'
  | 'QUANTITY_NOT_INTEGER_MINOR'
  | 'UNKNOWN_REASON'
  | 'NOTE_REQUIRED_FOR_OTHER'
  | 'ADJUSTMENT_HAS_NO_VALUE';

export interface StockAdjustmentDraft {
  /** Signed, at `Qty` scale: positive adds stock, negative removes it. */
  readonly qtyDelta: number;
  readonly reason: StockAdjustmentReason;
  readonly note: string | null;
}

export interface StockAdjustmentPosting {
  readonly direction: 'IN' | 'OUT';
  /** Always positive — the direction carries the sign, as `stock_movements` does. */
  readonly qty: number;
  readonly valueMinor: number;
  readonly journal: JournalEntryDraft;
}

/**
 * Checks what a caller supplied, before any cost has been resolved.
 *
 * Split from `stockAdjustmentPosting` because these are the refusals a user can
 * fix by retyping, and they should be reported before the service loads lots
 * and works out what the stock is worth.
 */
export function rejectStockAdjustment(draft: StockAdjustmentDraft): StockAdjustmentRejection | null {
  if (!Number.isSafeInteger(draft.qtyDelta)) return 'QUANTITY_NOT_INTEGER_MINOR';

  // Zero is refused rather than ignored. It would post a document and a journal
  // entry that moved nothing, and once saved it is indistinguishable from a
  // real correction worth nothing — the same reason a zero journal line is
  // refused in `rejectEntry`.
  if (draft.qtyDelta === 0) return 'QUANTITY_IS_ZERO';

  if (!(STOCK_ADJUSTMENT_REASONS as readonly string[]).includes(draft.reason)) {
    return 'UNKNOWN_REASON';
  }

  // `OTHER` with no note explains nothing, which defeats the point of asking
  // for a reason at all. Every other reason is self-describing.
  if (draft.reason === 'OTHER' && (draft.note === null || draft.note.trim() === '')) {
    return 'NOTE_REQUIRED_FOR_OTHER';
  }

  return null;
}

/**
 * The one physical and financial meaning of a stock correction.
 *
 * `valueMinor` is resolved by the caller because the two directions learn it
 * differently: an increase is valued at the product's current cost basis, a
 * decrease at the actual cost of the lots consumed (`costIssue`). Both arrive
 * here as a settled, positive number of poisha.
 */
export function stockAdjustmentPosting(
  qtyDelta: number,
  valueMinor: number,
  /*
   * What `INVENTORY` is balanced against (Phase 8, §5.19).
   *
   * Damage, recount and theft land in `STOCK_ADJUSTMENT`, which is why that is
   * the default and why every existing caller is unchanged. A unit handed to a
   * customer under warranty is not an adjustment at all — it is a cost the shop
   * chose to carry — so it balances against `WARRANTY_EXPENSE` instead. The
   * account is a parameter rather than a second copy of this function because
   * the costing, the lot consumption and the movement are identical; only where
   * the value lands differs.
   */
  counterAccount: AccountCode = fixedAccount('STOCK_ADJUSTMENT'),
): StockAdjustmentPosting {
  const checked = Qty(qtyDelta);
  if (checked.raw === 0) throw new RangeError('Stock adjustment quantity cannot be zero');
  if (!Number.isSafeInteger(valueMinor) || valueMinor < 0) {
    throw new RangeError('Stock adjustment value must be a non-negative integer number of poisha');
  }

  // A zero-value adjustment would need a journal entry with nothing in it,
  // which `rejectEntry` refuses and INV-09 ("every posted document has at least
  // one journal entry") would then fail. `openingStockPosting` refuses the same
  // case for the same reason; a zero-cost product cannot be adjusted until it
  // has a cost. Recorded as a known limitation rather than solved by posting an
  // empty entry.
  if (valueMinor === 0) throw new RangeError('Stock adjustment value must be at least one poisha');

  const increase = checked.raw > 0;
  const inventoryAmount = increase ? valueMinor : -valueMinor;

  const journal: JournalEntryDraft = {
    lines: [
      { account: fixedAccount('INVENTORY'), amountMinor: inventoryAmount, partyId: null },
      { account: counterAccount, amountMinor: -inventoryAmount, partyId: null },
    ],
  };
  if (rejectEntry(journal) !== null) throw new Error('Stock adjustment journal is not balanced');

  return {
    direction: increase ? 'IN' : 'OUT',
    qty: Math.abs(checked.raw),
    valueMinor,
    journal,
  };
}
