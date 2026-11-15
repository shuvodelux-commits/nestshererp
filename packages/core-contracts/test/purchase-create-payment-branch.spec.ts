import { describe, expect, it } from 'vitest';

import { createPurchaseRequestSchema } from '../src/purchasing';
import { purchaseCreatePaymentLegBranchSchema } from '../src/purchase-create-payment-branch';

/**
 * MOD-008 D06C1-B0, issue #224.
 *
 * Future payment-only purchase-create transport branch; not exported via
 * core-contracts/index or wired into the live strict purchase POST.
 * These are contract/unit assertions, NOT signed tenant/account/PG16 tests.
 */
const supplierId = '01ARZ3NDEKTSV4RRFFQ69G5FAA';
const productId = '01ARZ3NDEKTSV4RRFFQ69G5FAB';
const accountA = '01ARZ3NDEKTSV4RRFFQ69G5FAC';
const accountB = '01ARZ3NDEKTSV4RRFFQ69G5FAD';
const cash = 'CASH:' + accountA;
const bank = 'BANK:' + accountB;
const mfs = 'MFS:' + accountB;
const leg = (accountCode: string, amountMinor: number) => ({ accountCode, amountMinor });

const valid = () => ({
  supplierPartyId: supplierId,
  lines: [{ productId, qty: 1000, unitPriceMinor: 9000 }],
  paymentLegs: [] as { accountCode: string; amountMinor: number }[],
});
const parse = (input: unknown) => purchaseCreatePaymentLegBranchSchema.safeParse(input);

describe('MOD-008 D06C1-B0 standalone strict purchase paymentLegs contract', () => {
  it('requires an explicit empty paymentLegs array for fully unpaid receipt', () => {
    const result = parse(valid());
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.paymentLegs).toEqual([]);
    expect(result.data).toMatchObject({
      supplierPartyId: supplierId,
      supplierBillRef: null,
      dueDate: null,
      discountMinor: 0,
      landedCosts: [],
      extraCostMinor: 0,
      notes: null,
      correctionOf: null,
      supplierOrderId: null,
      lines: [{ productId, qty: 1000, unitPriceMinor: 9000, expiryDate: null, planLineId: null }],
    });
    expect('paidMinor' in result.data).toBe(false);
    expect('paidAccountCode' in result.data).toBe(false);
  });

  it('accepts partially paid and split cash/bank/MFS input without inferring any balance', () => {
    const rows = [leg(cash, 2000), leg(bank, 3000), leg(mfs, 1000)];
    const result = parse({ ...valid(), paymentLegs: rows });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.paymentLegs).toEqual(rows);
  });

  it('preserves repeated account source legs and their exact order', () => {
    const rows = [leg(cash, 2000), leg(bank, 500), leg(cash, 3000)];
    const result = parse({ ...valid(), paymentLegs: rows });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.paymentLegs).toEqual(rows);
  });

  it('passes through validated existing purchase header, correction, date, and source order fields', () => {
    const result = parse({
      ...valid(),
      supplierBillRef: '  REF-42  ',
      businessDate: '2026-11-15',
      dueDate: '2026-12-01',
      discountMinor: 500,
      landedCosts: [],
      extraCostMinor: 120,
      notes: '  Delivered  ',
      correctionOf: supplierId,
      supplierOrderId: productId,
      lines: [{ productId, qty: 2000, unitPriceMinor: 1250, expiryDate: '2027-03-01', planLineId: supplierId }],
      paymentLegs: [leg(cash, 100)],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toMatchObject({
      supplierBillRef: 'REF-42', businessDate: '2026-11-15', dueDate: '2026-12-01',
      discountMinor: 500, extraCostMinor: 120, notes: 'Delivered',
      correctionOf: supplierId, supplierOrderId: productId,
      lines: [{ productId, qty: 2000, unitPriceMinor: 1250, expiryDate: '2027-03-01', planLineId: supplierId }],
      paymentLegs: [leg(cash, 100)],
    });
  });

  it('accepts exactly ten positive payment legs', () => {
    const rows = Array.from({ length: 10 }, (_, index) => leg(index % 2 ? bank : cash, index + 1));
    const result = parse({ ...valid(), paymentLegs: rows });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.paymentLegs).toEqual(rows);
  });

  it('rejects eleven legs even if they all name one cash account', () => {
    expect(parse({ ...valid(), paymentLegs: Array.from({ length: 11 }, () => leg(cash, 1)) }).success).toBe(false);
  });

  it.each([undefined, null, 0, {}, '[]'])('requires a real paymentLegs array, not %s', (paymentLegs) => {
    expect(parse({ ...valid(), paymentLegs }).success).toBe(false);
  });

  it('rejects omission of paymentLegs rather than silently treating it as unpaid', () => {
    const input: Record<string, unknown> = valid();
    delete input.paymentLegs;
    expect(parse(input).success).toBe(false);
  });

  it.each([
    [cash, 0], [cash, -1], [cash, 2.5], [cash, Number.NaN],
    [cash, Number.POSITIVE_INFINITY], [cash, Number.MAX_SAFE_INTEGER + 1],
    [cash, '100'], ['AP', 10], ['EXPENSE:' + accountA, 10],
    ['cash:' + accountA, 10], ['BANK: ', 10], ['MFS:', 10],
  ])('rejects untrusted account / invalid minor amount %s, %s', (accountCode, amountMinor) => {
    expect(parse({ ...valid(), paymentLegs: [leg(accountCode as string, amountMinor as number)] }).success).toBe(false);
  });

  it('rejects a safe-integer overflow in the combined payment legs', () => {
    expect(parse({
      ...valid(),
      paymentLegs: [leg(cash, Number.MAX_SAFE_INTEGER), leg(bank, 1)],
    }).success).toBe(false);
  });

  it('rejects extra client-supplied cash session and tenant data inside any leg', () => {
    expect(parse({
      ...valid(),
      paymentLegs: [{ accountCode: cash, amountMinor: 100, sessionId: supplierId }],
    }).success).toBe(false);
    expect(parse({
      ...valid(),
      paymentLegs: [{ accountCode: cash, amountMinor: 100, tenantId: supplierId }],
    }).success).toBe(false);
  });

  it.each([
    ['paidMinor', 0], ['paidMinor', 3000], ['paidAccountCode', null], ['paidAccountCode', cash],
    ['payments', []], ['tenantId', supplierId], ['sessionId', supplierId],
    ['vendorSettlement', true], ['grandTotalMinor', 9000],
  ])('rejects disallowed top-level key %s, including harmless-looking legacy defaults', (key, value) => {
    expect(parse({ ...valid(), [key]: value }).success).toBe(false);
  });

  it('rejects unsupported advanced independent unit-pricing fields rather than discarding them', () => {
    expect(parse({
      ...valid(),
      lines: [{ productId, unitParts: [{ unitId: productId, quantityMilli: 1000, unitPriceTakaX10000: 10000 }] }],
    }).success).toBe(false);
  });

  it('preserves strict existing source-header and quantity validation', () => {
    for (const overrides of [
      { supplierPartyId: '' },
      { lines: [] },
      { lines: [{ productId, qty: 0, unitPriceMinor: 9000 }] },
      { lines: [{ productId, qty: 1000, unitPriceMinor: -1 }] },
      { discountMinor: -1 },
      { dueDate: 'not-a-date' },
    ]) {
      expect(parse({ ...valid(), ...overrides }).success).toBe(false);
    }
  });

  it('does not modify live legacy purchase POST: v1 accepted and paymentLegs still rejected', () => {
    const legacy = {
      supplierPartyId: supplierId,
      lines: [{ productId, qty: 1000, unitPriceMinor: 9000 }],
      paidMinor: 2000,
      paidAccountCode: cash,
    };
    expect(createPurchaseRequestSchema.safeParse(legacy).success).toBe(true);
    expect(parse(legacy).success).toBe(false);
    expect(createPurchaseRequestSchema.safeParse({ ...valid(), paymentLegs: [leg(cash, 100)] }).success).toBe(false);
    expect(createPurchaseRequestSchema.safeParse({ ...legacy, payments: [leg(cash, 100)] }).success).toBe(false);
  });
});
