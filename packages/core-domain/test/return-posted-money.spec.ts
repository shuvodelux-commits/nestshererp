import { describe, expect, it } from 'vitest';

import {
  purchaseReturnPosting, purchaseReturnTotals, rejectPurchaseReturn,
  rejectSalesReturn, salesReturnPosting, salesReturnTotals,
} from '../src/index';
import type { ReturnableBillLine, ReturnableLine } from '../src/index';

const sale = (
  overrides: Partial<ReturnableLine> = {},
): ReturnableLine => ({
  saleLineId: 'SALE-LINE-A',
  productId: 'PRODUCT-A',
  qtySold: 5_000,
  qtyReturned: 0,
  valueReturnedMinor: 0,
  costReturnedMinor: 0,
  netAmountMinor: 3,
  costMinor: 0,
  ...overrides,
});

const bill = (
  overrides: Partial<ReturnableBillLine> = {},
): ReturnableBillLine => ({
  purchaseLineId: 'BILL-LINE-A',
  productId: 'PRODUCT-A',
  lotId: 'LOT-A',
  qtyReceived: 5_000,
  qtyReturned: 0,
  valueReturnedMinor: 0,
  costReturnedMinor: 0,
  qtyRemainingInLot: 5_000,
  billedNetMinor: 3,
  actualUnitCost: 0,
  ...overrides,
});

describe('source-booked sales return reconciliation (P0 #36)', () => {
  it('never refunds more than a 3-poisha source across five separate one-Pcs returns', () => {
    let qtyReturned = 0;
    let valueReturnedMinor = 0;
    const fragments: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const totals = salesReturnTotals(
        { lines: [{ saleLineId: 'SALE-LINE-A', qty: 1_000 }], refundMinor: 0 },
        [sale({ qtyReturned, valueReturnedMinor })],
      );
      fragments.push(totals.returnValueMinor);
      qtyReturned += 1_000;
      valueReturnedMinor += totals.returnValueMinor;
      expect(valueReturnedMinor).toBeLessThanOrEqual(3);
    }
    expect(fragments).toEqual([1, 0, 1, 0, 1]);
    expect(valueReturnedMinor).toBe(3);
  });

  it('keeps discounted money and original cost independently conserved', () => {
    const first = salesReturnTotals(
      { lines: [{ saleLineId: 'SALE-LINE-A', qty: 1_000 }], refundMinor: 0 },
      [sale({ costMinor: 3 })],
    );
    const second = salesReturnTotals(
      { lines: [{ saleLineId: 'SALE-LINE-A', qty: 1_000 }], refundMinor: 0 },
      [sale({ costMinor: 3, qtyReturned: 1_000,
        valueReturnedMinor: first.returnValueMinor,
        costReturnedMinor: first.returnCostMinor })],
    );
    expect([first.returnValueMinor, second.returnValueMinor]).toEqual([1, 0]);
    expect([first.returnCostMinor, second.returnCostMinor]).toEqual([1, 0]);
    expect(second.refundMinor).toBe(0);
  });

  it('allows no-value returns with cost reversal, without a fabricated Sales posting', () => {
    const totals = salesReturnTotals(
      { lines: [{ saleLineId: 'SALE-LINE-A', qty: 1_000 }], refundMinor: 0 },
      [sale({ netAmountMinor: 0, costMinor: 5 })],
    );
    expect(totals.returnValueMinor).toBe(0);
    expect(totals.returnCostMinor).toBe(1);
    const journal = salesReturnPosting(totals, {
      partyId: 'PARTY-A', refundAccount: null, settledMinor: 0,
    });
    expect(journal.lines.map((l) => [l.account, l.amountMinor])).toEqual([
      ['INVENTORY', 1], ['COGS', -1],
    ]);
  });

  it('accepts truly zero-valued and zero-cost stock without any GL entry', () => {
    const totals = salesReturnTotals(
      { lines: [{ saleLineId: 'SALE-LINE-A', qty: 1_000 }], refundMinor: 0 },
      [sale({ netAmountMinor: 0 })],
    );
    expect(salesReturnPosting(totals, {
      partyId: 'PARTY-A', refundAccount: null, settledMinor: 0,
    }).lines).toEqual([]);
    expect(totals.lines[0]?.qty).toBe(1_000);
  });

  it('refuses historic over-credit, duplicate source lines and additional refund money', () => {
    const draft = { lines: [{ saleLineId: 'SALE-LINE-A', qty: 1_000 }], refundMinor: 0 };
    expect(rejectSalesReturn(draft, [sale({
      qtyReturned: 3_000, valueReturnedMinor: 4,
    })])).toBe('RETURN_SOURCE_HISTORY_INVALID');
    expect(rejectSalesReturn({
      lines: [...draft.lines, ...draft.lines], refundMinor: 0,
    }, [sale()])).toBe('RETURN_DUPLICATE_LINE');
    expect(rejectSalesReturn({ ...draft, refundMinor: 2 }, [sale()])).toBe('REFUND_EXCEEDS_RETURN');
  });

  it('reconciles a 10000-poisha source when thirds are returned across separate documents', () => {
    let state = sale({ qtySold: 3_000, netAmountMinor: 10_000 });
    const values: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const totals = salesReturnTotals(
        { lines: [{ saleLineId: 'SALE-LINE-A', qty: 1_000 }], refundMinor: 0 },
        [state],
      );
      values.push(totals.returnValueMinor);
      state = { ...state, qtyReturned: state.qtyReturned + 1_000,
        valueReturnedMinor: state.valueReturnedMinor + totals.returnValueMinor };
    }
    expect(values).toEqual([3_333, 3_334, 3_333]);
    expect(state.valueReturnedMinor).toBe(10_000);
  });
});

describe('source-booked supplier return reconciliation (P0 #36)', () => {
  it('preserves a 3-poisha supplier credit across five separate one-Pcs stock returns', () => {
    let state = bill();
    const values: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const totals = purchaseReturnTotals({
        lines: [{ purchaseLineId: 'BILL-LINE-A', qty: 1_000 }], receivedMinor: 0,
      }, [state]);
      values.push(totals.returnValueMinor);
      state = { ...state, qtyReturned: state.qtyReturned + 1_000,
        qtyRemainingInLot: state.qtyRemainingInLot - 1_000,
        valueReturnedMinor: state.valueReturnedMinor + totals.returnValueMinor };
    }
    expect(values).toEqual([1, 0, 1, 0, 1]);
    expect(state.valueReturnedMinor).toBe(3);
    expect(state.qtyReturned).toBe(5_000);
  });

  it('posts inventory decrease and STOCK_ADJUSTMENT, but no supplier credit for 0-poisha returns', () => {
    const totals = purchaseReturnTotals({
      lines: [{ purchaseLineId: 'BILL-LINE-A', qty: 1_000 }], receivedMinor: 0,
    }, [bill({ billedNetMinor: 0, actualUnitCost: 200 })]);
    expect(totals.returnValueMinor).toBe(0);
    expect(totals.inventoryMinor).toBe(2);
    expect(purchaseReturnPosting(totals, {
      supplierPartyId: 'SUPPLIER-A', receiptAccount: null, settledMinor: 0,
    }).lines.map((l) => [l.account, l.amountMinor])).toEqual([
      ['STOCK_ADJUSTMENT', 2], ['INVENTORY', -2],
    ]);
  });

  it('posts quantity-only return with zero valuation without creating a fake journal', () => {
    const totals = purchaseReturnTotals({
      lines: [{ purchaseLineId: 'BILL-LINE-A', qty: 1_000 }], receivedMinor: 0,
    }, [bill({ billedNetMinor: 0 })]);
    expect(purchaseReturnPosting(totals, {
      supplierPartyId: 'SUPPLIER-A', receiptAccount: null, settledMinor: 0,
    }).lines).toEqual([]);
    expect(totals.lines[0]?.qty).toBe(1_000);
  });

  it('rejects previous over-credit, duplicate bill lines and insufficient lot stock', () => {
    const one = { lines: [{ purchaseLineId: 'BILL-LINE-A', qty: 1_000 }],
      receivedMinor: 0 };
    expect(rejectPurchaseReturn(one, [bill({
      qtyReturned: 2_000, valueReturnedMinor: 4,
    })])).toBe('RETURN_SOURCE_HISTORY_INVALID');
    expect(rejectPurchaseReturn({
      lines: [...one.lines, ...one.lines], receivedMinor: 0,
    }, [bill()])).toBe('RETURN_DUPLICATE_LINE');
    expect(rejectPurchaseReturn(one, [bill({ qtyRemainingInLot: 0 })])).toBe('RETURN_EXCEEDS_STOCK');
  });

  it('balances the rare case of an original billed credit above the tiny rounded stock cost', () => {
    const totals = purchaseReturnTotals({
      lines: [{ purchaseLineId: 'BILL-LINE-A', qty: 1_000 }], receivedMinor: 0,
    }, [bill({ billedNetMinor: 1, actualUnitCost: 0 })]);
    expect(totals.returnValueMinor).toBe(0); // 1 poisha / 5 pieces -> first unit rounds to 0.
    const later = purchaseReturnTotals({
      lines: [{ purchaseLineId: 'BILL-LINE-A', qty: 1_000 }], receivedMinor: 0,
    }, [bill({ billedNetMinor: 1, qtyReturned: 2_000,
      qtyRemainingInLot: 3_000, valueReturnedMinor: 0 })]);
    expect(later.returnValueMinor).toBe(1);
    expect(later.inventoryMinor).toBe(0);
    expect(later.adjustmentMinor).toBe(-1);
    const entry = purchaseReturnPosting(later, {
      supplierPartyId: 'SUPPLIER-A', receiptAccount: null, settledMinor: 0,
    });
    expect(entry.lines.map((l) => [l.account, l.amountMinor])).toEqual([
      ['SUPPLIER_ADVANCE', 1], ['STOCK_ADJUSTMENT', -1],
    ]);
  });
});
