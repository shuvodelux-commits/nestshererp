import { Qty } from '@sher/shared-utils';

import { fixedAccount, type AccountCode } from '../accounting/account';
import { rejectEntry } from '../accounting/journal-entry';
import type { JournalEntryDraft } from '../accounting/journal-entry';

/**
 * Goods going back to the supplier (§5.11, owner decisions 2026-08-26).
 *
 * Pure, and called from the browser as well as the server, for the same reason
 * every other totals function is: the modal shows the credit moving as each
 * quantity is typed, and one rounding rule can only live in one place.
 *
 * **The mirror of a sales return, with one asymmetry.** What the supplier
 * credits is what they billed — the line's value after the bill discount. What
 * leaves the shelf is what the lot holds, `actual_unit_cost`, which also carries
 * that line's share of the extra cost the shop paid to bring the goods in. The
 * difference is transport already spent on goods the shop no longer owns: it
 * cannot stay in `INVENTORY`, and the supplier never received it, so it lands in
 * `STOCK_ADJUSTMENT`.
 */

/** One line of the bill, and what is still returnable on it. */
export interface ReturnableBillLine {
  readonly purchaseLineId: string;
  readonly productId: string;
  readonly lotId: string;
  /** Scale 3, as received. */
  readonly qtyReceived: number;
  /** Scale 3, already sent back on earlier returns. */
  readonly qtyReturned: number;
  /**
   * Scale 3, still in the lot. Goods already sold cannot be sent back, and this
   * is the cap that says so.
   */
  readonly qtyRemainingInLot: number;
  /** What the supplier billed for the whole line, after the bill discount. */
  readonly billedNetMinor: number;
  /** Poisha per unit, scale 4 — what the lot values a unit at. */
  readonly actualUnitCost: number;
}

export interface PurchaseReturnLineDraft {
  readonly purchaseLineId: string;
  /** Scale 3. Zero means this line is not part of the return. */
  readonly qty: number;
}

export interface PurchaseReturnDraft {
  readonly lines: readonly PurchaseReturnLineDraft[];
  /** What the supplier is handing back in cash or bank, in poisha. */
  readonly receivedMinor: number;
}

export type PurchaseReturnRejection =
  | 'RETURN_HAS_NO_LINES'
  | 'AMOUNT_NOT_INTEGER_MINOR'
  | 'RETURN_QUANTITY_NOT_POSITIVE'
  | 'RETURN_LINE_NOT_ON_BILL'
  | 'RETURN_EXCEEDS_RECEIVED'
  | 'RETURN_EXCEEDS_STOCK'
  | 'RECEIVED_NEGATIVE'
  | 'RECEIVED_EXCEEDS_RETURN'
  | 'RETURN_HAS_NO_VALUE';

export interface PurchaseReturnLineTotals {
  readonly purchaseLineId: string;
  readonly productId: string;
  readonly lotId: string;
  readonly qty: number;
  /** What the supplier credits for this quantity. */
  readonly valueMinor: number;
  /** What comes out of INVENTORY for it: qty × the lot's own unit cost. */
  readonly costMinor: number;
}

export interface PurchaseReturnTotals {
  readonly lines: readonly PurchaseReturnLineTotals[];
  readonly returnValueMinor: number;
  readonly inventoryMinor: number;
  readonly receivedMinor: number;
  /** Return value not taken as money: it clears bills, then sits as credit. */
  readonly creditMinor: number;
  /** Extra cost the shop paid on goods it no longer owns. */
  readonly adjustmentMinor: number;
}

export function rejectPurchaseReturn(
  draft: PurchaseReturnDraft,
  billed: readonly ReturnableBillLine[],
): PurchaseReturnRejection | null {
  const taken = draft.lines.filter((line) => line.qty !== 0);
  if (taken.length === 0) return 'RETURN_HAS_NO_LINES';
  if (!Number.isSafeInteger(draft.receivedMinor)) return 'AMOUNT_NOT_INTEGER_MINOR';
  if (draft.receivedMinor < 0) return 'RECEIVED_NEGATIVE';

  const byId = new Map(billed.map((line) => [line.purchaseLineId, line]));
  for (const line of taken) {
    if (!Number.isSafeInteger(line.qty)) return 'AMOUNT_NOT_INTEGER_MINOR';
    if (line.qty < 0) return 'RETURN_QUANTITY_NOT_POSITIVE';
    const original = byId.get(line.purchaseLineId);
    if (original === undefined) return 'RETURN_LINE_NOT_ON_BILL';
    if (line.qty > returnableBillQty(original)) return 'RETURN_EXCEEDS_RECEIVED';
    // The goods must still be on the shelf. Anything sold since is somebody
    // else's now, and sending it back would drive the lot negative.
    if (line.qty > original.qtyRemainingInLot) return 'RETURN_EXCEEDS_STOCK';
  }

  const value = purchaseReturnTotalsUnchecked(draft, byId).returnValueMinor;
  if (value <= 0) return 'RETURN_HAS_NO_VALUE';
  if (draft.receivedMinor > value) return 'RECEIVED_EXCEEDS_RETURN';

  return null;
}

/** What may still go back on a bill line: received minus already returned. */
export function returnableBillQty(line: ReturnableBillLine): number {
  return Qty(line.qtyReceived).subtract(Qty(line.qtyReturned)).raw;
}

export function purchaseReturnTotals(
  draft: PurchaseReturnDraft,
  billed: readonly ReturnableBillLine[],
): PurchaseReturnTotals {
  const rejection = rejectPurchaseReturn(draft, billed);
  if (rejection !== null) throw new RangeError(`Purchase return refused: ${rejection}`);
  return purchaseReturnTotalsUnchecked(
    draft,
    new Map(billed.map((line) => [line.purchaseLineId, line])),
  );
}

function purchaseReturnTotalsUnchecked(
  draft: PurchaseReturnDraft,
  billed: ReadonlyMap<string, ReturnableBillLine>,
): PurchaseReturnTotals {
  const lines = draft.lines
    .filter((line) => line.qty > 0)
    .flatMap((line) => {
      const original = billed.get(line.purchaseLineId);
      if (original === undefined) return [];
      return [
        {
          purchaseLineId: line.purchaseLineId,
          productId: original.productId,
          lotId: original.lotId,
          qty: Qty(line.qty).raw,
          valueMinor: billedShare(original, line.qty),
          costMinor: lotCost(original.actualUnitCost, line.qty),
        },
      ];
    });

  const returnValueMinor = lines.reduce((sum, line) => sum + line.valueMinor, 0);
  const inventoryMinor = lines.reduce((sum, line) => sum + line.costMinor, 0);
  const receivedMinor = Math.min(Math.max(draft.receivedMinor, 0), Math.max(returnValueMinor, 0));

  return {
    lines,
    returnValueMinor,
    inventoryMinor,
    receivedMinor,
    creditMinor: returnValueMinor - receivedMinor,
    // Never negative: a lot's cost is the billed value plus its share of the
    // extra cost, so what leaves stock is always at least what is credited.
    adjustmentMinor: Math.max(inventoryMinor - returnValueMinor, 0),
  };
}

/**
 * This quantity's share of what the supplier billed, with the **last**
 * returnable unit carrying the remainder — so a line sent back in full credits
 * exactly what was charged for it.
 */
function billedShare(line: ReturnableBillLine, qty: number): number {
  const remaining = returnableBillQty(line);
  if (remaining <= 0) return 0;
  if (Qty(qty).raw >= remaining) {
    return line.billedNetMinor - proportion(line.billedNetMinor, line.qtyReturned, line.qtyReceived);
  }
  return proportion(line.billedNetMinor, qty, line.qtyReceived);
}

/**
 * Quantity (scale 3) × unit cost (scale 4), to poisha.
 *
 * The same product the costing kernel forms when goods leave on a sale, rounded
 * once — INV-05 compares the `INVENTORY` account against a valuation built from
 * these same rounded lot costs, so a second rounding rule here would show up as
 * a permanent difference nobody could explain.
 */
function lotCost(actualUnitCost: number, qty: number): number {
  const scaled = (BigInt(actualUnitCost) * BigInt(Qty(qty).raw) * 2n) / 100_000n;
  return Number((scaled + 1n) / 2n);
}

/** `amountMinor × qty ÷ qtyTotal`, rounded half-up once, in poisha. */
function proportion(amountMinor: number, qty: number, qtyTotal: number): number {
  if (qtyTotal <= 0 || qty <= 0) return 0;
  const scaled = (BigInt(amountMinor) * BigInt(Qty(qty).raw) * 2n) / BigInt(Qty(qtyTotal).raw);
  return Number((scaled + 1n) / 2n);
}

export interface PurchaseReturnPostingSides {
  readonly supplierPartyId: string;
  /** Where money taken back from the supplier landed. Null when none was. */
  readonly receiptAccount: AccountCode | null;
  /** How much of the credit clears what the shop still owes them. */
  readonly settledMinor: number;
}

/**
 * The one journal entry a purchase return posts.
 *
 * `CR INVENTORY` — the goods leave the shelf at what the lot holds;
 * `DR CASH:{id}`/`BANK:{id}` — money the supplier handed back;
 * `DR AP:{party}` — credit clearing what the shop still owes them;
 * `DR SUPPLIER_ADVANCE:{party}` — credit beyond their bills, for next time;
 * `DR STOCK_ADJUSTMENT` — the extra cost paid on goods that are now gone.
 *
 * There is no purchase-return account: §2.4's list is closed, and a return is a
 * purchase that partly did not happen.
 */
export function purchaseReturnPosting(
  totals: PurchaseReturnTotals,
  sides: PurchaseReturnPostingSides,
): JournalEntryDraft {
  if (totals.returnValueMinor <= 0) throw new RangeError('A return must be worth something');
  if (totals.receivedMinor > 0 && sides.receiptAccount === null) {
    throw new RangeError('Money coming back needs an account to land in');
  }
  if (sides.settledMinor < 0 || sides.settledMinor > totals.creditMinor) {
    throw new RangeError('A return cannot settle more than the credit it creates');
  }
  const advanceMinor = totals.creditMinor - sides.settledMinor;

  const lines = [
    ...(totals.receivedMinor === 0 || sides.receiptAccount === null
      ? []
      : [{ account: sides.receiptAccount, amountMinor: totals.receivedMinor, partyId: null }]),
    ...(sides.settledMinor === 0
      ? []
      : [
          {
            account: fixedAccount('AP'),
            amountMinor: sides.settledMinor,
            partyId: sides.supplierPartyId,
          },
        ]),
    ...(advanceMinor === 0
      ? []
      : [
          {
            account: fixedAccount('SUPPLIER_ADVANCE'),
            amountMinor: advanceMinor,
            partyId: sides.supplierPartyId,
          },
        ]),
    ...(totals.adjustmentMinor === 0
      ? []
      : [
          {
            account: fixedAccount('STOCK_ADJUSTMENT'),
            amountMinor: totals.adjustmentMinor,
            partyId: null,
          },
        ]),
    { account: fixedAccount('INVENTORY'), amountMinor: -totals.inventoryMinor, partyId: null },
  ];

  const journal: JournalEntryDraft = { lines };
  if (rejectEntry(journal) !== null) throw new Error('Purchase return journal is not balanced');
  return journal;
}
