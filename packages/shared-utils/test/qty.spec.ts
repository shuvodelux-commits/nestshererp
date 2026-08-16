import { describe, expect, it } from 'vitest';

import { Qty } from '../src/qty';
import { randomInts } from './prng';

describe('Qty construction', () => {
  it('rejects a float — quantity is integer thousandths only', () => {
    expect(() => Qty(2.5)).toThrow(TypeError);
  });

  it('rejects a value outside the safe integer range', () => {
    expect(() => Qty(Number.MAX_SAFE_INTEGER + 2)).toThrow(RangeError);
  });

  it('keeps the exact raw value it was given', () => {
    expect(Qty(2500).raw).toBe(2500);
    expect(Qty(0).raw).toBe(0);
    expect(Qty(-2500).raw).toBe(-2500);
  });
});

describe('Qty.format', () => {
  it('formats to three decimals', () => {
    expect(Qty(2500).format()).toBe('2.500');
    expect(Qty(0).format()).toBe('0.000');
    expect(Qty(1).format()).toBe('0.001');
    expect(Qty(-2500).format()).toBe('-2.500');
    expect(Qty(1234567).format()).toBe('1,234.567');
  });
});

describe('Qty.add / subtract', () => {
  it('adds and subtracts exactly', () => {
    expect(Qty(2500).add(Qty(500)).raw).toBe(3000);
    expect(Qty(2500).subtract(Qty(500)).raw).toBe(2000);
    expect(Qty(500).subtract(Qty(2500)).raw).toBe(-2000);
  });

  it('a.add(b).subtract(b) equals a for 500 generated pairs', () => {
    const values = randomInts(2_000, 1_000_000, 1_000);
    for (let index = 0; index + 1 < values.length; index += 2) {
      const a = Qty(values[index] ?? 0);
      const b = Qty(values[index + 1] ?? 0);
      expect(a.add(b).subtract(b).equals(a)).toBe(true);
    }
  });
});

describe('Qty.multiply — unit conversion (D-10)', () => {
  it('1 carton × 24 pieces = 24 pieces', () => {
    expect(Qty(1000).multiply(Qty(24000)).raw).toBe(24000);
  });

  it('2.5 pipes × 20 feet = 50 feet', () => {
    expect(Qty(2500).multiply(Qty(20000)).raw).toBe(50000);
  });

  it('rounds half-up once, symmetrically', () => {
    // 0.001 × 0.500 = 0.0005 → 0.001
    expect(Qty(1).multiply(Qty(500)).raw).toBe(1);
    expect(Qty(-1).multiply(Qty(500)).raw).toBe(-1);
    expect(Qty(1).multiply(Qty(499)).raw).toBe(0);
  });
});

describe('Qty.allocate', () => {
  const raws = (parts: readonly Qty[]): number[] => parts.map((part) => part.raw);

  it('splits with the largest remainder method and sums exactly', () => {
    expect(raws(Qty(1000).allocate([1, 1, 1]))).toEqual([334, 333, 333]);
    expect(raws(Qty(10).allocate([1, 1, 1, 1, 1, 1, 1]))).toEqual([2, 2, 2, 1, 1, 1, 1]);
    expect(raws(Qty(100).allocate([3, 1]))).toEqual([75, 25]);
  });

  it('parts sum EXACTLY to the whole for 300 generated cases', () => {
    const totals = randomInts(3_101, 2_000_000, 300).map((value) => value - 1_000_000);
    const weightPool = randomInts(4_101, 500, 1_500);

    totals.forEach((total, caseIndex) => {
      const count = 1 + (caseIndex % 6);
      const drawn = Array.from(
        { length: count },
        (_, i) => weightPool[(caseIndex * 6 + i) % weightPool.length] ?? 1,
      );
      const weights = drawn.some((weight) => weight > 0) ? drawn : [1, ...drawn.slice(1)];

      const parts = Qty(total).allocate(weights);
      expect(parts.reduce((sum, part) => sum + part.raw, 0)).toBe(total);
    });
  });

  it('rejects weights that cannot define a split', () => {
    expect(() => Qty(100).allocate([])).toThrow(RangeError);
    expect(() => Qty(100).allocate([0])).toThrow(RangeError);
    expect(() => Qty(100).allocate([-1, 1])).toThrow(RangeError);
  });
});

describe('Qty comparison and predicates', () => {
  it('compare returns -1, 0, 1', () => {
    expect(Qty(100).compare(Qty(200))).toBe(-1);
    expect(Qty(200).compare(Qty(100))).toBe(1);
    expect(Qty(100).compare(Qty(100))).toBe(0);
  });

  it('equals compares by raw value', () => {
    expect(Qty(100).equals(Qty(100))).toBe(true);
    expect(Qty(100).equals(Qty(101))).toBe(false);
  });

  it('isZero and isNegative', () => {
    expect(Qty(0).isZero()).toBe(true);
    expect(Qty(1).isZero()).toBe(false);
    expect(Qty(-1).isNegative()).toBe(true);
    expect(Qty(0).isNegative()).toBe(false);
    expect(Qty(1).isNegative()).toBe(false);
  });
});
