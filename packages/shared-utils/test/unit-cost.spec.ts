import { describe, expect, it } from 'vitest';

import { UnitCost } from '../src/unit-cost';

describe('UnitCost', () => {
  it('carries four decimals (SRS 3.3)', () => {
    expect(UnitCost(123456).format()).toBe('12.3456');
    expect(UnitCost(1).format()).toBe('0.0001');
    expect(UnitCost(0).format()).toBe('0.0000');
    expect(UnitCost(-123456).format()).toBe('-12.3456');
    expect(UnitCost(12345678901).format()).toBe('1,234,567.8901');
  });

  it('rejects a float', () => {
    expect(() => UnitCost(12.5)).toThrow(TypeError);
  });

  it('adds and subtracts exactly', () => {
    expect(UnitCost(123456).add(UnitCost(1)).raw).toBe(123457);
    expect(UnitCost(123456).subtract(UnitCost(123457)).raw).toBe(-1);
  });

  it('compares and reports sign', () => {
    expect(UnitCost(1).compare(UnitCost(2))).toBe(-1);
    expect(UnitCost(2).compare(UnitCost(1))).toBe(1);
    expect(UnitCost(2).compare(UnitCost(2))).toBe(0);
    expect(UnitCost(2).equals(UnitCost(2))).toBe(true);
    expect(UnitCost(2).equals(UnitCost(3))).toBe(false);
    expect(UnitCost(0).isZero()).toBe(true);
    expect(UnitCost(1).isZero()).toBe(false);
    expect(UnitCost(-1).isNegative()).toBe(true);
    expect(UnitCost(1).isNegative()).toBe(false);
  });
});
