import { describe, expect, it } from 'vitest';

import { allocateLargestRemainder, divideRoundHalfUp, formatScaled } from '../src/scaled';

describe('divideRoundHalfUp (D-31)', () => {
  it('rounds a tie away from zero, so round(-x) === -round(x)', () => {
    expect(divideRoundHalfUp(5n, 10n)).toBe(1n);
    expect(divideRoundHalfUp(-5n, 10n)).toBe(-1n);
    expect(divideRoundHalfUp(15n, 10n)).toBe(2n);
    expect(divideRoundHalfUp(-15n, 10n)).toBe(-2n);
  });

  it('rounds below and above a tie', () => {
    expect(divideRoundHalfUp(4n, 10n)).toBe(0n);
    expect(divideRoundHalfUp(6n, 10n)).toBe(1n);
    expect(divideRoundHalfUp(-4n, 10n)).toBe(0n);
    expect(divideRoundHalfUp(-6n, 10n)).toBe(-1n);
  });

  it('handles a negative divisor', () => {
    expect(divideRoundHalfUp(5n, -10n)).toBe(-1n);
    expect(divideRoundHalfUp(-5n, -10n)).toBe(1n);
  });

  it('refuses to divide by zero', () => {
    expect(() => divideRoundHalfUp(1n, 0n)).toThrow(RangeError);
  });
});

describe('allocateLargestRemainder', () => {
  it('breaks a remainder tie by line index ascending', () => {
    // Equal weights means equal remainders; the leftover must go to the first lines.
    expect(allocateLargestRemainder(5, [1, 1, 1, 1], 'test')).toEqual([2, 1, 1, 1]);
  });

  it('gives the leftover to the largest remainder first', () => {
    // Weights 1:2 of 4 → floors 1 and 2, remainders 1 and 2 → the leftover goes to index 1.
    expect(allocateLargestRemainder(4, [1, 2], 'test')).toEqual([1, 3]);
  });

  it('allocates zero across any weights', () => {
    expect(allocateLargestRemainder(0, [1, 2, 3], 'test')).toEqual([0, 0, 0]);
  });

  it('gives a zero weight a zero share', () => {
    expect(allocateLargestRemainder(100, [1, 0], 'test')).toEqual([100, 0]);
  });

  it('rejects inputs that cannot define a split', () => {
    expect(() => allocateLargestRemainder(100, [], 'test')).toThrow(RangeError);
    expect(() => allocateLargestRemainder(100, [0, 0], 'test')).toThrow(RangeError);
    expect(() => allocateLargestRemainder(100, [-1, 1], 'test')).toThrow(RangeError);
    expect(() => allocateLargestRemainder(100, [1.5], 'test')).toThrow(TypeError);
  });
});

describe('formatScaled', () => {
  it('groups thousands and pads the fraction', () => {
    expect(formatScaled(125075, 2)).toBe('1,250.75');
    expect(formatScaled(5, 3)).toBe('0.005');
    expect(formatScaled(1000000, 0)).toBe('1,000,000');
    expect(formatScaled(-1, 4)).toBe('-0.0001');
  });
});
