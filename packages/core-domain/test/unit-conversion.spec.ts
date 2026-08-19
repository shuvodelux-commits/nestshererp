import { describe, expect, it } from 'vitest';

import {
  pricePerBaseUnit,
  pricePerConversionUnit,
  rejectConversion,
  splitToMixed,
  toBaseQty,
} from '../src/catalog/unit-conversion';

/**
 * Per-product unit conversion (D-10, D-41). Pure domain — no database, no HTTP
 * (R-E4), exact expected numbers written before the code (R-E7).
 *
 * The worked example throughout is the owner's own: **Base Unit = Feet,
 * Conversion Unit = Pipe, 1 Pipe = 20 Feet**. Quantities are scale-3 integers,
 * so 1 Pipe = 20 Feet is `20000`, and 5 Pipe is `5000`.
 *
 * The property that matters more than any single case: splitting a figure for
 * display and recombining it must return **exactly** the figure. A stock number
 * that reads as `5 Pipe + 5 Feet` but is not `105 Feet` is a stock number a shop
 * would count against and find wrong.
 */
const BASE = '01UNITFEETAAAAAAAAAAAAAAAA';
const PIPE = '01UNITPIPEAAAAAAAAAAAAAAAA';
/** 1 Pipe = 20 Feet. */
const FACTOR = 20_000;

describe('entering a mixed quantity', () => {
  it('normalises 5 Pipe + 5 Feet to 105 Feet', () => {
    expect(toBaseQty({ conversionQty: 5_000, baseQty: 5_000 }, FACTOR)).toBe(105_000);
  });

  it('takes the conversion box alone', () => {
    expect(toBaseQty({ conversionQty: 5_000, baseQty: 0 }, FACTOR)).toBe(100_000);
  });

  it('takes the base box alone', () => {
    expect(toBaseQty({ conversionQty: 0, baseQty: 5_000 }, FACTOR)).toBe(5_000);
  });

  it('handles a fractional conversion quantity exactly', () => {
    // Half a Pipe is 10 Feet. Computed in BigInt and rescaled once — never a float.
    expect(toBaseQty({ conversionQty: 500, baseQty: 0 }, FACTOR)).toBe(10_000);
  });

  it('handles a fractional factor, for the shops that sell by weight', () => {
    // 1 Bag = 0.5 Kg; 3 Bags is 1.5 Kg.
    expect(toBaseQty({ conversionQty: 3_000, baseQty: 0 }, 500)).toBe(1_500);
  });
});

describe('reading a quantity back', () => {
  it('shows 105 Feet as 5 Pipe + 5 Feet', () => {
    expect(splitToMixed(105_000, FACTOR)).toEqual({ conversionQty: 5_000, baseQty: 5_000 });
  });

  it('does not round a part-full conversion unit up', () => {
    // 19 Feet is 0 Pipe + 19 Feet. Rounding it to 1 Pipe would report stock
    // the shop does not have.
    expect(splitToMixed(19_000, FACTOR)).toEqual({ conversionQty: 0, baseQty: 19_000 });
  });

  it('shows an exact multiple with no remainder', () => {
    expect(splitToMixed(100_000, FACTOR)).toEqual({ conversionQty: 5_000, baseQty: 0 });
  });

  it('mirrors a negative figure rather than drifting', () => {
    // Negative stock is possible where the shop allows it (§5.10); it must read
    // as the mirror image of the positive figure.
    expect(splitToMixed(-105_000, FACTOR)).toEqual({ conversionQty: -5_000, baseQty: -5_000 });
  });

  it('recombines to exactly what it was given, for every case', () => {
    const factors = [20_000, 24_000, 500, 1, 1_000, 7_000];
    const totals = [0, 1, 999, 1_000, 19_999, 105_000, -105_000, -1, 8_675_309];

    for (const factor of factors) {
      for (const total of totals) {
        expect(toBaseQty(splitToMixed(total, factor), factor)).toBe(total);
      }
    }
  });
});

describe('switching the price between units', () => {
  it('reads ৳5.25 per Foot as ৳105.00 per Pipe', () => {
    // 525 poisha × 20 = 10500 poisha. Exact in this direction, always.
    expect(pricePerConversionUnit(525, FACTOR)).toBe(10_500);
  });

  it('stores ৳105.00 per Pipe as ৳5.25 per Foot', () => {
    expect(pricePerBaseUnit(10_500, FACTOR)).toBe(525);
  });

  it('rounds half-up once when a per-Pipe price does not divide evenly (D-31)', () => {
    // ৳105.05 per Pipe is ৳5.2525 per Foot; money is stored at two decimals, so
    // it becomes 525 poisha and reads back as ৳105.00. The stored base price is
    // the fact every line total is computed from, so the form shows this back
    // rather than pretending the ৳0.05 survived.
    expect(pricePerBaseUnit(10_505, FACTOR)).toBe(525);
    expect(pricePerConversionUnit(525, FACTOR)).toBe(10_500);

    // Half rounds up, not down: ৳105.10 per Pipe is ৳5.255 per Foot → 526.
    expect(pricePerBaseUnit(10_510, FACTOR)).toBe(526);
  });

  it('is exact both ways when the factor divides the price', () => {
    expect(pricePerBaseUnit(pricePerConversionUnit(1_234, FACTOR), FACTOR)).toBe(1_234);
  });
});

describe('what counts as a conversion at all', () => {
  it('accepts a product with no conversion', () => {
    expect(rejectConversion(BASE, null, null)).toBeNull();
  });

  it('accepts a complete conversion', () => {
    expect(rejectConversion(BASE, PIPE, FACTOR)).toBeNull();
  });

  it('refuses half a rule', () => {
    expect(rejectConversion(BASE, PIPE, null)).toBe('CONVERSION_UNIT_WITHOUT_FACTOR');
    expect(rejectConversion(BASE, null, FACTOR)).toBe('CONVERSION_FACTOR_WITHOUT_UNIT');
  });

  it('refuses a factor that would add no stock, or remove it', () => {
    expect(rejectConversion(BASE, PIPE, 0)).toBe('CONVERSION_FACTOR_NOT_POSITIVE');
    expect(rejectConversion(BASE, PIPE, -20_000)).toBe('CONVERSION_FACTOR_NOT_POSITIVE');
  });

  it('refuses converting the base unit to itself', () => {
    expect(rejectConversion(BASE, BASE, 3_000)).toBe('CONVERSION_UNIT_IS_THE_BASE_UNIT');
  });
});
