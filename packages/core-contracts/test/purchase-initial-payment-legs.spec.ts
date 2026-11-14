import { describe, expect, it } from 'vitest';

import { purchaseInitialPaymentLegsSchema } from '../src/purchasing';

/**
 * MOD-008 D06B #224: a pure, nonposting request-array validator.
 *
 * This does NOT add a paymentLegs or payments field to the live
 * createPurchaseRequestSchema. No account is authenticated by this helper:
 * future Class-T application code must resolve and lock every tenant-owned
 * account before posting any journal, inventory or supplier-order source.
 */
const accountId = '01ARZ3NDEKTSV4RRFFQ69G5FAA';
const cash = 'CASH:' + accountId;
const bank = 'BANK:' + accountId;
const row = (accountCode: string, amountMinor: number) => ({ accountCode, amountMinor });
const parse = (input: unknown) => purchaseInitialPaymentLegsSchema.safeParse(input);

describe('MOD-008 D06B initial purchase payment-leg request preflight', () => {
  it('accepts explicit empty legs for a fully unpaid purchase', () => {
    const result = parse([]);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual([]);
  });

  it('accepts ordered cash and bank/MFS rows without coercing integer poisha', () => {
    const input = [row(cash, 2_000), row(bank, 1_000)];
    const result = parse(input);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(input);
  });

  it('accepts legacy MFS account syntax for later server-side BANK code normalization', () => {
    const input = [row('MFS:' + accountId, 1_500)];
    const result = parse(input);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(input);
  });

  it('preserves repeated account rows for audit/source provenance', () => {
    const result = parse([row(cash, 2_000), row(cash, 3_000)]);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual([row(cash, 2_000), row(cash, 3_000)]);
  });

  it('accepts ten distinct positive legs with safe aggregate', () => {
    const input = Array.from({ length: 10 }, (_, i) => row(i % 2 ? bank : cash, 1));
    const result = parse(input);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toHaveLength(10);
  });

  it('rejects eleven legs before any purchase writer can run', () => {
    expect(parse(Array.from({ length: 11 }, () => row(cash, 1))).success).toBe(false);
  });

  it.each([0, -1, 0.25, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid amountMinor %s', (amountMinor) => {
      expect(parse([row(cash, amountMinor)]).success).toBe(false);
    },
  );

  it('refuses string-encoded, null and omitted amounts instead of coercing', () => {
    for (const amountMinor of ['100', null, undefined]) {
      expect(parse([{ accountCode: cash, amountMinor }]).success).toBe(false);
    }
  });

  it('rejects combined poisha overflowing the safe integer even if each leg is safe', () => {
    expect(parse([row(cash, Number.MAX_SAFE_INTEGER), row(bank, 1)]).success).toBe(false);
  });

  it.each([
    'AP', 'INVENTORY', 'LOAN:' + accountId, 'EXPENSE:' + accountId,
    'cash:' + accountId, 'CASH:', 'CASH: invalid',
    ' CASH:' + accountId, 'BANK:' + 'A'.repeat(36),
  ])('refuses invalid or non-asset payment account syntax %s', accountCode => {
    expect(parse([row(accountCode, 1)]).success).toBe(false);
  });

  it('rejects arbitrary extra leg fields to prevent unreviewed payment metadata', () => {
    expect(parse([{ accountCode: cash, amountMinor: 100, sessionId: accountId }]).success).toBe(false);
  });

  it('requires explicit array presence when the future advanced request branch is selected', () => {
    expect(parse(undefined).success).toBe(false);
    expect(parse(null).success).toBe(false);
    expect(parse({ paidMinor: 2000, paidAccountCode: cash }).success).toBe(false);
  });

  it('does not mutate the supplied ordered payment row objects', () => {
    const input = Object.freeze([
      Object.freeze(row(cash, 2_000)),
      Object.freeze(row(bank, 1_000)),
    ]);
    const result = parse(input);
    expect(result.success).toBe(true);
    expect(input).toEqual([row(cash, 2_000), row(bank, 1_000)]);
  });
});
