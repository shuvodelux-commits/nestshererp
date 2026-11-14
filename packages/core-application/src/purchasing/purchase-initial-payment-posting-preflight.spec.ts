import { beforeEach, describe, expect, it, vi } from 'vitest';

import { purchaseCosts } from '@sher/core-domain';
import type { AccountCode } from '@sher/core-domain';
import { resolvePaymentAccount } from './payment-account';
import type { PaymentAccountDeps } from './payment-account';
import type { TenantContext } from '../ports/tenant-context';
import type { Tx } from '../ports/unit-of-work';

import { preparePurchaseInitialPaymentPosting } from './purchase-initial-payment-posting-preflight';

vi.mock('./payment-account', () => ({ resolvePaymentAccount: vi.fn() }));

const ID_A = '01ARZ3NDEKTSV4RRFFQ69G5FAA';
const ID_B = '01ARZ3NDEKTSV4RRFFQ69G5FAB';
const SUPPLIER = '01ARZ3NDEKTSV4RRFFQ69G5FAC';
const CASH = 'CASH:' + ID_A;
const BANK = 'BANK:' + ID_B;
const MFS = 'MFS:' + ID_B;
const now = '2026-11-15';
const deps = {} as PaymentAccountDeps;
const tx = {} as Tx;
const ctx: TenantContext = { tenantId: SUPPLIER, userId: ID_B, timezone: 'Asia/Dhaka' };
const resolver = vi.mocked(resolvePaymentAccount);
const leg = (accountCode: string, amountMinor: number) => ({ accountCode, amountMinor });
const costs = purchaseCosts({
  lines: [{ productId: ID_A, qty: 1000, unitPriceMinor: 9000 }],
  discountMinor: 0,
  extraCostMinor: 0,
  paidMinor: 0,
});
const run = (rows: readonly { accountCode: string; amountMinor: number }[], cost = costs) =>
  preparePurchaseInitialPaymentPosting(deps, tx, ctx, now, SUPPLIER, cost, rows);
const balanced = (lines: readonly { amountMinor: number }[]) =>
  lines.reduce((sum, line) => sum + line.amountMinor, 0);

beforeEach(() => {
  resolver.mockReset();
  resolver.mockImplementation(async (_deps, _tx, _ctx, code) => ({
    code: (code.startsWith('MFS:') ? 'BANK:' + code.slice(4) : code) as AccountCode,
    name: 'Tenant-owned verified account',
    sessionId: code.startsWith('CASH:') ? 'SESSION-A' : null,
  }));
});

describe('MOD-008 D06C1-B1a nonposting, tenant-authorized purchase journal preparation', () => {
  it('creates unpaid Inventory/AP journal without calling account resolver', async () => {
    const result = await run([]);
    expect(result).toMatchObject({ paidMinor: 0, dueMinor: 9000, initialPaymentLegs: [] });
    expect(result.journal.lines).toEqual([
      { account: 'INVENTORY', amountMinor: 9000, partyId: null },
      { account: 'AP', amountMinor: -9000, partyId: SUPPLIER },
    ]);
    expect(balanced(result.journal.lines)).toBe(0);
    expect(resolver).not.toHaveBeenCalled();
  });

  it('prepares one balanced 9000-poisha receipt journal: 2000 CASH + 1000 BANK + 6000 AP', async () => {
    const result = await run([leg(CASH, 2000), leg(BANK, 1000)]);
    expect(result.paidMinor).toBe(3000);
    expect(result.dueMinor).toBe(6000);
    expect(result.initialPaymentLegs).toEqual([
      { lineNo: 1, accountCode: CASH, amountMinor: 2000, sessionId: 'SESSION-A' },
      { lineNo: 2, accountCode: BANK, amountMinor: 1000, sessionId: null },
    ]);
    expect(result.journal.lines).toEqual([
      { account: 'INVENTORY', amountMinor: 9000, partyId: null },
      { account: CASH, amountMinor: -2000, partyId: null },
      { account: BANK, amountMinor: -1000, partyId: null },
      { account: 'AP', amountMinor: -6000, partyId: SUPPLIER },
    ]);
    expect(balanced(result.journal.lines)).toBe(0);
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(resolver.mock.calls.map((call) => [call[3], call[5]])).toEqual([
      [CASH, 2000], [BANK, 1000],
    ]);
  });

  it('aggregates repeated CASH 2000+3000 into one 5000 authorization but two journal source credits', async () => {
    const result = await run([leg(CASH, 2000), leg(CASH, 3000)]);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveBeenCalledWith(deps, tx, ctx, CASH, now, 5000);
    expect(result.paidMinor).toBe(5000);
    expect(result.dueMinor).toBe(4000);
    expect(result.initialPaymentLegs.map((x) => x.lineNo)).toEqual([1, 2]);
    expect(result.journal.lines.map((x) => [x.account, x.amountMinor])).toEqual([
      ['INVENTORY', 9000], [CASH, -2000], [CASH, -3000], ['AP', -4000],
    ]);
    expect(balanced(result.journal.lines)).toBe(0);
  });

  it('preserves original BANK-before-CASH row order even while account checks run in sorted ID order', async () => {
    const result = await run([leg(BANK, 1000), leg(CASH, 2000)]);
    expect(resolver.mock.calls.map((call) => call[3])).toEqual([CASH, BANK]);
    expect(result.initialPaymentLegs.map((x) => x.accountCode)).toEqual([BANK, CASH]);
    expect(result.journal.lines.slice(1, 3).map((x) => x.account)).toEqual([BANK, CASH]);
    expect(result.journal.lines.at(-1)).toEqual({ account: 'AP', amountMinor: -6000, partyId: SUPPLIER });
  });

  it('posts only the authoritative canonical BANK code, never the supplied MFS alias', async () => {
    const result = await run([leg(MFS, 2500)]);
    expect(resolver).toHaveBeenCalledWith(deps, tx, ctx, MFS, now, 2500);
    expect(result.initialPaymentLegs).toEqual([
      { lineNo: 1, accountCode: BANK, amountMinor: 2500, sessionId: null },
    ]);
    expect(result.journal.lines.find((x) => x.amountMinor === -2500)?.account).toBe(BANK);
    expect(balanced(result.journal.lines)).toBe(0);
  });

  it('accepts exact full payment without inventing a supplier AP line', async () => {
    const result = await run([leg(CASH, 4000), leg(BANK, 5000)]);
    expect(result.paidMinor).toBe(9000);
    expect(result.dueMinor).toBe(0);
    expect(result.journal.lines).toHaveLength(3);
    expect(result.journal.lines.some((x) => x.account === 'AP')).toBe(false);
    expect(balanced(result.journal.lines)).toBe(0);
  });

  it('preserves an explicitly signed inventory-versus-grand-total rounding journal line', async () => {
    const rounded = { ...costs, inventoryValueMinor: 8999, roundingMinor: 1 };
    const result = await run([leg(BANK, 1000)], rounded);
    expect(result.journal.lines).toEqual([
      { account: 'INVENTORY', amountMinor: 8999, partyId: null },
      { account: 'ROUNDING', amountMinor: 1, partyId: null },
      { account: BANK, amountMinor: -1000, partyId: null },
      { account: 'AP', amountMinor: -8000, partyId: SUPPLIER },
    ]);
    expect(balanced(result.journal.lines)).toBe(0);
  });

  it('accepts ten ordered positive legs and aggregates the cash validation', async () => {
    const input = Array.from({ length: 10 }, () => leg(CASH, 100));
    const result = await run(input);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveBeenCalledWith(deps, tx, ctx, CASH, now, 1000);
    expect(result.initialPaymentLegs).toHaveLength(10);
    expect(result.initialPaymentLegs.map((x) => x.lineNo)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(result.journal.lines.filter((x) => x.account === CASH)).toHaveLength(10);
    expect(result.dueMinor).toBe(8000);
    expect(balanced(result.journal.lines)).toBe(0);
  });

  it('refuses overpayment BEFORE any account resolver call', async () => {
    await expect(run([leg(CASH, 9001)])).rejects.toThrow(RangeError);
    expect(resolver).not.toHaveBeenCalled();
  });

  it.each([0, -1, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'refuses non-positive/unsafe authoritative server total %s before any account lookup', async (bad) => {
      await expect(run([leg(CASH, 100)], { ...costs, grandTotalMinor: bad })).rejects.toThrow(RangeError);
      expect(resolver).not.toHaveBeenCalled();
    },
  );

  it.each([
    [CASH, 0], [CASH, -2], [CASH, 1.5], ['AP', 100], ['LOAN:' + ID_A, 100],
    ['cash:' + ID_A, 100], ['CASH: invalid', 100], [BANK, Number.MAX_SAFE_INTEGER + 1],
  ])('rejects invalid account or amount %s %s before any authorization read', async (code, amount) => {
    await expect(run([leg(code, amount)])).rejects.toThrow(RangeError);
    expect(resolver).not.toHaveBeenCalled();
  });

  it('refuses eleven payment rows before any account authorization read', async () => {
    await expect(run(Array.from({ length: 11 }, () => leg(CASH, 1)))).rejects.toThrow(RangeError);
    expect(resolver).not.toHaveBeenCalled();
  });

  it('refuses alias collisions before any account authorization read', async () => {
    await expect(run([leg(BANK, 10), leg(MFS, 10)])).rejects.toThrow(RangeError);
    expect(resolver).not.toHaveBeenCalled();
  });

  it('rejects combined safe-integer overflow before any account read', async () => {
    await expect(run([leg(CASH, Number.MAX_SAFE_INTEGER), leg(BANK, 1)])).rejects.toThrow(RangeError);
    expect(resolver).not.toHaveBeenCalled();
  });

  it.each([
    ['FOREIGN_TENANT', 'Account belongs to another tenant'],
    ['PERMISSION_DENIED', 'Role cannot view this bank'],
    ['INACTIVE', 'Account is inactive'],
    ['CASH_ACCOUNT_SHORT', 'Drawer balance is insufficient'],
    ['CASH_DAY_NOT_STARTED', 'Drawer day is not open'],
  ])('propagates second-account %s refusal rather than returning partial source/journal', async (_reason, message) => {
    resolver.mockImplementation(async (_d, _tx, _ctx, code) => {
      if (code === BANK) throw new Error(message);
      return { code: CASH as AccountCode, name: 'Cash', sessionId: 'SESSION-A' };
    });
    await expect(run([leg(CASH, 100), leg(BANK, 200)])).rejects.toThrow(message);
    expect(resolver.mock.calls.map((call) => call[3])).toEqual([CASH, BANK]);
  });

  it('honors server-owned Cash Session OFF result without inventing a session', async () => {
    resolver.mockResolvedValueOnce({ code: CASH as AccountCode, name: 'Cash', sessionId: null });
    const result = await run([leg(CASH, 500)]);
    expect(result.initialPaymentLegs[0]?.sessionId).toBeNull();
    expect(result.journal.lines.find((x) => x.account === CASH)?.amountMinor).toBe(-500);
  });

  it('uses the original Tx/context/businessDate for every physically grouped account', async () => {
    await run([leg(BANK, 100), leg(CASH, 200)]);
    expect(resolver).toHaveBeenCalledTimes(2);
    for (const call of resolver.mock.calls) {
      expect(call[0]).toBe(deps);
      expect(call[1]).toBe(tx);
      expect(call[2]).toBe(ctx);
      expect(call[4]).toBe(now);
    }
  });

  it('does not mutate frozen payment input or caller-supplied cost object', async () => {
    const input = Object.freeze([Object.freeze(leg(MFS, 200)), Object.freeze(leg(CASH, 300))]);
    const frozenCosts = Object.freeze({ ...costs });
    const result = await run(input, frozenCosts);
    expect(input).toEqual([leg(MFS, 200), leg(CASH, 300)]);
    expect(frozenCosts.grandTotalMinor).toBe(9000);
    expect(result.initialPaymentLegs.map((x) => x.accountCode)).toEqual([BANK, CASH]);
  });
});
