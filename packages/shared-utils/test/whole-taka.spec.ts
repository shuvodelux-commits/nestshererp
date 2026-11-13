import { describe, expect, it } from 'vitest';

import {
  isWholeTakaMinor,
  remainingWholeTakaReturnMinor,
  roundWholeTakaMinor,
} from '../src/money';

describe('whole-taka boundary — pure and not yet wired into posting', () => {
  it('rounds positive poisha to the nearest full taka, half up', () => {
    expect(roundWholeTakaMinor(12_549)).toBe(12_500);
    expect(roundWholeTakaMinor(12_550)).toBe(12_600);
    expect(roundWholeTakaMinor(99_990)).toBe(100_000);
    expect(roundWholeTakaMinor(49)).toBe(0);
    expect(roundWholeTakaMinor(50)).toBe(100);
  });

  it('is symmetric for signed reversals and never accepts unsafe money', () => {
    expect(roundWholeTakaMinor(-12_549)).toBe(-12_500);
    expect(roundWholeTakaMinor(-12_550)).toBe(-12_600);
    expect(() => roundWholeTakaMinor(1.5)).toThrow(TypeError);
    expect(() => roundWholeTakaMinor(Number.MAX_SAFE_INTEGER)).toThrow(RangeError);
    expect(isWholeTakaMinor(100)).toBe(true);
    expect(isWholeTakaMinor(-200)).toBe(true);
    expect(isWholeTakaMinor(125)).toBe(false);
    expect(isWholeTakaMinor(Number.NaN)).toBe(false);
  });

  it('returns five quantities worth ৳3 as ৳1, ৳0, ৳1, ৳0, ৳1', () => {
    const credits: number[] = [];
    let posted = 0;
    for (let n = 0; n < 5; n++) {
      const credit = remainingWholeTakaReturnMinor(300, 5000, n * 1000, 1000, posted);
      credits.push(credit);
      posted += credit;
    }
    expect(credits).toEqual([100, 0, 100, 0, 100]);
    expect(posted).toBe(300);
  });

  it('subtracts actual posted credit and prevents re-crediting a partial source', () => {
    expect(remainingWholeTakaReturnMinor(300, 5000, 4000, 1000, 200)).toBe(100);
    expect(remainingWholeTakaReturnMinor(300, 5000, 4000, 1000, 300)).toBe(0);
    expect(remainingWholeTakaReturnMinor(0, 5000, 0, 1000, 0)).toBe(0);
    expect(() => remainingWholeTakaReturnMinor(300, 5000, 4000, 2000, 200)).toThrow(RangeError);
    expect(() => remainingWholeTakaReturnMinor(300, 5000, 0, 1000, 400)).toThrow(RangeError);
  });

  it('rejects zero quantities and negative or unsafe source amounts', () => {
    expect(() => remainingWholeTakaReturnMinor(300, 0, 0, 1000, 0)).toThrow(RangeError);
    expect(() => remainingWholeTakaReturnMinor(300, 5000, 0, 0, 0)).toThrow(RangeError);
    expect(() => remainingWholeTakaReturnMinor(300, 5000, -1000, 1000, 0)).toThrow(RangeError);
    expect(() => remainingWholeTakaReturnMinor(300, 5000, 0, 1000, -100)).toThrow(RangeError);
    expect(() => remainingWholeTakaReturnMinor(Number.NaN, 5000, 0, 1000, 0)).toThrow(TypeError);
  });

  it('does not silently reinterpret legacy fractional source values as whole taka', () => {
    expect(() => remainingWholeTakaReturnMinor(349, 5000, 0, 1000, 0)).toThrow(RangeError);
    expect(() => remainingWholeTakaReturnMinor(300, 5000, 1000, 1000, 50)).toThrow(RangeError);
  });
});
