import {
  allocateLargestRemainder,
  assertSafeInteger,
  formatScaled,
  multiplyScaled,
  parseScaled,
} from './scaled';

/** Quantity is a scaled integer with 3 decimals. 2.5 pcs is Qty(2500). */
export const QTY_SCALE = 3;

export interface Qty {
  /** Integer thousandths of a unit. */
  readonly raw: number;
  add(other: Qty): Qty;
  subtract(other: Qty): Qty;
  /**
   * Quantity × quantity, for unit conversion (D-10: 1 Carton = 24 Pieces).
   * Rounded half-up ONCE at the end.
   */
  multiply(other: Qty): Qty;
  /** Splits this quantity across weights; parts always sum exactly to the whole. */
  allocate(weights: readonly number[]): Qty[];
  /** -1, 0 or 1. */
  compare(other: Qty): number;
  equals(other: Qty): boolean;
  isZero(): boolean;
  isNegative(): boolean;
  /** "2.500" */
  format(): string;
}

class QtyValue implements Qty {
  constructor(readonly raw: number) {}

  add(other: Qty): Qty {
    return Qty(this.raw + other.raw);
  }

  subtract(other: Qty): Qty {
    return Qty(this.raw - other.raw);
  }

  multiply(other: Qty): Qty {
    return Qty(multiplyScaled(this.raw, other.raw, QTY_SCALE, 'Qty'));
  }

  allocate(weights: readonly number[]): Qty[] {
    return allocateLargestRemainder(this.raw, weights, 'Qty').map(Qty);
  }

  compare(other: Qty): number {
    if (this.raw < other.raw) return -1;
    return this.raw > other.raw ? 1 : 0;
  }

  equals(other: Qty): boolean {
    return this.raw === other.raw;
  }

  isZero(): boolean {
    return this.raw === 0;
  }

  isNegative(): boolean {
    return this.raw < 0;
  }

  format(): string {
    return formatScaled(this.raw, QTY_SCALE);
  }
}

/** Builds a Qty from integer thousandths. Rejects floats — there is no Qty(2.5). */
export function Qty(raw: number): Qty {
  assertSafeInteger(raw, 'Qty raw units');
  return new QtyValue(raw);
}

/**
 * What someone typed, as a scaled quantity — `"2.5"` is `2500`. `null` when the
 * text is not a quantity with at most three decimal places.
 */
export function parseQty(text: string): number | null {
  return parseScaled(text, QTY_SCALE);
}
