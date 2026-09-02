import { saleTotals } from '@sher/core-domain';
import type { SaleTotals } from '@sher/core-domain';

/**
 * The cart's arithmetic — which is **not written here**.
 *
 * `saleTotals` is the domain function the posting service runs on the server
 * (`packages/core-domain/src/sales/sale.ts`). The POS calls it on every
 * keystroke so a figure never waits for a round trip (the owner's binding rule
 * of 2026-08-25), and calling the same function is the only way for the screen
 * and the journal to be incapable of disagreeing. This module does one thing:
 * turn the taka a shopkeeper types into the poisha the domain works in.
 *
 * A cart that cannot be totalled yet — empty, or a line still being typed —
 * returns zeros rather than throwing, because a half-typed cart is normal and
 * a screen that goes blank mid-keystroke is not.
 */

export interface CartLine {
  readonly productId: string;
  readonly productName: string;
  readonly unitName: string;
  qty: number;
  /** Taka, as typed. Converted to poisha only here and when posting. */
  price: number;
  lineDiscount: number;
  /** Net owned position, used for the final-stock warning. */
  readonly qtyOnHand: number;
  /** Physical sellable OWNED lots; allocation must not use the net position. */
  readonly sellableOwnedQty: number;
  readonly purchasePriceMinor: number | null;
  readonly tracksSerial: boolean;
  source: 'OWN_STOCK' | 'VENDOR_CONSIGNMENT';
  /**
   * Set when the shopkeeper answered a shortage with **Negative Stock**.
   *
   * Kept per line rather than per sale: one line short of two pieces is a
   * decision about that line, and a cart where answering one shortage silently
   * licensed every other one is how stock goes missing (owner-reported,
   * 2026-08-26).
   */
  allowNegative: boolean;
  vendorPartyId: string;
  vendorUnitCost: number;
  /** Display quantities in base units; converted to scale-3 only at the API edge. */
  vendorAllocation: number;
  negativeAllocation: number;
  vendorAvailableQty: number;
  correctionVendorRestoreQty: number;
  selectedOwnedSerialIds: string[];
  selectedVendorSerialIds: string[];
  correctionSerials: { id: string; serialNo: string; source: 'OWNED' | 'VENDOR' }[];
  allocationConfirmed: boolean;
  allocationOpen: boolean;
  showDetail: boolean;
}

const EMPTY: SaleTotals = {
  itemsTotalMinor: 0,
  discountMinor: 0,
  grandTotalMinor: 0,
  lines: [],
  paidMinor: 0,
  dueMinor: 0,
  changeMinor: 0,
};

export function cartTotals(
  lines: readonly CartLine[],
  discountTaka: number,
  paidMinor: number,
): SaleTotals {
  if (lines.length === 0) return EMPTY;
  try {
    return saleTotals({
      lines: lines.map((line) => ({
        productId: line.productId,
        qty: Math.round(line.qty * 1000),
        unitPriceMinor: Math.round(line.price * 100),
        lineDiscountMinor: Math.round(line.lineDiscount * 100),
      })),
      discountMinor: Math.round(discountTaka * 100),
      paidMinor,
    });
  } catch {
    // The domain refuses a cart that makes no sense yet (a zero quantity being
    // typed, a discount momentarily larger than the goods). The screen keeps
    // its last shape instead of blanking; the button stays disabled anyway.
    return { ...EMPTY, paidMinor };
  }
}
