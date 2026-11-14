import { describe, expect, it } from 'vitest';

import { groupPurchasePaymentOutflows } from './purchase-payment-outflow-groups';

const ID_A = '01ARZ3NDEKTSV4RRFFQ69G5FAA';
const ID_B = '01ARZ3NDEKTSV4RRFFQ69G5FAB';
const cashA = 'CASH:' + ID_A;
const cashB = 'CASH:' + ID_B;
const bankA = 'BANK:' + ID_A;
const bankB = 'BANK:' + ID_B;
const mfsA = 'MFS:' + ID_A;
const leg = (accountCode: string, amountMinor: number) => ({ accountCode, amountMinor });
const group = (input: readonly { accountCode: string; amountMinor: number }[]) =>
  groupPurchasePaymentOutflows(input);

/** Pure source guard. No tenant/account authorization, DB lock or purchase POST. */
describe('MOD-008 D06C0 grouped payment outflow authorization preflight', () => {
  it('returns no outflows for an unpaid purchase', () => {
    expect(group([])).toEqual([]);
  });

  it('aggregates repeated drawer legs to one 5,000-poisha check, not separate 2,000+3,000 checks', () => {
    expect(group([leg(cashA, 2000), leg(cashA, 3000)])).toEqual([
      { accountId: ID_A, accountCode: cashA, amountMinor: 5000 },
    ]);
  });

  it('aggregates repeated bank rows without inventing new journal lines', () => {
    expect(group([leg(bankB, 300), leg(bankB, 500)])).toEqual([
      { accountId: ID_B, accountCode: bankB, amountMinor: 800 },
    ]);
  });

  it('returns a deterministic account-id order regardless of input order', () => {
    const a = group([leg(bankB, 100), leg(cashA, 200), leg(bankB, 100)]);
    const b = group([leg(cashA, 200), leg(bankB, 100), leg(bankB, 100)]);
    expect(a).toEqual([
      { accountId: ID_A, accountCode: cashA, amountMinor: 200 },
      { accountId: ID_B, accountCode: bankB, amountMinor: 200 },
    ]);
    expect(a).toEqual(b);
  });

  it('accepts MFS alias as an unverified account identifier for the future resolver', () => {
    expect(group([leg(mfsA, 500)])).toEqual([
      { accountId: ID_A, accountCode: mfsA, amountMinor: 500 },
    ]);
  });

  it('rejects mixed BANK and MFS aliases for the same account instead of bypassing grouped checks', () => {
    expect(() => group([leg(bankA, 2000), leg(mfsA, 3000)])).toThrow(RangeError);
    expect(() => group([leg(mfsA, 2000), leg(bankA, 3000)])).toThrow(RangeError);
  });

  it('rejects a mixed CASH and BANK identity for the same account', () => {
    expect(() => group([leg(cashA, 100), leg(bankA, 100)])).toThrow(RangeError);
  });

  it('does not merge different account identities just because their account family matches', () => {
    expect(group([leg(cashB, 1000), leg(cashA, 2000)])).toEqual([
      { accountId: ID_A, accountCode: cashA, amountMinor: 2000 },
      { accountId: ID_B, accountCode: cashB, amountMinor: 1000 },
    ]);
  });

  it('accepts ten positive source legs and aggregates them to one authorization group', () => {
    expect(group(Array.from({ length: 10 }, () => leg(cashA, 100)))).toEqual([
      { accountId: ID_A, accountCode: cashA, amountMinor: 1000 },
    ]);
  });

  it('rejects eleven source legs even if they belong to one account', () => {
    expect(() => group(Array.from({ length: 11 }, () => leg(cashA, 1)))).toThrow(RangeError);
  });

  it.each([0, -1, 0.25, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects non-positive, non-integer or unsafe amountMinor %s', amountMinor => {
      expect(() => group([leg(cashA, amountMinor)])).toThrow(RangeError);
    },
  );

  it('rejects overflow within one grouped account', () => {
    expect(() => group([leg(cashA, Number.MAX_SAFE_INTEGER), leg(cashA, 1)])).toThrow(RangeError);
  });

  it('rejects overflow across separate account groups', () => {
    expect(() => group([leg(cashA, Number.MAX_SAFE_INTEGER), leg(bankB, 1)])).toThrow(RangeError);
  });

  it.each([
    'AP', 'INVENTORY', 'EXPENSE:' + ID_A, 'LOAN:' + ID_A, 'CASH:', 'cash:' + ID_A,
    'BANK:bad id', ' BANK:' + ID_A, 'MFS:' + 'A'.repeat(36),
  ])('rejects a malformed or non-asset account reference %s', accountCode => {
    expect(() => group([leg(accountCode, 1)])).toThrow(RangeError);
  });

  it('preserves frozen original ordered rows for immutable source/audit writers', () => {
    const input = Object.freeze([
      Object.freeze(leg(bankB, 100)),
      Object.freeze(leg(cashA, 200)),
      Object.freeze(leg(bankB, 300)),
    ]);
    const result = group(input);
    expect(input).toEqual([leg(bankB, 100), leg(cashA, 200), leg(bankB, 300)]);
    expect(result).toEqual([
      { accountId: ID_A, accountCode: cashA, amountMinor: 200 },
      { accountId: ID_B, accountCode: bankB, amountMinor: 400 },
    ]);
  });
});
