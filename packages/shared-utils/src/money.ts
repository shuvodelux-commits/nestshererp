import type { Qty } from './qty';
import {
  allocateLargestRemainder,
  assertSafeInteger,
  formatScaled,
  multiplyScaled,
  parseScaled,
} from './scaled';

/** Money is BDT in integer poisha (scale 2). ৳1,250.75 is Money(125075). */
export const MONEY_SCALE = 2;

/** Quantity carries 3 decimals, so a money × qty product carries 5 (SRS 3.3). */
const QTY_SCALE = 3;

export interface Money {
  /** Integer poisha. Never a float, never a formatted string. */
  readonly minor: number;
  add(other: Money): Money;
  subtract(other: Money): Money;
  /**
   * Extended amount for a quantity. The product is computed exactly and rounded
   * half-up ONCE at the end (D-31) — no intermediate is ever rounded.
   */
  multiply(qty: Qty): Money;
  /** Splits this amount across weights; parts always sum exactly to the whole. */
  allocate(weights: readonly number[]): Money[];
  /** -1, 0 or 1. */
  compare(other: Money): number;
  equals(other: Money): boolean;
  isZero(): boolean;
  isNegative(): boolean;
  /** "1,250.75" — no currency mark; the UI adds ৳ (UI-32). */
  format(): string;
}

class MoneyValue implements Money {
  constructor(readonly minor: number) {}

  add(other: Money): Money {
    return Money(this.minor + other.minor);
  }

  subtract(other: Money): Money {
    return Money(this.minor - other.minor);
  }

  multiply(qty: Qty): Money {
    return Money(multiplyScaled(this.minor, qty.raw, QTY_SCALE, 'Money'));
  }

  allocate(weights: readonly number[]): Money[] {
    return allocateLargestRemainder(this.minor, weights, 'Money').map(Money);
  }

  compare(other: Money): number {
    if (this.minor < other.minor) return -1;
    return this.minor > other.minor ? 1 : 0;
  }

  equals(other: Money): boolean {
    return this.minor === other.minor;
  }

  isZero(): boolean {
    return this.minor === 0;
  }

  isNegative(): boolean {
    return this.minor < 0;
  }

  format(): string {
    return formatScaled(this.minor, MONEY_SCALE);
  }
}

/** Builds Money from integer poisha. Rejects floats — there is no Money(12.5). */
export function Money(minor: number): Money {
  assertSafeInteger(minor, 'Money minor units');
  return new MoneyValue(minor);
}

/**
 * What someone typed, as integer poisha — `"150.75"` is `15075`. `null` when the
 * text is not an amount with at most two decimal places (see `parseScaled`).
 *
 * Every money input in the application goes through here (UI-31): a component
 * formats and parses through `shared-utils` and never does arithmetic itself.
 */
export function parseMoney(text: string): number | null {
  return parseScaled(text, MONEY_SCALE);
}

/** Whole-taka settlement boundary: 100 integer poisha = ৳1.
 *
 * This helper is preparatory. It does NOT rewrite stored money, round unit costs,
 * change the posted sale/purchase journal, or enable whole-taka posting by itself.
 * Signed amounts round half away from zero symmetrically; no floats are used.
 */
export const POISHA_PER_TAKA = 100;

export function isWholeTakaMinor(valueMinor: number): boolean {
  return Number.isSafeInteger(valueMinor) && valueMinor % POISHA_PER_TAKA === 0;
}

export function roundWholeTakaMinor(valueMinor: number): number {
  assertSafeInteger(valueMinor, 'Whole-taka source poisha');
  const magnitude = BigInt(valueMinor < 0 ? -valueMinor : valueMinor);
  const rounded = ((magnitude + 50n) / 100n) * 100n;
  const result = Number(valueMinor < 0 ? -rounded : rounded);
  assertSafeInteger(result, 'Whole-taka rounded poisha');
  return result;
}

/** Proposed allocation for a NEW whole-taka source line, not for legacy lines.
 *
 * Absolute cumulative entitlement is computed from the frozen source amount;
 * the next credit subtracts the *actual posted* prior credit, not an estimate
 * of what prior returns should have posted. Never over-credit the source.
 *
 * q values use the existing scale-3 integer Qty units; frozen and prior money
 * must already be whole-taka. Zero-valued positive-quantity returns are valid.
 * Callers must validate tenant, source identity and returnable inventory first.
 */
export function remainingWholeTakaReturnMinor(
  frozenSourceMinor: number,
  qtyTotal: number,
  qtyAlreadyReturned: number,
  qtyNowReturning: number,
  priorPostedMinor: number,
): number {
  for (const [label, n] of [
    ['Frozen source', frozenSourceMinor],
    ['Original quantity', qtyTotal],
    ['Prior quantity', qtyAlreadyReturned],
    ['Current return quantity', qtyNowReturning],
    ['Prior posted credit', priorPostedMinor],
  ] as const) {
    assertSafeInteger(n, label);
    if (n < 0) throw new RangeError(label + ' cannot be negative');
  }
  if (!isWholeTakaMinor(frozenSourceMinor) || !isWholeTakaMinor(priorPostedMinor)) {
    throw new RangeError('Whole-taka returns require a frozen whole-taka source and prior credit');
  }
  if (qtyTotal <= 0 || qtyNowReturning <= 0) {
    throw new RangeError('A return requires positive original and returned quantities');
  }
  if (BigInt(qtyAlreadyReturned) + BigInt(qtyNowReturning) > BigInt(qtyTotal)) {
    throw new RangeError('Return quantity exceeds its frozen source');
  }
  if (priorPostedMinor > frozenSourceMinor) {
    throw new RangeError('Source already has overcredited history; reconcile it first');
  }
  // Round cumulative original taka to nearest whole taka, half-up.
  const numerator = BigInt(frozenSourceMinor / POISHA_PER_TAKA) *
    (BigInt(qtyAlreadyReturned) + BigInt(qtyNowReturning));
  const denominator = BigInt(qtyTotal);
  const cumulativeTaka = (2n * numerator + denominator) / (2n * denominator);
  const cumulativeMinor = cumulativeTaka * BigInt(POISHA_PER_TAKA);
  const difference = cumulativeMinor - BigInt(priorPostedMinor);
  const remaining = BigInt(frozenSourceMinor - priorPostedMinor);
  return Number(difference <= 0n ? 0n : difference > remaining ? remaining : difference);
}
