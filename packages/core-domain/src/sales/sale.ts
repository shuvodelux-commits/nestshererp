import { allocateLargestRemainder, Money, Qty } from '@sher/shared-utils';

import { fixedAccount, type AccountCode } from '../accounting/account';
import { rejectEntry } from '../accounting/journal-entry';
import type { JournalEntryDraft } from '../accounting/journal-entry';
import { allocateOldestFirst } from '../purchasing/supplier-payment';

/**
 * One counter sale: what left the shelf, what it was sold for, and what the
 * money did (§5.7, §5.8, §2.4).
 *
 * Pure: no clock, no I/O, no floating point. Quantities are scale-3 and prices
 * are poisha, exactly as a purchase carries them.
 *
 * **This file is called from the browser as well as the server**, which is the
 * whole point of it. The owner's binding rule is that every figure on the POS —
 * line total, discount, grand total, paid, due, change — moves the instant
 * anything is typed, and the only honest way to do that without a round trip is
 * for the screen to run the *same* arithmetic the posting service runs. A
 * second implementation in a Vue component would be a second rounding rule, and
 * the first bill whose poisha disagreed would be unexplainable.
 *
 * **Discount exists at two levels** (owner decision 2026-08-25). A line
 * discount is what the shopkeeper knocked off that item and is already inside
 * the line total. The bill discount is typed once at the bottom and is spread
 * over the lines by value with §3.3's largest-remainder rule, so each product's
 * real margin stays correct — a bill discount left unspread would make every
 * line's profit a lie while the invoice total stayed right.
 */

export interface SaleLineDraft {
  readonly productId: string;
  /** Scale 3, like every other quantity. */
  readonly qty: number;
  /** What the customer is charged per unit, in poisha. */
  readonly unitPriceMinor: number;
  /** Knocked off this line only, in poisha. Zero for almost every line. */
  readonly lineDiscountMinor: number;
}

export interface SaleDraft {
  readonly lines: readonly SaleLineDraft[];
  /** The one Discount box above Grand Total. */
  readonly discountMinor: number;
  /** Σ of the payment rows. Zero is a sale entirely on credit. */
  readonly paidMinor: number;
}

export type SaleRejection =
  | 'SALE_HAS_NO_LINES'
  | 'AMOUNT_NOT_INTEGER_MINOR'
  | 'LINE_QUANTITY_NOT_POSITIVE'
  | 'LINE_PRICE_NEGATIVE'
  | 'LINE_DISCOUNT_NEGATIVE'
  | 'LINE_DISCOUNT_EXCEEDS_LINE'
  | 'DISCOUNT_NEGATIVE'
  | 'PAID_NEGATIVE'
  | 'DISCOUNT_EXCEEDS_ITEMS'
  | 'SALE_HAS_NO_VALUE';

export interface SaleLineTotals {
  readonly productId: string;
  readonly qty: number;
  readonly unitPriceMinor: number;
  /** Quantity × price, before any discount. */
  readonly grossMinor: number;
  readonly lineDiscountMinor: number;
  /** Gross − line discount: what this line adds to the items total. */
  readonly lineTotalMinor: number;
  /** This line's share of the bill discount (§3.3 largest remainder). */
  readonly discountShareMinor: number;
  /** Line total − bill-discount share: what the customer really paid for it. */
  readonly netAmountMinor: number;
}

export interface SaleTotals {
  readonly itemsTotalMinor: number;
  readonly discountMinor: number;
  readonly grandTotalMinor: number;
  readonly lines: readonly SaleLineTotals[];
  readonly paidMinor: number;
  /**
   * What the customer still owes. Never negative: money handed over beyond the
   * bill is `changeMinor` or an advance, not a negative due.
   */
  readonly dueMinor: number;
  /**
   * What is handed back across the counter — or held as an advance when the
   * shopkeeper chooses to keep it. Which of the two it is belongs to the
   * posting service; the arithmetic is the same subtraction either way.
   */
  readonly changeMinor: number;
}

export function rejectSale(draft: SaleDraft): SaleRejection | null {
  if (draft.lines.length === 0) return 'SALE_HAS_NO_LINES';

  for (const line of draft.lines) {
    if (
      !Number.isSafeInteger(line.qty) ||
      !Number.isSafeInteger(line.unitPriceMinor) ||
      !Number.isSafeInteger(line.lineDiscountMinor)
    ) {
      return 'AMOUNT_NOT_INTEGER_MINOR';
    }
    if (line.qty <= 0) return 'LINE_QUANTITY_NOT_POSITIVE';
    if (line.unitPriceMinor < 0) return 'LINE_PRICE_NEGATIVE';
    if (line.lineDiscountMinor < 0) return 'LINE_DISCOUNT_NEGATIVE';
    if (line.lineDiscountMinor > grossOf(line.qty, line.unitPriceMinor)) {
      return 'LINE_DISCOUNT_EXCEEDS_LINE';
    }
  }

  if (!Number.isSafeInteger(draft.discountMinor) || !Number.isSafeInteger(draft.paidMinor)) {
    return 'AMOUNT_NOT_INTEGER_MINOR';
  }
  if (draft.discountMinor < 0) return 'DISCOUNT_NEGATIVE';
  if (draft.paidMinor < 0) return 'PAID_NEGATIVE';

  const itemsTotal = draft.lines.reduce(
    (sum, line) => sum + grossOf(line.qty, line.unitPriceMinor) - line.lineDiscountMinor,
    0,
  );
  if (draft.discountMinor > itemsTotal) return 'DISCOUNT_EXCEEDS_ITEMS';
  // A sale worth nothing has nothing to post: `rejectEntry` would refuse the
  // zero lines it produces, and a free handout is a stock adjustment, not a
  // sale with a customer and an invoice number.
  if (itemsTotal - draft.discountMinor <= 0) return 'SALE_HAS_NO_VALUE';

  return null;
}

/**
 * The cart, totalled. Safe to call on every keystroke — it allocates nothing
 * but two arrays and never touches a clock or a network.
 */
export function saleTotals(draft: SaleDraft): SaleTotals {
  const rejection = rejectSale(draft);
  if (rejection !== null) throw new RangeError(`Sale refused: ${rejection}`);

  const lineTotals = draft.lines.map(
    (line) => grossOf(line.qty, line.unitPriceMinor) - line.lineDiscountMinor,
  );
  const itemsTotalMinor = lineTotals.reduce((sum, total) => sum + total, 0);

  /*
   * Value is the fair weight: a bill discount belongs mostly to the expensive
   * line. A cart whose lines are all free has no value to weigh with, so
   * quantity stands in — the same fallback a purchase makes, for the same
   * reason (the allocator has nothing to divide by).
   */
  const weights = itemsTotalMinor > 0 ? lineTotals : draft.lines.map((line) => line.qty);
  const shares =
    draft.discountMinor === 0
      ? weights.map(() => 0)
      : allocateLargestRemainder(draft.discountMinor, weights, 'Sale discount');

  const lines = draft.lines.map((line, index) => {
    const grossMinor = grossOf(line.qty, line.unitPriceMinor);
    const lineTotalMinor = lineTotals[index] ?? 0;
    const discountShareMinor = shares[index] ?? 0;
    return {
      productId: line.productId,
      qty: Qty(line.qty).raw,
      unitPriceMinor: line.unitPriceMinor,
      grossMinor,
      lineDiscountMinor: line.lineDiscountMinor,
      lineTotalMinor,
      discountShareMinor,
      netAmountMinor: lineTotalMinor - discountShareMinor,
    };
  });

  const grandTotalMinor = itemsTotalMinor - draft.discountMinor;
  const overpaid = Math.max(draft.paidMinor - grandTotalMinor, 0);

  return {
    itemsTotalMinor,
    discountMinor: draft.discountMinor,
    grandTotalMinor,
    lines,
    paidMinor: draft.paidMinor,
    dueMinor: Math.max(grandTotalMinor - draft.paidMinor, 0),
    changeMinor: overpaid,
  };
}

/** One payment row: an amount and the account it actually landed in. */
export interface SalePaymentSide {
  readonly account: AccountCode;
  readonly amountMinor: number;
}

export interface SalePostingSides {
  /** The registered customer, or the system walk-in party (§5.8). */
  readonly partyId: string;
  readonly payments: readonly SalePaymentSide[];
  /** What the goods cost the shop, from the costing service (DR13.2). */
  readonly cogsMinor: number;
  /** Money kept beyond the bill, held as this customer's advance. */
  readonly advanceMinor: number;
  /** Consignment goods deemed bought from their vendor at the moment of sale. */
  readonly vendorPayables: readonly { readonly vendorPartyId: string; readonly amountMinor: number }[];
}

/**
 * The one journal entry a sale posts.
 *
 * `DR CASH:{id}`/`BANK:{id}` — what was taken, per account, so the drawer and
 * each bank balance move by exactly what their own payment row says;
 * `DR AR:{party}` — what the customer still owes, carrying their `party_id` so
 * INV-06 makes their balance and their statement the same number;
 * `CR SALES` — the goods at what they were sold for, after all discount;
 * `DR COGS` / `CR INVENTORY` — what those goods cost, which is what turns a
 * sale into a profit figure rather than a cash receipt;
 * `CR CUSTOMER_ADVANCE:{party}` — money kept beyond the bill;
 * `CR VENDOR_PAYABLE:{vendor}` — DR13.10's deemed purchase on a consignment
 * line, because the vendor is owed the moment their goods are sold.
 *
 * There is no discount account: a discount is simply a lower selling price, and
 * §2.4's closed list has nowhere for one — the same argument that keeps a
 * purchase discount out of the books.
 */
export function salePosting(totals: SaleTotals, sides: SalePostingSides): JournalEntryDraft {
  const paid = sides.payments.reduce((sum, payment) => sum + payment.amountMinor, 0);
  const settledMinor = paid - sides.advanceMinor;
  const dueMinor = totals.grandTotalMinor - settledMinor;
  if (dueMinor < 0) {
    throw new RangeError('Money taken beyond the bill must be held as an advance');
  }
  if (sides.cogsMinor < 0) throw new RangeError('Goods cannot cost less than nothing');

  const vendorTotal = sides.vendorPayables.reduce((sum, side) => sum + side.amountMinor, 0);
  if (vendorTotal > sides.cogsMinor) {
    throw new RangeError('Vendor payable cannot exceed the cost of the goods sold');
  }

  const lines = [
    ...sides.payments
      .filter((payment) => payment.amountMinor !== 0)
      .map((payment) => ({
        account: payment.account,
        amountMinor: payment.amountMinor,
        partyId: null,
      })),
    ...(dueMinor === 0
      ? []
      : [{ account: fixedAccount('AR'), amountMinor: dueMinor, partyId: sides.partyId }]),
    { account: fixedAccount('SALES'), amountMinor: -totals.grandTotalMinor, partyId: null },
    ...(sides.advanceMinor === 0
      ? []
      : [
          {
            account: fixedAccount('CUSTOMER_ADVANCE'),
            amountMinor: -sides.advanceMinor,
            partyId: sides.partyId,
          },
        ]),
    ...(sides.cogsMinor === 0
      ? []
      : [
          { account: fixedAccount('COGS'), amountMinor: sides.cogsMinor, partyId: null },
          /*
           * Own stock leaves INVENTORY; consignment goods were never in it
           * (INV-04), so their cost becomes a payable to the vendor instead.
           * Splitting the credit here is what keeps owned valuation equal to
           * the INVENTORY account when a bill mixes both.
           */
          ...(sides.cogsMinor - vendorTotal === 0
            ? []
            : [
                {
                  account: fixedAccount('INVENTORY'),
                  amountMinor: -(sides.cogsMinor - vendorTotal),
                  partyId: null,
                },
              ]),
          ...sides.vendorPayables
            .filter((side) => side.amountMinor !== 0)
            .map((side) => ({
              account: fixedAccount('VENDOR_PAYABLE'),
              amountMinor: -side.amountMinor,
              partyId: side.vendorPartyId,
            })),
        ]),
  ];

  const journal: JournalEntryDraft = { lines };
  if (rejectEntry(journal) !== null) throw new Error('Sale journal is not balanced');
  return journal;
}

/**
 * Money received from a customer against their outstanding invoices (§5.8).
 *
 * `DR CASH`/`BANK` — where the money landed;
 * `CR AR:{party}` — what it settled;
 * `CR CUSTOMER_ADVANCE:{party}` — anything beyond what was owed, which the next
 * sale spends. Overpayment is deliberately kept rather than refused: a customer
 * handing over a round figure against three dues is the normal case.
 */
export function receiptPosting(sides: {
  readonly partyId: string;
  readonly account: AccountCode;
  readonly amountMinor: number;
  readonly settledMinor: number;
}): JournalEntryDraft {
  if (sides.amountMinor <= 0) throw new RangeError('A receipt must be worth something');
  if (sides.settledMinor < 0 || sides.settledMinor > sides.amountMinor) {
    throw new RangeError('A receipt cannot settle more than it is worth');
  }
  const advanceMinor = sides.amountMinor - sides.settledMinor;

  const journal: JournalEntryDraft = {
    lines: [
      { account: sides.account, amountMinor: sides.amountMinor, partyId: null },
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
    ],
  };

  if (rejectEntry(journal) !== null) throw new Error('Receipt journal is not balanced');
  return journal;
}

/**
 * Spreading one receipt over the invoices it settles, oldest first (§5.8).
 *
 * The order and the filling are **not** reimplemented here: `allocateOldestFirst`
 * already does exactly that for supplier payments, and a shop settling its
 * oldest bill first and collecting against its oldest invoice first is one rule,
 * not two. The only difference is what happens to money left over — a supplier
 * payment refuses it, a customer receipt keeps it as an advance (§5.8) — so this
 * caps what it hands down and reports the remainder itself.
 */
export interface AllocatableInvoice {
  readonly saleId: string;
  readonly outstandingMinor: number;
}

export interface ReceiptAllocation {
  readonly saleId: string;
  readonly amountMinor: number;
}

export function allocateReceipt(
  amountMinor: number,
  invoices: readonly AllocatableInvoice[],
): { readonly allocations: readonly ReceiptAllocation[]; readonly advanceMinor: number } {
  const outstanding = invoices.reduce(
    (sum, invoice) => sum + Math.max(invoice.outstandingMinor, 0),
    0,
  );
  const settledMinor = Math.min(Math.max(amountMinor, 0), outstanding);
  if (settledMinor === 0) return { allocations: [], advanceMinor: Math.max(amountMinor, 0) };

  const allocations = allocateOldestFirst(
    invoices.map((invoice) => ({
      purchaseId: invoice.saleId,
      outstandingMinor: invoice.outstandingMinor,
    })),
    settledMinor,
  ).map((allocation) => ({ saleId: allocation.purchaseId, amountMinor: allocation.amountMinor }));

  return { allocations, advanceMinor: amountMinor - settledMinor };
}

/** Which ageing bucket an unpaid invoice falls in, as of a business date (§5.8). */
export type AgeingBucket = 'NOT_DUE' | 'D1_30' | 'D31_60' | 'D61_90' | 'D90_PLUS';

export function ageingBucket(
  asOf: string,
  businessDate: string,
  dueDate: string | null,
): AgeingBucket {
  // A sale with no due date is never overdue (owner decision 2026-08-25); it
  // ages from the day it was sold, which is the only honest reference point.
  const from = dueDate ?? businessDate;
  if (dueDate !== null && asOf <= dueDate) return 'NOT_DUE';
  const days = daysBetween(from, asOf);
  if (days <= 0) return 'NOT_DUE';
  if (days <= 30) return 'D1_30';
  if (days <= 60) return 'D31_60';
  if (days <= 90) return 'D61_90';
  return 'D90_PLUS';
}

/** Whole days between two `YYYY-MM-DD` business dates, in UTC (§3.5). */
function daysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.round((end - start) / 86_400_000);
}

/** Quantity (scale 3) × price (poisha), rounded once — the same rule as `Money`. */
function grossOf(qty: number, unitPriceMinor: number): number {
  return Money(unitPriceMinor).multiply(Qty(qty)).minor;
}
