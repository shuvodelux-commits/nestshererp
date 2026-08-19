import { divideRoundHalfUp, multiplyScaled, QTY_SCALE } from '@sher/shared-utils';

/**
 * Per-product unit conversion (D-10, revised by owner decision 2026-08-19 —
 * D-41).
 *
 * **One optional conversion unit per product.** A product always has a base
 * unit; a product that needs it may also name **one** conversion unit and how
 * many base units it contains: `Base Unit = Feet, Conversion Unit = Pipe,
 * 1 Pipe = 20 Feet`. A product without both is an ordinary single-unit product
 * and nothing in this file touches it.
 *
 * **Everything is stored and calculated in the base unit.** `5 Pipe + 5 Feet` is
 * one stock figure of `105 Feet`, not two numbers to keep in step. The
 * conversion unit is a way of *entering* and *reading* that figure, never a
 * second quantity — which is what keeps INV-02 (stock on hand = Σ movements)
 * meaningful when a shop buys in Pipes and sells in Feet.
 *
 * Pure: same input, same output, no clock, no I/O, no floating point. The
 * rounding is D-31's, borrowed from `shared-utils` rather than written again.
 */

/** The factor is a `Qty`-scaled integer: 1 Pipe = 20 Feet is `20000`. */
export const CONVERSION_FACTOR_SCALE = QTY_SCALE;

/**
 * A conversion is either fully present or fully absent. A unit with no factor,
 * or a factor with no unit, is half a rule — and half a rule is what turns a
 * purchase of 5 Pipes into 5 Feet of stock.
 */
export interface UnitConversion {
  readonly conversionUnitId: string;
  readonly factorQty: number;
}

/** A quantity as a person reads it: `5 Pipe + 5 Feet`. Both are `Qty`-scaled. */
export interface MixedQty {
  readonly conversionQty: number;
  readonly baseQty: number;
}

export function isValidConversionFactor(rawFactor: number): boolean {
  // Deliberately not required to be a whole number of base units — 0.5 kg bags
  // exist — but it must be positive: a zero factor would make a purchase in
  // Pipes add no stock at all, and a negative one would remove it.
  return Number.isSafeInteger(rawFactor) && rawFactor > 0;
}

/**
 * Why a conversion was refused. A reason code, not a message: `core-domain` owns
 * the rule and the application layer owns the wording.
 */
export type ConversionRejection =
  | 'CONVERSION_UNIT_WITHOUT_FACTOR'
  | 'CONVERSION_FACTOR_WITHOUT_UNIT'
  | 'CONVERSION_FACTOR_NOT_POSITIVE'
  | 'CONVERSION_UNIT_IS_THE_BASE_UNIT';

export function rejectConversion(
  baseUnitId: string,
  conversionUnitId: string | null,
  factorQty: number | null,
): ConversionRejection | null {
  if (conversionUnitId === null && factorQty === null) return null;
  if (conversionUnitId === null) return 'CONVERSION_FACTOR_WITHOUT_UNIT';
  if (factorQty === null) return 'CONVERSION_UNIT_WITHOUT_FACTOR';
  if (!isValidConversionFactor(factorQty)) return 'CONVERSION_FACTOR_NOT_POSITIVE';
  // `1 Feet = 3 Feet` is not a conversion, it is a contradiction.
  if (conversionUnitId === baseUnitId) return 'CONVERSION_UNIT_IS_THE_BASE_UNIT';
  return null;
}

/**
 * The two boxes a Purchase or POS line offers — `5 Pipe` and `5 Feet` — as the
 * one base-unit figure everything downstream stores: `105 Feet`.
 *
 * Exact: the product of two scale-3 integers is computed in BigInt and rescaled
 * once (D-31), so no intermediate is ever a float.
 */
export function toBaseQty(mixed: MixedQty, factorQty: number): number {
  const fromConversion = multiplyScaled(
    mixed.conversionQty,
    factorQty,
    QTY_SCALE,
    'conversion quantity',
  );
  return fromConversion + mixed.baseQty;
}

/**
 * The reverse, for reading: `105 Feet` shown as `5 Pipe + 5 Feet`.
 *
 * The magnitude is split and the sign re-applied, so a negative stock figure
 * reads as the mirror image of the positive one rather than drifting by a unit.
 * The remainder is always smaller than one conversion unit, so the two parts
 * recombine to exactly what was passed in — `toBaseQty(splitToMixed(q, f), f)
 * === q` for every q, which is the property that makes this safe to show beside
 * a stock figure people count against.
 */
export function splitToMixed(totalBaseQty: number, factorQty: number): MixedQty {
  const negative = totalBaseQty < 0;
  const magnitude = BigInt(negative ? -totalBaseQty : totalBaseQty);
  const factor = BigInt(factorQty);

  // Truncating division, not rounding: 19 Feet is 0 Pipe + 19 Feet, never 1 Pipe.
  const whole = magnitude / factor;
  const remainder = magnitude - whole * factor;

  const conversionQty = Number(whole) * 10 ** QTY_SCALE;
  const baseQty = Number(remainder);

  return negative
    ? { conversionQty: -conversionQty, baseQty: -baseQty }
    : { conversionQty, baseQty };
}

/**
 * A price per base unit read as a price per conversion unit: ৳5.25/Feet at
 * `1 Pipe = 20 Feet` is ৳105.00/Pipe.
 *
 * Money is stored per **base** unit, always. This is a display and entry
 * convenience, and it is exact in this direction — multiplication of two
 * integers never loses anything.
 */
export function pricePerConversionUnit(basePriceMinor: number, factorQty: number): number {
  return multiplyScaled(basePriceMinor, factorQty, QTY_SCALE, 'price per conversion unit');
}

/**
 * The direction that can lose a poisha, and the reason the screen must show the
 * result back.
 *
 * ৳105.05 per Pipe over 20 Feet is ৳5.2525 per Foot, and money is stored at two
 * decimals (§3.3) — so it rounds **half-up, once** (D-31) to ৳5.25, and reading
 * that back gives ৳105.00 rather than the ৳105.05 that was typed. That is not a
 * bug to hide: the base-unit price is the stored fact, and every line total in
 * the system is computed from it. The form shows what was actually stored.
 */
export function pricePerBaseUnit(conversionPriceMinor: number, factorQty: number): number {
  const scaled = BigInt(conversionPriceMinor) * 10n ** BigInt(QTY_SCALE);
  return Number(divideRoundHalfUp(scaled, BigInt(factorQty)));
}
