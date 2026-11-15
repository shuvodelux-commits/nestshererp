import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccountCode } from '@sher/core-domain';
import type { PaymentAccountDeps } from './payment-account';
import { resolvePaymentAccount } from './payment-account';
import type { Tx } from '../ports/unit-of-work';
import type { TenantContext } from '../ports/tenant-context';

import { resolvePurchaseInitialPaymentAccounts } from './purchase-payment-account-resolution';

vi.mock('./payment-account', () => ({ resolvePaymentAccount: vi.fn() }));

const ID_A = '01ARZ3NDEKTSV4RRFFQ69G5FAA';
const ID_B = '01ARZ3NDEKTSV4RRFFQ69G5FAB';
const cashA = 'CASH:' + ID_A;
const cashB = 'CASH:' + ID_B;
const bankB = 'BANK:' + ID_B;
const mfsA = 'MFS:' + ID_A;
const day = '2026-11-15';
const ctx: TenantContext = { tenantId: ID_A, userId: ID_B, timezone: 'Asia/Dhaka' };
const tx = {} as Tx;
const deps = {} as PaymentAccountDeps;
const leg = (accountCode: string, amountMinor: number) => ({ accountCode, amountMinor });
const resolver = vi.mocked(resolvePaymentAccount);
const resolve = (legs: readonly { accountCode: string; amountMinor: number }[]) =>
  resolvePurchaseInitialPaymentAccounts(deps, tx, ctx, day, legs);

beforeEach(() => {
  resolver.mockReset();
  resolver.mockImplementation(async (_deps, _tx, _ctx, code) => ({
    code: (code.startsWith('MFS:') ? 'BANK:' + code.slice(4) : code) as AccountCode,
    name: 'Authorized shop-owned account',
    sessionId: code.startsWith('CASH:') ? 'OPEN-SESSION' : null,
  }));
});

describe('MOD-008 D06C1-A account-resolution handoff for initial purchase payments', () => {
  it('returns no source rows and never reads an account for an unpaid purchase', async () => {
    await expect(resolve([])).resolves.toEqual([]);
    expect(resolver).not.toHaveBeenCalled();
  });

  it('authorizes repeated drawer payments as one 5,000-poisha physical outflow', async () => {
    await expect(resolve([leg(cashA, 2000), leg(cashA, 3000)])).resolves.toEqual([
      { lineNo: 1, accountCode: cashA, amountMinor: 2000, sessionId: 'OPEN-SESSION' },
      { lineNo: 2, accountCode: cashA, amountMinor: 3000, sessionId: 'OPEN-SESSION' },
    ]);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveBeenCalledWith(deps, tx, ctx, cashA, day, 5000);
  });

  it('resolves physical accounts sorted by ID while preserving entered source row order', async () => {
    await expect(resolve([leg(bankB, 100), leg(cashA, 200), leg(bankB, 300)])).resolves.toEqual([
      { lineNo: 1, accountCode: bankB, amountMinor: 100, sessionId: null },
      { lineNo: 2, accountCode: cashA, amountMinor: 200, sessionId: 'OPEN-SESSION' },
      { lineNo: 3, accountCode: bankB, amountMinor: 300, sessionId: null },
    ]);
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(resolver.mock.calls.map((args) => [args[3], args[5]])).toEqual([
      [cashA, 200],
      [bankB, 400],
    ]);
  });

  it('retains MFS account source position but uses server-resolved canonical BANK ledger code', async () => {
    await expect(resolve([leg(mfsA, 900)])).resolves.toEqual([
      { lineNo: 1, accountCode: 'BANK:' + ID_A, amountMinor: 900, sessionId: null },
    ]);
    expect(resolver).toHaveBeenCalledWith(deps, tx, ctx, mfsA, day, 900);
  });

  it('authorizes ten original rows with one grouped cash balance check', async () => {
    const result = await resolve(Array.from({ length: 10 }, () => leg(cashA, 100)));
    expect(result).toHaveLength(10);
    expect(result.map((x) => x.lineNo)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveBeenCalledWith(deps, tx, ctx, cashA, day, 1000);
  });

  it('fails before account resolution for eleven rows', async () => {
    await expect(resolve(Array.from({ length: 11 }, () => leg(cashA, 100)))).rejects.toThrow(RangeError);
    expect(resolver).not.toHaveBeenCalled();
  });

  it('rejects mixed money account aliases before any resolver call', async () => {
    await expect(resolve([leg('BANK:' + ID_A, 100), leg(mfsA, 200)])).rejects.toThrow(RangeError);
    expect(resolver).not.toHaveBeenCalled();
    await expect(resolve([leg(cashA, 100), leg('BANK:' + ID_A, 200)])).rejects.toThrow(RangeError);
    expect(resolver).not.toHaveBeenCalled();
  });

  it.each([
    [cashA, 0], [cashA, -1], [cashA, 1.25],
    [cashA, Number.NaN], [cashA, Number.MAX_SAFE_INTEGER + 1],
    ['AP', 1], ['LOAN:' + ID_A, 1], ['EXPENSE:' + ID_A, 1],
  ])('rejects malformed or non-positive input %s / %s before resolver', async (code, amount) => {
    await expect(resolve([leg(code, amount)])).rejects.toThrow(RangeError);
    expect(resolver).not.toHaveBeenCalled();
  });

  it('rejects group-level and multi-account safe-integer overflow before account resolution', async () => {
    await expect(resolve([leg(cashA, Number.MAX_SAFE_INTEGER), leg(cashA, 1)])).rejects.toThrow(RangeError);
    await expect(resolve([leg(cashA, Number.MAX_SAFE_INTEGER), leg(bankB, 1)])).rejects.toThrow(RangeError);
    expect(resolver).not.toHaveBeenCalled();
  });

  it.each([
    ['PERMISSION_DENIED', 'Permission denied for bank'],
    ['FOREIGN_TENANT', 'Account not owned by this shop'],
    ['INACTIVE', 'Account no longer in use'],
    ['CASH_ACCOUNT_SHORT', 'Insufficient physical drawer cash'],
    ['CASH_DAY_NOT_STARTED', 'Cash day must be opened'],
  ])('propagates a second-account %s error without returning partial authorized rows', async (_reason, message) => {
    resolver.mockImplementation(async (_d, _t, _c, code) => {
      if (code === bankB) throw new Error(message);
      return { code: cashA as AccountCode, name: 'Cash', sessionId: 'OPEN-SESSION' };
    });
    await expect(resolve([leg(bankB, 100), leg(cashA, 200)])).rejects.toThrow(message);
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(resolver.mock.calls.map((call) => call[3])).toEqual([cashA, bankB]);
  });

  it.each([
    ['CASH source retyped to BANK', cashA, 'BANK:' + ID_A],
    ['BANK source retyped to CASH', bankB, cashB],
    ['BANK source returned as noncanonical MFS', bankB, 'MFS:' + ID_B],
    ['MFS alias returned without canonical BANK normalization', mfsA, mfsA],
    ['CASH source returned as non-asset AP', cashA, 'AP:' + ID_A],
    ['BANK source returned as non-asset LOAN', bankB, 'LOAN:' + ID_B],
  ])('rejects same-ID resolver family drift: %s', async (_label, original, wrong) => {
    resolver.mockResolvedValue({
      code: wrong as AccountCode,
      name: 'Inconsistent account adapter',
      sessionId: null,
    });
    await expect(resolve([leg(original, 200)])).rejects.toThrow(
      'Resolved money-account family changed during purchase validation',
    );
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it('rejects a resolver substituting another physical account identity', async () => {
    resolver.mockResolvedValue({
      code: cashB as AccountCode,
      name: 'Other physical account',
      sessionId: 'OPEN-SESSION',
    });
    await expect(resolve([leg(cashA, 250)])).rejects.toThrow(
      'Resolved money-account identity changed during purchase validation',
    );
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it('does not return a partially authorized split payment when the later account family drifts', async () => {
    const input = Object.freeze([
      Object.freeze(leg(bankB, 100)),
      Object.freeze(leg(cashA, 200)),
    ]);
    resolver.mockImplementation(async (_d, _t, _ctx, code) => ({
      code: (code === cashA ? cashA : cashB) as AccountCode,
      name: 'Attempted same-ID substitution',
      sessionId: code === cashA ? 'OPEN-SESSION' : null,
    }));
    await expect(resolve(input)).rejects.toThrow(
      'Resolved money-account family changed during purchase validation',
    );
    expect(resolver.mock.calls.map((call) => call[3])).toEqual([cashA, bankB]);
    expect(input).toEqual([leg(bankB, 100), leg(cashA, 200)]);
  });

  it('preserves frozen original payment rows without adding canonical codes to caller objects', async () => {
    const input = Object.freeze([
      Object.freeze(leg(mfsA, 150)),
      Object.freeze(leg(cashB, 250)),
    ]);
    await resolve(input);
    expect(input).toEqual([leg(mfsA, 150), leg(cashB, 250)]);
  });

  it('forwards the original exact transaction, tenant context and business date for each account', async () => {
    await resolve([leg(cashA, 250), leg(bankB, 10)]);
    for (const call of resolver.mock.calls) {
      expect(call[0]).toBe(deps);
      expect(call[1]).toBe(tx);
      expect(call[2]).toBe(ctx);
      expect(call[4]).toBe(day);
    }
  });
});
