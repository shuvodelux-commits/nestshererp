import { Qty } from '@sher/shared-utils';

import { fixedAccount, type AccountCode } from '../accounting/account';
import { rejectEntry } from '../accounting/journal-entry';
import type { JournalEntryDraft } from '../accounting/journal-entry';

/**
 * Goods coming back over the counter (§5.11, owner decisions 2026-08-26).
 *
 * Pure, and **called from the browser as well as the server** for the same
 * reason `saleTotals` is: the return modal shows the refund value moving as the
 * shopkeeper types each quantity, and a second implementation of the rounding
 * would be a second answer.
 *
 * **A return is always against one invoice.** There is no free-standing return:
 * the quantity is capped at what that invoice sold minus what has already come
 * back, the value per unit is what the customer actually paid for it — the
 * line's net amount after both discounts — and the cost is the cost that left,
 * read from the lots the sale consumed rather than recomputed at today's
 * average. A return re-costed at today's average would leave `COGS` and
 * `INVENTORY` holding a difference nobody created.
 */

/** What the invoice sold on one line, and what has already been returned. */
export interface ReturnableLine {
  readonly saleLineId: string;
  readonly productId: string;
  /** Scale 3, as sold. */
  readonly qtySold: number;
  /** Scale 3, the total already returned across earlier returns. */
  readonly qtyReturned: number;
  /** What the customer paid for the whole line, after line and bill discount. */
  readonly netAmountMinor: number;
  /** What the whole line cost the shop when it left. */
  readonly costMinor: number;
}

/** One line of the return being typed: how much of that sale line is coming back. */
export interface SalesReturnLineDraft {
  readonly saleLineId: string;
  /** Scale 3. Zero means this line is not part of the return. */
  readonly qty: number;
}

export interface SalesReturnDraft {
  readonly lines: readonly SalesReturnLineDraft[];
  /** What the shopkeeper is handing back in cash or bank, in poisha. */
  readonly refundMinor: number;
}

export type SalesReturnRejection =
  | 'RETURN_HAS_NO_LINES'
  | 'AMOUNT_NOT_INTEGER_MINOR'
  | 'RETURN_QUANTITY_NOT_POSITIVE'
  | 'RETURN_LINE_NOT_ON_INVOICE'
  | 'RETURN_EXCEEDS_SOLD'
  | 'REFUND_NEGATIVE'
  | 'REFUND_EXCEEDS_RETURN'
  | 'RETURN_HAS_NO_VALUE';

export interface SalesReturnLineTotals {
  readonly saleLineId: string;
  readonly productId: string;
  readonly qty: number;
  /**
   * The refundable value of this line — the sold line's net amount in
   * proportion to the quantity coming back, so a half-return of a discounted
   * line refunds half of what was actually paid, not half of the list price.
   */
  readonly valueMinor: number;
  /** What that quantity cost the shop, in the same proportion. */
  readonly costMinor: number;
}

export interface SalesReturnTotals {
  readonly lines: readonly SalesReturnLineTotals[];
  /** What the goods coming back are worth to the customer. */
  readonly returnValueMinor: number;
  /** What they cost the shop — goes back into INVENTORY, out of COGS. */
  readonly returnCostMinor: number;
  readonly refundMinor: number;
  /** Return value not handed back in cash: it settles dues, then sits as credit. */
  readonly creditMinor: number;
}

export function rejectSalesReturn(
  draft: SalesReturnDraft,
  sold: readonly ReturnableLine[],
): SalesReturnRejection | null {
  const taken = draft.lines.filter((line) => line.qty !== 0);
  if (taken.length === 0) return 'RETURN_HAS_NO_LINES';
  if (!Number.isSafeInteger(draft.refundMinor)) return 'AMOUNT_NOT_INTEGER_MINOR';
  if (draft.refundMinor < 0) return 'REFUND_NEGATIVE';

  const byId = new Map(sold.map((line) => [line.saleLineId, line]));
  for (const line of taken) {
    if (!Number.isSafeInteger(line.qty)) return 'AMOUNT_NOT_INTEGER_MINOR';
    if (line.qty < 0) return 'RETURN_QUANTITY_NOT_POSITIVE';
    const original = byId.get(line.saleLineId);
    if (original === undefined) return 'RETURN_LINE_NOT_ON_INVOICE';
    if (line.qty > returnableQty(original)) return 'RETURN_EXCEEDS_SOLD';
  }

  const value = salesReturnTotalsUnchecked(draft, byId).returnValueMinor;
  // Nothing to post: the journal would be empty and the document would say a
  // return happened that moved nothing.
  if (value <= 0) return 'RETURN_HAS_NO_VALUE';
  if (draft.refundMinor > value) return 'REFUND_EXCEEDS_RETURN';

  return null;
}

/** What is still returnable on a sold line: sold minus already returned. */
export function returnableQty(line: ReturnableLine): number {
  return Qty(line.qtySold).subtract(Qty(line.qtyReturned)).raw;
}

/**
 * The return, totalled. Safe on every keystroke.
 *
 * Value and cost are apportioned **by quantity** against the sold line, and the
 * last returnable unit carries the remainder: returning 1 of 3 at ৳100.00 twice
 * refunds 33.33 and 33.33, and the final unit takes 33.34, so a fully returned
 * line always gives back exactly what was paid for it. Splitting any other way
 * leaves a poisha stranded on the invoice for ever.
 */
export function salesReturnTotals(
  draft: SalesReturnDraft,
  sold: readonly ReturnableLine[],
): SalesReturnTotals {
  const rejection = rejectSalesReturn(draft, sold);
  if (rejection !== null) throw new RangeError(`Return refused: ${rejection}`);
  return salesReturnTotalsUnchecked(draft, new Map(sold.map((line) => [line.saleLineId, line])));
}

function salesReturnTotalsUnchecked(
  draft: SalesReturnDraft,
  sold: ReadonlyMap<string, ReturnableLine>,
): SalesReturnTotals {
  const lines = draft.lines
    .filter((line) => line.qty > 0)
    .flatMap((line) => {
      const original = sold.get(line.saleLineId);
      if (original === undefined) return [];
      return [
        {
          saleLineId: line.saleLineId,
          productId: original.productId,
          qty: Qty(line.qty).raw,
          valueMinor: shareOf(original.netAmountMinor, line.qty, original),
          costMinor: shareOf(original.costMinor, line.qty, original),
        },
      ];
    });

  const returnValueMinor = lines.reduce((sum, line) => sum + line.valueMinor, 0);
  const returnCostMinor = lines.reduce((sum, line) => sum + line.costMinor, 0);
  const refundMinor = Math.min(Math.max(draft.refundMinor, 0), Math.max(returnValueMinor, 0));

  return {
    lines,
    returnValueMinor,
    returnCostMinor,
    refundMinor,
    creditMinor: returnValueMinor - refundMinor,
  };
}

/**
 * One line's share of a sold amount, by quantity — with the **last** unit
 * carrying the rounding remainder.
 *
 * Whatever is left unreturned keeps the difference until the line is fully back,
 * at which point the shop has given back exactly the sold amount.
 */
function shareOf(amountMinor: number, qty: number, line: ReturnableLine): number {
  const remaining = returnableQty(line);
  if (remaining <= 0) return 0;

  if (Qty(qty).raw >= remaining) {
    // The rest of the line: everything not already given back.
    return amountMinor - proportion(amountMinor, line.qtyReturned, line.qtySold);
  }
  return proportion(amountMinor, qty, line.qtySold);
}

/** `amountMinor × qty ÷ qtySold`, rounded half-up once, in poisha. */
function proportion(amountMinor: number, qty: number, qtySold: number): number {
  if (qtySold <= 0 || qty <= 0) return 0;
  const scaled = (BigInt(amountMinor) * BigInt(Qty(qty).raw) * 2n) / BigInt(Qty(qtySold).raw);
  return Number((scaled + 1n) / 2n);
}

export interface SalesReturnPostingSides {
  readonly partyId: string;
  /** Where a cash refund is paid from. Null when nothing is handed back. */
  readonly refundAccount: AccountCode | null;
  /**
   * How much of the credit clears what this customer owes. The rest becomes an
   * advance they spend on the next sale — never a negative receivable.
   */
  readonly settledMinor: number;
  /** Mixed-source return: only owned/negative goods re-enter owned inventory. */
  readonly ownedReturnCostMinor?: number;
  /** Vendor goods restore the payable to that exact vendor instead. */
  readonly vendorReturns?: readonly {
    readonly vendorPartyId: string;
    readonly costMinor: number;
  }[];
}

/**
 * The one journal entry a sales return posts — the sale's own entry, undone for
 * the goods that came back.
 *
 * `DR SALES` — the shop keeps less revenue than it recorded;
 * `CR CASH:{id}`/`BANK:{id}` — money handed back over the counter;
 * `CR AR:{party}` — credit clearing what the customer still owes;
 * `CR CUSTOMER_ADVANCE:{party}` — credit beyond their dues, for next time;
 * `DR INVENTORY` / `CR COGS` — the goods back on the shelf at the cost that
 * left, which is what keeps INV-05 true.
 *
 * There is no returns account and no discount account: §2.4's list is closed,
 * and a return is a sale that partly did not happen.
 */
export function salesReturnPosting(
  totals: SalesReturnTotals,
  sides: SalesReturnPostingSides,
): JournalEntryDraft {
  if (totals.returnValueMinor <= 0) throw new RangeError('A return must be worth something');
  if (totals.returnCostMinor < 0) throw new RangeError('Goods cannot cost less than nothing');
  if (totals.refundMinor > 0 && sides.refundAccount === null) {
    throw new RangeError('A refund needs an account to come out of');
  }
  if (sides.settledMinor < 0 || sides.settledMinor > totals.creditMinor) {
    throw new RangeError('A return cannot settle more than the credit it creates');
  }
  const advanceMinor = totals.creditMinor - sides.settledMinor;
  const vendorReturns = sides.vendorReturns ?? [];
  const vendorCostMinor = vendorReturns.reduce((sum, row) => sum + row.costMinor, 0);
  const ownedCostMinor = sides.ownedReturnCostMinor ?? totals.returnCostMinor;
  if (ownedCostMinor < 0 || vendorCostMinor < 0 || ownedCostMinor + vendorCostMinor !== totals.returnCostMinor) {
    throw new RangeError('Return source costs must equal the returned cost');
  }

  const lines = [
    { account: fixedAccount('SALES'), amountMinor: totals.returnValueMinor, partyId: null },
    ...(totals.refundMinor === 0 || sides.refundAccount === null
      ? []
      : [{ account: sides.refundAccount, amountMinor: -totals.refundMinor, partyId: null }]),
    ...(sides.settledMinor === 0
      ? []
      : [{ account: fixedAccount('AR'), amountMinor: -sides.settledMinor, partyId: sides.partyId }]),
    ...(advanceMinor === 0
      ? []
      : [
          {
            account: fixedAccount('CUSTOMER_ADVANCE'),
            amountMinor: -advanceMinor,
            partyId: sides.partyId,
          },
        ]),
    ...(ownedCostMinor === 0
      ? []
      : [{ account: fixedAccount('INVENTORY'), amountMinor: ownedCostMinor, partyId: null }]),
    ...vendorReturns
      .filter((row) => row.costMinor > 0)
      .map((row) => ({
        account: fixedAccount('VENDOR_PAYABLE'),
        amountMinor: row.costMinor,
        partyId: row.vendorPartyId,
      })),
    ...(totals.returnCostMinor === 0
      ? []
      : [{ account: fixedAccount('COGS'), amountMinor: -totals.returnCostMinor, partyId: null }]),
  ];

  const journal: JournalEntryDraft = { lines };
  if (rejectEntry(journal) !== null) throw new Error('Sales return journal is not balanced');
  return journal;
}

/**
 * Putting the goods back **into the lots they came out of**.
 *
 * The sale recorded which lots each line consumed and at what cost; a return
 * refills those same lots, newest consumption first, so the quantity and the
 * value land where they were taken from. Refilling in any other order — or into
 * a fresh lot — would leave FIFO handing out goods at a cost the shop never
 * paid for them, and INV-05 comparing an INVENTORY account against a valuation
 * built from different numbers.
 */
export interface LotConsumed {
  readonly lotId: string;
  readonly qty: number;
  readonly unitCostUsed: number;
}

export interface LotRefill {
  readonly lotId: string;
  readonly qty: number;
  readonly unitCostUsed: number;
}

export function refillLots(
  qtyReturning: number,
  consumed: readonly LotConsumed[],
  alreadyRefilled: readonly LotRefill[],
): readonly LotRefill[] {
  const refilledByLot = new Map<string, number>();
  for (const refill of alreadyRefilled) {
    refilledByLot.set(refill.lotId, Qty(refilledByLot.get(refill.lotId) ?? 0).add(Qty(refill.qty)).raw);
  }

  const refills: LotRefill[] = [];
  let left = Qty(qtyReturning).raw;

  // Newest consumption first: the goods most recently taken are the ones a
  // customer is handing back, and it keeps the oldest lot open longest.
  for (const consumption of [...consumed].reverse()) {
    if (left <= 0) break;
    const spent = refilledByLot.get(consumption.lotId) ?? 0;
    const room = Qty(consumption.qty).subtract(Qty(spent)).raw;
    if (room <= 0) continue;

    const qty = Math.min(room, left);
    refills.push({ lotId: consumption.lotId, qty, unitCostUsed: consumption.unitCostUsed });
    refilledByLot.set(consumption.lotId, Qty(spent).add(Qty(qty)).raw);
    left = Qty(left).subtract(Qty(qty)).raw;
  }

  if (left > 0) throw new RangeError('More is coming back than this invoice took from stock');
  return refills;
}
