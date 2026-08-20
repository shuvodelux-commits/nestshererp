import { describe, expect, it } from 'vitest';

import {
  rejectEntry,
  rejectStockAdjustment,
  STOCK_ADJUSTMENT_REASONS,
  stockAdjustmentPosting,
} from '../src/index';
import type { StockAdjustmentDraft } from '../src/index';

const draft = (over: Partial<StockAdjustmentDraft> = {}): StockAdjustmentDraft => ({
  qtyDelta: 5_000,
  reason: 'DAMAGE',
  note: null,
  ...over,
});

describe('rejectStockAdjustment', () => {
  it('accepts a signed quantity with a self-describing reason', () => {
    expect(rejectStockAdjustment(draft())).toBeNull();
    expect(rejectStockAdjustment(draft({ qtyDelta: -2_000, reason: 'RECOUNT' }))).toBeNull();
    expect(rejectStockAdjustment(draft({ reason: 'THEFT_LOSS' }))).toBeNull();
  });

  // Zero would post a document and an entry that moved nothing, and afterwards
  // it is indistinguishable from a real correction worth nothing.
  it('refuses a zero quantity', () => {
    expect(rejectStockAdjustment(draft({ qtyDelta: 0 }))).toBe('QUANTITY_IS_ZERO');
  });

  it('refuses a fractional quantity that is not scaled minor units', () => {
    expect(rejectStockAdjustment(draft({ qtyDelta: 1.5 }))).toBe('QUANTITY_NOT_INTEGER_MINOR');
  });

  it('refuses a reason outside the closed list, so the damage report can group', () => {
    const rogue = draft({ reason: 'SHRINKAGE' as never });
    expect(rejectStockAdjustment(rogue)).toBe('UNKNOWN_REASON');
  });

  it('demands a note for OTHER and nothing else', () => {
    expect(rejectStockAdjustment(draft({ reason: 'OTHER', note: null }))).toBe(
      'NOTE_REQUIRED_FOR_OTHER',
    );
    expect(rejectStockAdjustment(draft({ reason: 'OTHER', note: '   ' }))).toBe(
      'NOTE_REQUIRED_FOR_OTHER',
    );
    expect(rejectStockAdjustment(draft({ reason: 'OTHER', note: 'Sent as a sample' }))).toBeNull();
    expect(rejectStockAdjustment(draft({ reason: 'DAMAGE', note: null }))).toBeNull();
  });

  it('keeps the reason list closed', () => {
    expect([...STOCK_ADJUSTMENT_REASONS]).toStrictEqual([
      'DAMAGE',
      'RECOUNT',
      'THEFT_LOSS',
      'OTHER',
    ]);
  });
});

describe('stockAdjustmentPosting', () => {
  // 5 units found at ৳68.00 each → INVENTORY rises by ৳340.00, and the gain is
  // credited to STOCK_ADJUSTMENT rather than invented as income.
  it('debits INVENTORY and credits STOCK_ADJUSTMENT when stock is added', () => {
    const posting = stockAdjustmentPosting(5_000, 34_000);

    expect(posting.direction).toBe('IN');
    expect(posting.qty).toBe(5_000);
    expect(posting.valueMinor).toBe(34_000);
    expect(posting.journal.lines).toStrictEqual([
      { account: 'INVENTORY', amountMinor: 34_000, partyId: null },
      { account: 'STOCK_ADJUSTMENT', amountMinor: -34_000, partyId: null },
    ]);
    expect(rejectEntry(posting.journal)).toBeNull();
  });

  it('reverses the two lines when stock is removed', () => {
    const posting = stockAdjustmentPosting(-2_000, 13_600);

    expect(posting.direction).toBe('OUT');
    // The sign lives on the direction, exactly as `stock_movements` stores it.
    expect(posting.qty).toBe(2_000);
    expect(posting.journal.lines).toStrictEqual([
      { account: 'INVENTORY', amountMinor: -13_600, partyId: null },
      { account: 'STOCK_ADJUSTMENT', amountMinor: 13_600, partyId: null },
    ]);
    expect(rejectEntry(posting.journal)).toBeNull();
  });

  it('always balances (INV-01), in both directions', () => {
    for (const qty of [1, 5_000, -1, -750_000]) {
      const posting = stockAdjustmentPosting(qty, 9_999);
      const total = posting.journal.lines.reduce((sum, line) => sum + line.amountMinor, 0);
      expect(total).toBe(0);
    }
  });

  it('refuses a zero-value adjustment rather than posting an empty entry', () => {
    // A zero-cost product has nothing to post, and an entry with no lines fails
    // `rejectEntry` and INV-09. `openingStockPosting` refuses the same case.
    expect(() => stockAdjustmentPosting(5_000, 0)).toThrow(RangeError);
  });

  it('refuses a negative value — the direction carries the sign, not the money', () => {
    expect(() => stockAdjustmentPosting(-5_000, -34_000)).toThrow(RangeError);
  });

  it('refuses a zero quantity', () => {
    expect(() => stockAdjustmentPosting(0, 34_000)).toThrow(RangeError);
  });
});
