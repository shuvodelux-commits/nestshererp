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
