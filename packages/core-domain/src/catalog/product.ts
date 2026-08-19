/**
 * Product rules (§5.5). Pure: same input, same output, no clock and no I/O — the
 * "now" an offer is judged against is passed in.
 *
 * §5.5 fixes the mandatory field set exactly: Product Name, Base Unit, Purchase
 * Price, Selling Price, Minimum Stock / Reorder Level. Everything else is
 * optional "unless their feature is enabled and specifically requires more", and
 * G2.2 forbids making an optional field mandatory because a column exists.
 */
export type ProductStatus = 'ACTIVE' | 'INACTIVE';

/** §5.5: `FIXED_AMOUNT | PERCENTAGE | null`. Both, and only these two. */
export type DiscountType = 'FIXED_AMOUNT' | 'PERCENTAGE';

/**
 * A percentage is a scaled integer with 2 decimals: 12.5% is `1250`, 100% is
 * `10000`. Not a float — a percentage multiplies money, and the whole point of
 * §3.3 is that nothing in that chain is ever a float.
 */
export const PERCENT_SCALE = 2;
export const ONE_HUNDRED_PERCENT = 10_000;

/**
 * The price side of a product. `defaultDiscountValue` is read in minor units of
 * whatever `defaultDiscountType` says it is: poisha for `FIXED_AMOUNT`,
 * hundredths of a percent for `PERCENTAGE`.
 */
export interface ProductPricing {
  readonly purchasePriceMinor: number;
  readonly sellingPriceMinor: number;
  readonly defaultDiscountType: DiscountType | null;
  readonly defaultDiscountValue: number | null;
  readonly offerPriceMinor: number | null;
  readonly offerStartAt: Date | null;
  readonly offerEndAt: Date | null;
}

/**
 * Why a set of prices was refused. A reason code rather than a message, because
 * `core-domain` owns the rule and the application layer owns the wording (and
 * the error code that goes with it).
 */
export type PricingRejection =
  | 'PRICE_NOT_A_WHOLE_MINOR_UNIT'
  | 'PRICE_NEGATIVE'
  | 'DISCOUNT_VALUE_WITHOUT_TYPE'
  | 'DISCOUNT_TYPE_WITHOUT_VALUE'
  | 'DISCOUNT_NEGATIVE'
  | 'DISCOUNT_PERCENT_ABOVE_100'
  | 'DISCOUNT_ABOVE_SELLING_PRICE'
  | 'OFFER_PRICE_NOT_POSITIVE'
  | 'OFFER_WINDOW_ENDS_BEFORE_IT_STARTS';

export function rejectPricing(pricing: ProductPricing): PricingRejection | null {
  for (const price of [pricing.purchasePriceMinor, pricing.sellingPriceMinor]) {
    if (!Number.isSafeInteger(price)) return 'PRICE_NOT_A_WHOLE_MINOR_UNIT';
    // Zero is allowed: a free sample has a selling price of nothing, and goods
    // received at no cost have a purchase price of nothing. Negative is not.
    if (price < 0) return 'PRICE_NEGATIVE';
  }

  const { defaultDiscountType: type, defaultDiscountValue: value } = pricing;
  if (type === null && value !== null) return 'DISCOUNT_VALUE_WITHOUT_TYPE';
  if (type !== null && value === null) return 'DISCOUNT_TYPE_WITHOUT_VALUE';

  if (type !== null && value !== null) {
    if (!Number.isSafeInteger(value) || value < 0) return 'DISCOUNT_NEGATIVE';
    if (type === 'PERCENTAGE' && value > ONE_HUNDRED_PERCENT) {
      return 'DISCOUNT_PERCENT_ABOVE_100';
    }
    // §5.7 has "the posting service validates discount boundaries"; the same
    // boundary applies to a *stored default*, because a standing discount larger
    // than the price proposes a negative line total to every sale that uses it.
    if (type === 'FIXED_AMOUNT' && value > pricing.sellingPriceMinor) {
      return 'DISCOUNT_ABOVE_SELLING_PRICE';
    }
  }

  if (pricing.offerPriceMinor !== null) {
    if (!Number.isSafeInteger(pricing.offerPriceMinor) || pricing.offerPriceMinor <= 0) {
      return 'OFFER_PRICE_NOT_POSITIVE';
    }
  }

  const { offerStartAt: from, offerEndAt: until } = pricing;
  if (from !== null && until !== null && until.getTime() <= from.getTime()) {
    return 'OFFER_WINDOW_ENDS_BEFORE_IT_STARTS';
  }

  return null;
}

/**
 * Whether a product's promotion is live at a given instant (§5.5).
 *
 * An absent bound is open-ended in that direction: an offer with no end date runs
 * until it is switched off. `enabled` is the shopkeeper's own on/off — §5.5 lists
 * an "active/inactive state" for the offer, separate from its dates, so a
 * seasonal offer can be parked without losing the dates that describe it.
 *
 * The offer never replaces the normal selling price (§5.5). It is a separate
 * figure; what the invoice line stores is a snapshot of what was applied.
 */
export function offerAppliesAt(
  offer: {
    readonly enabled: boolean;
    readonly offerPriceMinor: number | null;
    readonly offerStartAt: Date | null;
    readonly offerEndAt: Date | null;
  },
  at: Date,
): boolean {
  if (!offer.enabled || offer.offerPriceMinor === null) return false;
  if (offer.offerStartAt !== null && at.getTime() < offer.offerStartAt.getTime()) return false;
  if (offer.offerEndAt !== null && at.getTime() > offer.offerEndAt.getTime()) return false;
  return true;
}

/**
 * §5.5: "Display name = `Brand + Product Name` when brand exists; otherwise
 * Product Name."
 *
 * Derived on read, never stored — storing it would mean renaming a brand left
 * every product carrying the old name, which is the exact reason brands are their
 * own table.
 */
export function displayNameOf(brandName: string | null, productName: string): string {
  return brandName === null || brandName === '' ? productName : `${brandName} ${productName}`;
}

/**
 * A SKU or barcode the shopkeeper left blank is **absent**, not an empty string:
 * both are unique per tenant, and two products with `''` would collide on a
 * constraint that is supposed to be about real codes.
 */
export function blankToNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
