import { assertSafeInteger, formatScaled } from './scaled';

/**
 * Unit cost is a scaled integer with 4 decimals. ৳12.3456 is UnitCost(123456).
 *
 * Four decimals exist because FIFO consumption of fractional quantities against
 * a 2-decimal cost accumulates error across thousands of movements until
 * valuation no longer ties to the INVENTORY account (SRS 3.3).
 */
export const UNIT_COST_SCALE = 4;

export interface UnitCost {
  /** Integer ten-thousandths of a taka. */
  readonly raw: number;
  add(other: UnitCost): UnitCost;
  subtract(other: UnitCost): UnitCost;
  /** -1, 0 or 1. */
  compare(other: UnitCost): number;
  equals(other: UnitCost): boolean;
  isZero(): boolean;
  isNegative(): boolean;
  /** "12.3456" */
  format(): string;
}

class UnitCostValue implements UnitCost {
  constructor(readonly raw: number) {}

  add(other: UnitCost): UnitCost {
    return UnitCost(this.raw + other.raw);
  }

  subtract(other: UnitCost): UnitCost {
    return UnitCost(this.raw - other.raw);
  }

  compare(other: UnitCost): number {
    if (this.raw < other.raw) return -1;
    return this.raw > other.raw ? 1 : 0;
  }

  equals(other: UnitCost): boolean {
    return this.raw === other.raw;
  }

  isZero(): boolean {
    return this.raw === 0;
  }

  isNegative(): boolean {
    return this.raw < 0;
  }

  format(): string {
    return formatScaled(this.raw, UNIT_COST_SCALE);
  }
}

/** Builds a UnitCost from integer ten-thousandths. */
export function UnitCost(raw: number): UnitCost {
  assertSafeInteger(raw, 'UnitCost raw units');
  return new UnitCostValue(raw);
}
