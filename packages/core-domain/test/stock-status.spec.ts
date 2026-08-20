import { describe, expect, it } from 'vitest';

import { stockStatus } from '../src';

describe('stockStatus', () => {
  it('keeps negative, zero, low and in-stock states distinct', () => {
    expect(stockStatus(-1, 5_000)).toBe('NEGATIVE_STOCK');
    expect(stockStatus(0, 5_000)).toBe('ZERO_STOCK');
    expect(stockStatus(5_000, 5_000)).toBe('LOW_STOCK');
    expect(stockStatus(5_001, 5_000)).toBe('IN_STOCK');
  });
});
