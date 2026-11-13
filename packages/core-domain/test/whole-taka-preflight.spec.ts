import { describe, expect, it } from 'vitest';

import {
  inspectNewInvoiceWholeTaka,
  type DiscountedSourceLine,
} from '../src/accounting/whole-taka-preflight';

const line = (sourceLineId: string, netAmountMinor: number): DiscountedSourceLine => ({
  sourceLineId, netAmountMinor,
});

describe('owner-approved whole-taka NEW-invoice preflight (no posting)', () => {
  it('keeps mixed-unit source values and reports a separate signed final delta', () => {
    // 1 Box at ৳232.25 + 5 Pcs at ৳12.50: no base-rate flattening.
    const result = inspectNewInvoiceWholeTaka([
      line('box-price-segment', 23_225),
      line('pcs-price-segment', 6_250),
    ]);
    expect(result).toEqual({
      sourceNetMinor: 29_475,
      roundedObligationMinor: 29_500,
      roundingDeltaMinor: 25,
      requiresSourceAllocation: true,
      roundedPositiveToZero: false,
    });
  });

  it('receives discounts already applied and rounds final net only once', () => {
    // Gross ৳294.75 less ৳10.40 discount: new invoice payable ৳284.
    const result = inspectNewInvoiceWholeTaka([line('already-discounted', 28_435)]);
    expect(result.sourceNetMinor).toBe(28_435);
    expect(result.roundedObligationMinor).toBe(28_400);
    expect(result.roundingDeltaMinor).toBe(-35);
  });

  it('does not round each priced component or each line to full taka', () => {
    // Independent component rounding would charge ৳2; invoice rounding charges ৳1.
    const result = inspectNewInvoiceWholeTaka([line('half-box', 50), line('half-pcs', 50)]);
    expect(result.sourceNetMinor).toBe(100);
    expect(result.roundedObligationMinor).toBe(100);
    expect(result.roundingDeltaMinor).toBe(0);
    expect(result.requiresSourceAllocation).toBe(false);
  });

  it('applies exact .49/.50 boundary without a second line rounding', () => {
    expect(inspectNewInvoiceWholeTaka([line('x', 149)]).roundedObligationMinor).toBe(100);
    expect(inspectNewInvoiceWholeTaka([line('x', 150)]).roundedObligationMinor).toBe(200);
    expect(inspectNewInvoiceWholeTaka([line('x', 149)]).roundingDeltaMinor).toBe(-49);
    expect(inspectNewInvoiceWholeTaka([line('x', 150)]).roundingDeltaMinor).toBe(50);
  });

  it('flags positive source money that would round to a zero-taka NEW obligation', () => {
    const result = inspectNewInvoiceWholeTaka([line('low-value-new-invoice', 49)]);
    expect(result.sourceNetMinor).toBe(49);
    expect(result.roundedObligationMinor).toBe(0);
    expect(result.roundedPositiveToZero).toBe(true);
    expect(result.requiresSourceAllocation).toBe(true);
    // It only reports the policy blocker; it does not create a free sale.
  });

  it('refuses no source lines and zero-source NEW invoices without choosing free goods', () => {
    expect(() => inspectNewInvoiceWholeTaka([])).toThrow(RangeError);
    expect(() => inspectNewInvoiceWholeTaka([line('free', 0)])).toThrow(RangeError);
  });

  it('rejects malformed, duplicate, negative or fractional source rows', () => {
    expect(() => inspectNewInvoiceWholeTaka([line('', 100)])).toThrow(RangeError);
    expect(() => inspectNewInvoiceWholeTaka([line('  ', 100)])).toThrow(RangeError);
    expect(() => inspectNewInvoiceWholeTaka([line('same', 100), line('same', 50)]))
      .toThrow(RangeError);
    for (const value of [-1, 12.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => inspectNewInvoiceWholeTaka([line('bad', value)])).toThrow(RangeError);
    }
  });

  it('uses exact big-integer accumulation and refuses unsafe aggregate or rounding', () => {
    expect(() => inspectNewInvoiceWholeTaka([
      line('a', Number.MAX_SAFE_INTEGER - 100),
      line('b', 101),
    ])).toThrow(RangeError);
    expect(() => inspectNewInvoiceWholeTaka([line('large', Number.MAX_SAFE_INTEGER)]))
      .toThrow(RangeError);
  });

  it('is read-only and never mutates source net amounts', () => {
    const rows = Object.freeze([
      Object.freeze(line('a', 1_250)),
      Object.freeze(line('b', 5)),
    ]);
    const result = inspectNewInvoiceWholeTaka(rows);
    expect(result.sourceNetMinor).toBe(1_255);
    expect(result.roundedObligationMinor).toBe(1_300);
    expect(result.roundingDeltaMinor).toBe(45);
    expect(rows.map((row) => row.netAmountMinor)).toEqual([1_250, 5]);
  });
});
