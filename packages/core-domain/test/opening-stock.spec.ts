import { describe, expect, it } from 'vitest';

import { openingStockPosting } from '../src';

describe('openingStockPosting', () => {
  it('posts 10 units at ৳100 to stock and opening equity exactly', () => {
    const posting = openingStockPosting(10_000, 1_000_000);
    expect(posting.valueMinor).toBe(100_000);
    expect(posting.journal.lines).toEqual([
      { account: 'INVENTORY', amountMinor: 100_000, partyId: null },
      { account: 'OPENING_EQUITY', amountMinor: -100_000, partyId: null },
    ]);
  });

  it('rounds once from quantity and scale-4 unit cost', () => {
    expect(openingStockPosting(1, 500_000).valueMinor).toBe(5);
  });

  it('refuses invalid or financially zero openings', () => {
    expect(() => openingStockPosting(0, 1_000_000)).toThrow(RangeError);
    expect(() => openingStockPosting(1_000, -1)).toThrow(RangeError);
    expect(() => openingStockPosting(1, 1)).toThrow(RangeError);
  });
});
