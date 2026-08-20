import { describe, expect, it } from 'vitest';

import {
  allocateLots,
  averageAfterReceipt,
  costIssue,
  stockValueMinor,
  unitCostFromMoneyMinor,
} from '../src';

const LOTS = [
  { id: 'LOT-A', qtyRemaining: 10_000, unitCost: 1_000_000, businessDate: '2026-08-01', createdAt: '2026-08-01T04:00:00.000Z', expiryDate: '2027-01-01' },
  { id: 'LOT-B', qtyRemaining: 10_000, unitCost: 1_200_000, businessDate: '2026-08-02', createdAt: '2026-08-02T04:00:00.000Z', expiryDate: '2026-12-01' },
  { id: 'LOT-C', qtyRemaining: 5_000, unitCost: 900_000, businessDate: '2026-08-03', createdAt: '2026-08-03T04:00:00.000Z', expiryDate: '2027-02-01' },
] as const;

describe('inventory costing kernel', () => {
  it('reproduces the binding FIFO scenario exactly', () => {
    const result = costIssue('FIFO', LOTS.slice(0, 2), 15_000, 0, 0, false);
    expect(result.allocations.map(({ lotId, qty, valueMinor }) => ({ lotId, qty, valueMinor }))).toEqual([
      { lotId: 'LOT-A', qty: 10_000, valueMinor: 100_000 },
      { lotId: 'LOT-B', qty: 5_000, valueMinor: 60_000 },
    ]);
    expect(result.valueMinor).toBe(160_000);
    expect(stockValueMinor(5_000, 1_200_000)).toBe(60_000);
    expect(result.provisional).toBe(false);
  });

  it('reproduces the binding moving-average scenario exactly', () => {
    const first = averageAfterReceipt(0, 0, 10_000, 1_000_000);
    const second = averageAfterReceipt(first.qtyOnHand, first.avgUnitCost, 10_000, 1_200_000);
    expect(second).toEqual({ qtyOnHand: 20_000, avgUnitCost: 1_100_000, inventoryValueMinor: 220_000 });
    const issue = costIssue('AVERAGE', LOTS.slice(0, 2), 15_000, second.avgUnitCost, 0, false);
    expect(issue.valueMinor).toBe(165_000);
    expect(stockValueMinor(5_000, second.avgUnitCost)).toBe(55_000);
  });

  it('uses FEFO before receipt date and then stable date/id ordering', () => {
    const selected = allocateLots(LOTS, 15_000, true);
    expect(selected.allocations.map((row) => [row.lotId, row.qty])).toEqual([
      ['LOT-B', 10_000],
      ['LOT-A', 5_000],
    ]);
  });

  it('marks a shortage provisional and prices only the shortage at fallback cost under FIFO', () => {
    const result = costIssue('FIFO', LOTS.slice(0, 1), 12_000, 0, 800_000, false);
    expect(result.shortageQty).toBe(2_000);
    expect(result.valueMinor).toBe(116_000);
    expect(result.provisional).toBe(true);
  });

  it('converts a product price to scale-4 cost without floating point', () => {
    expect(unitCostFromMoneyMinor(10_005)).toBe(1_000_500);
  });

  it('refuses an undated lot when expiry tracking governs selection', () => {
    expect(() => allocateLots([{ ...LOTS[0], expiryDate: null }], 1_000, true)).toThrow(
      'missing its expiry date',
    );
  });
});
