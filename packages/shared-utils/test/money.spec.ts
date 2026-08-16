import { describe, expect, it } from 'vitest';

import { Money } from '../src/money';
import { Qty } from '../src/qty';
import { randomInts } from './prng';

describe('Money construction', () => {
  it('rejects a float — money is integer poisha only', () => {
    expect(() => Money(12.5)).toThrow(TypeError);
  });

  it('rejects a value outside the safe integer range', () => {
    expect(() => Money(Number.MAX_SAFE_INTEGER + 2)).toThrow(RangeError);
  });

  it('keeps the exact minor value it was given', () => {
    expect(Money(125075).minor).toBe(125075);
    expect(Money(0).minor).toBe(0);
    expect(Money(-125075).minor).toBe(-125075);
  });
});

describe('Money.format', () => {
  it('formats 125075 as 1,250.75', () => {
    expect(Money(125075).format()).toBe('1,250.75');
  });

  it('formats the boundary cases exactly', () => {
    expect(Money(0).format()).toBe('0.00');
    expect(Money(5).format()).toBe('0.05');
    expect(Money(50).format()).toBe('0.50');
    expect(Money(100).format()).toBe('1.00');
    expect(Money(-125075).format()).toBe('-1,250.75');
    expect(Money(123456789012).format()).toBe('1,234,567,890.12');
  });
});

describe('Money.add / subtract', () => {
  it('adds and subtracts exactly', () => {
    expect(Money(125075).add(Money(2500)).minor).toBe(127575);
    expect(Money(125075).subtract(Money(2500)).minor).toBe(122575);
    expect(Money(100).subtract(Money(250)).minor).toBe(-150);
  });

  it('a.add(b).subtract(b) equals a for 500 generated pairs', () => {
    const values = randomInts(1_000, 1_000_000, 1_000);
    for (let index = 0; index + 1 < values.length; index += 2) {
      const a = Money(values[index] ?? 0);
      const b = Money(values[index + 1] ?? 0);
      expect(a.add(b).subtract(b).equals(a)).toBe(true);
    }
  });
});

describe('Money.multiply', () => {
  it('Money(100) × Qty(3333) rounds half-up ONCE to 333 poisha', () => {
    // 100 × 3.333 = 333.3 poisha exactly, which rounds to 333.
    expect(Money(100).multiply(Qty(3333)).minor).toBe(333);
  });

  it('rounds a tie away from zero, symmetrically', () => {
    // 100 × 2.5 minor-units = 250.0; 1 × 0.5 = 0.5 → 1.
    expect(Money(100).multiply(Qty(2500)).minor).toBe(250);
    expect(Money(1).multiply(Qty(500)).minor).toBe(1);
    expect(Money(-1).multiply(Qty(500)).minor).toBe(-1);
    expect(Money(1).multiply(Qty(499)).minor).toBe(0);
  });

  it('does not lose precision on a large product', () => {
    // ৳999,999.99 × 1,234.567 = ৳1,234,566,987.654330 exactly,
    // = 123,456,698,765.433 poisha, rounded once to 123,456,698,765.
    expect(Money(99999999).multiply(Qty(1234567)).minor).toBe(123456698765);
  });

  it('refuses to return a product outside the safe integer range', () => {
    const huge = Money(Number.MAX_SAFE_INTEGER);
    expect(() => huge.multiply(Qty(Number.MAX_SAFE_INTEGER))).toThrow(RangeError);
  });

  it('multiplying by zero quantity gives zero', () => {
    expect(Money(125075).multiply(Qty(0)).isZero()).toBe(true);
  });
});

describe('Money.allocate — largest remainder (SRS 3.3)', () => {
  const minors = (parts: readonly Money[]): number[] => parts.map((part) => part.minor);

  it('allocate(1000, [1,1,1]) -> [334, 333, 333]', () => {
    const parts = Money(1000).allocate([1, 1, 1]);
    expect(minors(parts)).toEqual([334, 333, 333]);
    expect(minors(parts).reduce((sum, part) => sum + part, 0)).toBe(1000);
  });

  it('allocate(1, [1,1,1]) -> [1, 0, 0]', () => {
    const parts = Money(1).allocate([1, 1, 1]);
    expect(minors(parts)).toEqual([1, 0, 0]);
    expect(minors(parts).reduce((sum, part) => sum + part, 0)).toBe(1);
  });

  it('allocate(100, [3,1]) -> [75, 25]', () => {
    const parts = Money(100).allocate([3, 1]);
    expect(minors(parts)).toEqual([75, 25]);
    expect(minors(parts).reduce((sum, part) => sum + part, 0)).toBe(100);
  });

  it('allocate(10, [1,1,1,1,1,1,1]) -> [2,2,2,1,1,1,1]', () => {
    const parts = Money(10).allocate([1, 1, 1, 1, 1, 1, 1]);
    expect(minors(parts)).toEqual([2, 2, 2, 1, 1, 1, 1]);
    expect(minors(parts).reduce((sum, part) => sum + part, 0)).toBe(10);
  });

  it('is deterministic — 100 identical calls give identical output', () => {
    const expected = minors(Money(1000).allocate([1, 1, 1]));
    for (let run = 0; run < 100; run += 1) {
      expect(minors(Money(1000).allocate([1, 1, 1]))).toEqual(expected);
    }
  });

  it('parts sum EXACTLY to the whole for 500 generated cases', () => {
    const totals = randomInts(2_001, 5_000_000, 500).map((value) => value - 2_500_000);
    const weightPool = randomInts(9_001, 1_000, 2_000);

    totals.forEach((total, caseIndex) => {
      const count = 1 + (caseIndex % 9);
      const drawn = Array.from(
        { length: count },
        (_, i) => weightPool[(caseIndex * 9 + i) % weightPool.length] ?? 1,
      );
      // All-zero weights are not a legal split; keep the case by making line 0 weigh 1.
      const weights = drawn.some((weight) => weight > 0) ? drawn : [1, ...drawn.slice(1)];

      const parts = Money(total).allocate(weights);
      expect(parts.reduce((sum, part) => sum + part.minor, 0)).toBe(total);
      expect(parts).toHaveLength(count);
    });
  });

  it('mirrors a negative total exactly', () => {
    expect(minors(Money(-1000).allocate([1, 1, 1]))).toEqual([-334, -333, -333]);
    expect(minors(Money(-1).allocate([1, 1, 1]))).toEqual([-1, 0, 0]);
  });

  it('rejects weights that cannot define a split', () => {
    expect(() => Money(100).allocate([])).toThrow(RangeError);
    expect(() => Money(100).allocate([0, 0])).toThrow(RangeError);
    expect(() => Money(100).allocate([-1, 2])).toThrow(RangeError);
    expect(() => Money(100).allocate([1.5, 2])).toThrow(TypeError);
  });
});

describe('Money comparison and predicates', () => {
  it('compare returns -1, 0, 1', () => {
    expect(Money(100).compare(Money(200))).toBe(-1);
    expect(Money(200).compare(Money(100))).toBe(1);
    expect(Money(100).compare(Money(100))).toBe(0);
  });

  it('equals compares by minor value', () => {
    expect(Money(100).equals(Money(100))).toBe(true);
    expect(Money(100).equals(Money(101))).toBe(false);
  });

  it('isZero and isNegative', () => {
    expect(Money(0).isZero()).toBe(true);
    expect(Money(1).isZero()).toBe(false);
    expect(Money(-1).isNegative()).toBe(true);
    expect(Money(0).isNegative()).toBe(false);
    expect(Money(1).isNegative()).toBe(false);
  });
});
