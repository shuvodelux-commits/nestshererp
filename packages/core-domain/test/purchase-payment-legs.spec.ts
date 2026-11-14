import { describe, expect, it } from 'vitest';

import { fixedAccount, parameterisedAccount } from '../src/accounting/account';
import { rejectEntry } from '../src/accounting/journal-entry';
import {
  purchaseCosts,
  purchasePosting,
  purchasePostingWithLegs,
} from '../src/purchasing/purchase';
import type { PurchasePostingLeg } from '../src/purchasing/purchase';

/**
 * MOD-008 D06A #224: RED-first domain-only atomic payment-leg posting.
 * This test is deliberately pure: it cannot activate POST /purchases or
 * change a retained shop database. Source storage/account locking remain
 * behind separately coordinated D06B/C migrations and API gates.
 */
const supplierPartyId = '01ARZ3NDEKTSV4RRFFQ69G5FAA';
const cash = parameterisedAccount('CASH', 'DRAWER_01');
const bank = parameterisedAccount('BANK', 'BANK_01');
const mfs = parameterisedAccount('BANK', 'BKASH_01');

const costs = () => purchaseCosts({
  lines: [{ productId: 'PRODUCT_01', qty: 1000, unitPriceMinor: 9000 }],
  discountMinor: 0,
  extraCostMinor: 0,
  paidMinor: 0,
});

const leg = (account: PurchasePostingLeg['account'], amountMinor: number): PurchasePostingLeg =>
  ({ account, amountMinor });
const posting = (paymentLegs: readonly PurchasePostingLeg[]) =>
  purchasePostingWithLegs(costs(), { supplierPartyId, paymentLegs });

describe('MOD-008 D06A one-journal initial purchase payment legs', () => {
  it('keeps an unpaid bill as a single inventory debit and supplier AP credit', () => {
    const entry = posting([]);
    expect(entry.lines).toEqual([
      { account: 'INVENTORY', amountMinor: 9000, partyId: null },
      { account: 'AP', amountMinor: -9000, partyId: supplierPartyId },
    ]);
    expect(rejectEntry(entry)).toBeNull();
  });

  it('credits both cash and bank from one purchase and leaves only the unpaid AP', () => {
    const entry = posting([leg(cash, 2000), leg(bank, 1000)]);
    expect(entry.lines).toEqual([
      { account: 'INVENTORY', amountMinor: 9000, partyId: null },
      { account: cash, amountMinor: -2000, partyId: null },
      { account: bank, amountMinor: -1000, partyId: null },
      { account: 'AP', amountMinor: -6000, partyId: supplierPartyId },
    ]);
    expect(rejectEntry(entry)).toBeNull();
    expect(entry.lines.reduce((sum, line) => sum + line.amountMinor, 0)).toBe(0);
  });

  it('omits the AP line when several accounts pay the entire purchase', () => {
    const entry = posting([leg(cash, 4000), leg(mfs, 5000)]);
    expect(entry.lines).toHaveLength(3);
    expect(entry.lines.some(line => line.account === fixedAccount('AP'))).toBe(false);
    expect(rejectEntry(entry)).toBeNull();
  });

  it('preserves two distinct source credits when the same account appears twice', () => {
    const entry = posting([leg(cash, 2000), leg(cash, 3000)]);
    expect(entry.lines.filter(line => line.account === cash).map(line => line.amountMinor)).toEqual([-2000, -3000]);
    expect(entry.lines.at(-1)).toEqual({ account: 'AP', amountMinor: -4000, partyId: supplierPartyId });
    expect(rejectEntry(entry)).toBeNull();
  });

  it('supports exactly ten positive legs while keeping a balanced single journal', () => {
    const entry = posting(Array.from({ length: 10 }, (_, i) =>
      leg(i % 2 === 0 ? cash : bank, 1)));
    expect(entry.lines).toHaveLength(12);
    expect(entry.lines.at(-1)?.amountMinor).toBe(-8990);
    expect(rejectEntry(entry)).toBeNull();
  });

  it('rejects an eleventh initial payment leg', () => {
    expect(() => posting(Array.from({ length: 11 }, () => leg(cash, 1)))).toThrow(RangeError);
  });

  it.each([0, -1, 0.25, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects an invalid or non-integer amount %s before constructing journal entries', amountMinor => {
      expect(() => posting([leg(cash, amountMinor)])).toThrow(RangeError);
    },
  );

  it('rejects overpayment at the one-poisha boundary', () => {
    expect(() => posting([leg(cash, 9001)])).toThrow(RangeError);
  });

  it('rejects a fixed AP, inventory or loan account as a source of real payment', () => {
    for (const account of [
      fixedAccount('AP'), fixedAccount('INVENTORY'), parameterisedAccount('LOAN', 'LENDER_01'),
    ]) {
      expect(() => posting([leg(account, 1000)])).toThrow(RangeError);
    }
  });

  it('preserves a signed inventory valuation rounding residual instead of changing stock cost', () => {
    const value = { ...costs(), inventoryValueMinor: 8999, roundingMinor: 1 };
    const entry = purchasePostingWithLegs(value, {
      supplierPartyId,
      paymentLegs: [leg(cash, 2000), leg(bank, 1000)],
    });
    expect(entry.lines).toEqual([
      { account: 'INVENTORY', amountMinor: 8999, partyId: null },
      { account: 'ROUNDING', amountMinor: 1, partyId: null },
      { account: cash, amountMinor: -2000, partyId: null },
      { account: bank, amountMinor: -1000, partyId: null },
      { account: 'AP', amountMinor: -6000, partyId: supplierPartyId },
    ]);
    expect(rejectEntry(entry)).toBeNull();
  });

  it('has the identical journal as the legacy one-account purchase posting', () => {
    const legacy = purchasePosting(costs(), {
      supplierPartyId,
      paidAccount: cash,
      paidMinor: 3000,
    });
    expect(posting([leg(cash, 3000)])).toEqual(legacy);
  });
});
