import { allocateLargestRemainder, divideRoundHalfUp, Money, Qty, UnitCost } from '@sher/shared-utils';

import { fixedAccount } from '../accounting/account';
import type { AccountCode } from '../accounting/account';
import { rejectEntry } from '../accounting/journal-entry';
import type { JournalEntryDraft } from '../accounting/journal-entry';
import { stockValueMinor } from '../inventory/costing';

/**
 * One supplier bill: what arrived, what it cost, and what it did to the money
 * (§5.9, §5.11, §2.4).
 *
 * Pure: no clock, no I/O, no floating point. Quantities are scale-3, prices are
 * poisha, and unit costs are the scale-4 `UnitCost` every lot already carries.
 *
 * **The discount and the extra cost are properties of the bill, not of a line.**
 * The owner's decision of 2026-08-24 is that a shopkeeper types one discount and
 * one transport/labour figure at the bottom, the way the supplier writes them.
 * They still have to reach the shelf: a discount lowers what the goods cost and
 * van fare raises it, so both are spread over the lines by value with §3.3's
 * largest-remainder rule and land in each lot's `actual_unit_cost`. Posting the
 * extra cost to an expense account instead would understate the stock on the
 * shelf and overstate this month's costs — the goods have not been sold yet.
 */

export interface PurchaseLineDraft {
  readonly productId: string;
  /** Scale 3, like every other quantity. */
  readonly qty: number;
  /** What the supplier charged per unit, in poisha. */
  readonly unitPriceMinor: number;
}

export interface PurchaseDraft {
  readonly lines: readonly PurchaseLineDraft[];
  readonly discountMinor: number;
  readonly extraCostMinor: number;
  /** Exact aggregate landed-cost share per line; absent for legacy clients. */
  readonly extraCostShares?: readonly number[] | undefined;
  /** The "Paid now" box. Zero is a bill entirely on credit. */
  readonly paidMinor: number;
}

export type PurchaseRejection =
  | 'PURCHASE_HAS_NO_LINES'
  | 'AMOUNT_NOT_INTEGER_MINOR'
  | 'LINE_QUANTITY_NOT_POSITIVE'
  | 'LINE_PRICE_NEGATIVE'
  | 'DISCOUNT_NEGATIVE'
  | 'EXTRA_COST_NEGATIVE'
  | 'PAID_NEGATIVE'
  | 'DISCOUNT_EXCEEDS_ITEMS'
  | 'PAID_EXCEEDS_TOTAL'
  | 'PURCHASE_HAS_NO_VALUE';

/** What one line costs the shop once the bill's own figures are shared out. */
export interface PurchaseLineCost {
  readonly productId: string;
  readonly qty: number;
  readonly unitPriceMinor: number;
  readonly lineTotalMinor: number;
  readonly discountShareMinor: number;
  readonly extraCostShareMinor: number;
  /** Line total − discount share + extra share: what this stock really cost. */
  readonly netCostMinor: number;
  /** Scale 4, the cost the lot carries and a later sale is charged at. */
  readonly actualUnitCost: number;
  /** What the lot is worth in the valuation — `qty × actualUnitCost`. */
  readonly lotValueMinor: number;
}

export interface PurchaseCosts {
  readonly itemsTotalMinor: number;
  readonly discountMinor: number;
  readonly extraCostMinor: number;
  readonly grandTotalMinor: number;
  readonly lines: readonly PurchaseLineCost[];
  /** Σ of the lots — what `INVENTORY` is debited by. */
  readonly inventoryValueMinor: number;
  /**
   * Grand total − inventory value, which is at most a poisha or two.
   *
   * A unit cost is rounded once to scale 4, so `qty × cost` need not come back
   * to the exact taka on the bill. The difference is posted to `ROUNDING`
   * (§2.4) rather than folded into `INVENTORY`, because INV-05 requires the
   * `INVENTORY` account to equal the valuation **exactly** — and the valuation
   * is computed from those same rounded lot costs. Hiding the remainder in
   * inventory would break the one invariant that catches real costing bugs.
   */
  readonly roundingMinor: number;
}

export function rejectPurchase(draft: PurchaseDraft): PurchaseRejection | null {
  if (draft.lines.length === 0) return 'PURCHASE_HAS_NO_LINES';

  for (const line of draft.lines) {
    if (!Number.isSafeInteger(line.qty) || !Number.isSafeInteger(line.unitPriceMinor)) {
      return 'AMOUNT_NOT_INTEGER_MINOR';
    }
    if (line.qty <= 0) return 'LINE_QUANTITY_NOT_POSITIVE';
    if (line.unitPriceMinor < 0) return 'LINE_PRICE_NEGATIVE';
  }

  if (
    !Number.isSafeInteger(draft.discountMinor) ||
    !Number.isSafeInteger(draft.extraCostMinor) ||
    !Number.isSafeInteger(draft.paidMinor)
  ) {
    return 'AMOUNT_NOT_INTEGER_MINOR';
  }
  if (draft.discountMinor < 0) return 'DISCOUNT_NEGATIVE';
  if (draft.extraCostMinor < 0) return 'EXTRA_COST_NEGATIVE';
  if (draft.paidMinor < 0) return 'PAID_NEGATIVE';

  const itemsTotal = draft.lines.reduce(
    (sum, line) => sum + lineTotalOf(line.qty, line.unitPriceMinor),
    0,
  );
  if (draft.discountMinor > itemsTotal) return 'DISCOUNT_EXCEEDS_ITEMS';

  const grandTotal = itemsTotal - draft.discountMinor + draft.extraCostMinor;
  if (draft.extraCostShares !== undefined) {
    if (
      draft.extraCostShares.length !== draft.lines.length ||
      draft.extraCostShares.some((share) => !Number.isSafeInteger(share) || share < 0) ||
      draft.extraCostShares.reduce((sum, share) => sum + share, 0) !== draft.extraCostMinor
    ) {
      return 'AMOUNT_NOT_INTEGER_MINOR';
    }
  }
  // A bill worth nothing has nothing to post: `rejectEntry` would refuse the
  // zero lines it produces, and a lot with no value cannot be sold from.
  if (grandTotal <= 0) return 'PURCHASE_HAS_NO_VALUE';
  if (draft.paidMinor > grandTotal) return 'PAID_EXCEEDS_TOTAL';

  return null;
}

/** Turns the bill a shopkeeper typed into the cost of every lot it creates. */
export function purchaseCosts(draft: PurchaseDraft): PurchaseCosts {
  const rejection = rejectPurchase(draft);
  if (rejection !== null) throw new RangeError(`Purchase refused: ${rejection}`);

  const lineTotals = draft.lines.map((line) => lineTotalOf(line.qty, line.unitPriceMinor));
  const itemsTotalMinor = lineTotals.reduce((sum, total) => sum + total, 0);

  /*
   * Value is the fair weight: a discount belongs mostly to the expensive line.
   * A bill whose lines are all free (a supplier's sample delivery carrying only
   * transport) has no value to weigh with, so quantity stands in — otherwise
   * the allocator has nothing to divide by and the whole bill is refused over
   * an arithmetic detail.
   */
  const weights = itemsTotalMinor > 0 ? lineTotals : draft.lines.map((line) => line.qty);
  const discountShares = shareOut(draft.discountMinor, weights, 'Purchase discount');
  const extraShares =
    draft.extraCostShares === undefined
      ? shareOut(draft.extraCostMinor, weights, 'Purchase extra cost')
      : draft.extraCostShares;

  const lines = draft.lines.map((line, index) => {
    const lineTotalMinor = lineTotals[index] ?? 0;
    const discountShareMinor = discountShares[index] ?? 0;
    const extraCostShareMinor = extraShares[index] ?? 0;
    const netCostMinor = lineTotalMinor - discountShareMinor + extraCostShareMinor;
    if (netCostMinor < 0) throw new RangeError('A purchase line cannot cost less than nothing');

    const actualUnitCost = unitCostOf(netCostMinor, line.qty);
    return {
      productId: line.productId,
      qty: Qty(line.qty).raw,
      unitPriceMinor: line.unitPriceMinor,
      lineTotalMinor,
      discountShareMinor,
      extraCostShareMinor,
      netCostMinor,
      actualUnitCost,
      lotValueMinor: stockValueMinor(line.qty, actualUnitCost),
    };
  });

  const grandTotalMinor = itemsTotalMinor - draft.discountMinor + draft.extraCostMinor;
  const inventoryValueMinor = lines.reduce((sum, line) => sum + line.lotValueMinor, 0);

  return {
    itemsTotalMinor,
    discountMinor: draft.discountMinor,
    extraCostMinor: draft.extraCostMinor,
    grandTotalMinor,
    lines,
    inventoryValueMinor,
    roundingMinor: grandTotalMinor - inventoryValueMinor,
  };
}

export interface PurchasePostingSides {
  readonly supplierPartyId: string;
  /** Where the "Paid now" money came from, or `null` when nothing was paid. */
  readonly paidAccount: AccountCode | null;
  readonly paidMinor: number;
}

/**
 * The one journal entry a purchase posts.
 *
 * `DR INVENTORY` — the goods are on the shelf, valued at what they cost;
 * `CR CASH:{id}`/`BANK:{id}` — what was handed over at the door;
 * `CR AP` — what the supplier is still owed, carrying their `party_id` so INV-06
 * makes their balance and their statement the same number as this line.
 *
 * There is no purchase-discount account and no transport expense: both are
 * already inside the inventory figure, which is the whole point of spreading
 * them over the lines (see `purchaseCosts`).
 */
export function purchasePosting(costs: PurchaseCosts, sides: PurchasePostingSides): JournalEntryDraft {
  const dueMinor = costs.grandTotalMinor - sides.paidMinor;
  if (dueMinor < 0) throw new RangeError('A purchase cannot be paid more than it is worth');
  if (sides.paidMinor > 0 && sides.paidAccount === null) {
    throw new RangeError('Money paid on a purchase must name the account it left');
  }

  const journal: JournalEntryDraft = {
    lines: [
      { account: fixedAccount('INVENTORY'), amountMinor: costs.inventoryValueMinor, partyId: null },
      ...(costs.roundingMinor === 0
        ? []
        : [{ account: fixedAccount('ROUNDING'), amountMinor: costs.roundingMinor, partyId: null }]),
      ...(sides.paidMinor === 0 || sides.paidAccount === null
        ? []
        : [{ account: sides.paidAccount, amountMinor: -sides.paidMinor, partyId: null }]),
      ...(dueMinor === 0
        ? []
        : [{ account: fixedAccount('AP'), amountMinor: -dueMinor, partyId: sides.supplierPartyId }]),
    ],
  };

  if (rejectEntry(journal) !== null) throw new Error('Purchase journal is not balanced');
  return journal;
}

/** Quantity (scale 3) × price (poisha), rounded once — the same rule as `Money`. */
function lineTotalOf(qty: number, unitPriceMinor: number): number {
  return Money(unitPriceMinor).multiply(Qty(qty)).minor;
}

function shareOut(total: number, weights: readonly number[], label: string): readonly number[] {
  if (total === 0) return weights.map(() => 0);
  return allocateLargestRemainder(total, weights, label);
}

/** Money (scale 2) spread over a quantity (scale 3) as a unit cost (scale 4). */
function unitCostOf(netCostMinor: number, qty: number): number {
  const raw = divideRoundHalfUp(BigInt(netCostMinor) * 100000n, BigInt(Qty(qty).raw));
  return UnitCost(Number(raw)).raw;
}
