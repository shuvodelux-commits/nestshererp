/*
 * MOD-008 P6 #349 — signed Supplier payment correction/void rollback QA.
 * @covers endpoint:POST /api/v1/purchases
 * @covers endpoint:POST /api/v1/suppliers/payments
 * @covers endpoint:PATCH /api/v1/suppliers/payments/:id
 * @covers endpoint:POST /api/v1/suppliers/payments/:id/void
 * @covers endpoint:GET /api/v1/suppliers/:id/due
 * @covers workflow:supplier-payment
 *
 * Only an explicit task-owned disposable PostgreSQL16 is permitted.
 * Existing one-account Supplier payment correction and void only; no advanced paymentLegs activation.
 */
import 'reflect-metadata';

import { spawnSync } from 'node:child_process';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Permission } from '@sher/core-contracts';
import { SystemClock, Ulid } from '@sher/shared-utils';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { AppErrorFilter } from '../src/common/app-error.filter';
import { signToken, TEST_JWT_SECRET } from './support/auth';
import type { SeededTenant } from './support/database';
import { asTenant, prepareTestDatabase, resetDatabase, seedTenant, testPool } from './support/database';

const clock = new SystemClock();
const PORT = '55769';
const NAME = 'hisabiq-mod008-p6-correct-349-pg16';
const LABEL = 'mod008-p6-correct-349';
const OWNER = 'mod008-p6-349-20261119';
const ACK = 'isolated-mod008-p6-correct-349-only';
const DATABASE = 'sher_test';
const SHOP_PERMISSIONS = [
  Permission.PURCHASE_CREATE, Permission.PURCHASE_VIEW, Permission.PURCHASE_PAY,
  Permission.PRODUCT_CREATE, Permission.PRODUCT_VIEW, Permission.UNIT_MANAGE,
  Permission.SUPPLIER_CREATE, Permission.SUPPLIER_VIEW,
  Permission.BANK_ACCOUNT_VIEW, Permission.BANK_ACCOUNT_MANAGE,
  Permission.COST_VIEW, Permission.SUPPLIER_PAYMENT_VOID,
];
const suite = process.env['HISABIQ_P6_CORRECT_349_ACK'] === ACK ? describe : describe.skip;

let app: INestApplication;
let pool: pg.Pool;
let a: SeededTenant;
let b: SeededTenant;
let denied: SeededTenant;
let tokenA: string;
let tokenB: string;
let tokenDenied: string;
let supplierId: string;
let productId: string;
let bankCode: string;

function guard(): void {
  const expected: Record<string, string> = {
    DATABASE_URL: 'postgres://sher_app:sher_app_test@127.0.0.1:' + PORT + '/' + DATABASE,
    ADMIN_DATABASE_URL: 'postgres://postgres:dev@127.0.0.1:' + PORT + '/' + DATABASE,
    JWT_SECRET: TEST_JWT_SECRET,
    HISABIQ_P6_CORRECT_349_ACK: ACK,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (process.env[key] !== value) throw new Error('P6 correction/void QA forbidden environment: ' + key);
  }
  const inspected = spawnSync('podman', ['inspect', '--format', '{{json .}}', NAME],
    { encoding: 'utf8', timeout: 10_000 });
  if (inspected.status !== 0) throw new Error('P6 correction/void QA owned PG16 missing');
  const container = JSON.parse(inspected.stdout) as {
    State?: { Running?: boolean };
    Config?: { Labels?: Record<string, string>; Env?: string[]; Image?: string };
    NetworkSettings?: {
      Ports?: Record<string, Array<{ HostIp: string; HostPort: string }> | null>;
    };
  };
  if (container.State?.Running !== true ||
      container.Config?.Labels?.['hisabiq.qa'] !== LABEL ||
      container.Config?.Labels?.['hisabiq.owner'] !== OWNER ||
      !container.Config?.Env?.includes('PG_MAJOR=16') ||
      !container.Config?.Env?.includes('POSTGRES_DB=' + DATABASE) ||
      !/postgres:16(?:-alpine)?$/.test(container.Config?.Image ?? '') ||
      !container.NetworkSettings?.Ports?.['5432/tcp']?.some(
        item => item.HostIp === '127.0.0.1' && item.HostPort === PORT)) {
    throw new Error('P6 correction/void QA container owner, image or loopback mismatch');
  }
}

const api = () => request(app.getHttpServer());
const auth = (token: string) => ({ Authorization: 'Bearer ' + token });
const post = (
  path: string, body: Record<string, unknown>, token = tokenA, key = Ulid.generate(clock),
) => api().post(path).set(auth(token)).set('Idempotency-Key', key).send(body);
async function create(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await post(path, body);
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  return result.body.data as Record<string, unknown>;
}
const payBody = (amountMinor: number, purchaseId: string | null = null) => ({
  supplierPartyId: supplierId, amountMinor, purchaseId, accountCode: bankCode, note: null,
});
async function postedBill(amountMinor: number): Promise<string> {
  const row = await create('/api/v1/purchases', {
    supplierPartyId: supplierId,
    lines: [{ productId, qty: 1_000, unitPriceMinor: amountMinor }],
    discountMinor: 0, paidMinor: 0, paidAccountCode: null,
  });
  expect(typeof row.id).toBe('string');
  return row.id as string;
}

type SourceCounts = {
  purchases: number; purchaseLines: number; journals: number; journalLines: number;
  stocks: number; lots: number; payments: number; allocations: number;
  cashMovements: number; audits: number; outbox: number;
};
async function snapshot(tenant: SeededTenant): Promise<SourceCounts> {
  return asTenant(pool, tenant.tenantId, async client => {
    const rows = await client.query<SourceCounts>(
      'SELECT ' +
      '(SELECT count(*)::int FROM purchases) AS purchases, ' +
      '(SELECT count(*)::int FROM purchase_lines) AS "purchaseLines", ' +
      '(SELECT count(*)::int FROM journal_entries) AS journals, ' +
      '(SELECT count(*)::int FROM journal_lines) AS "journalLines", ' +
      '(SELECT count(*)::int FROM stock_movements) AS stocks, ' +
      '(SELECT count(*)::int FROM inventory_lots) AS lots, ' +
      '(SELECT count(*)::int FROM supplier_payments) AS payments, ' +
      '(SELECT count(*)::int FROM payment_allocations) AS allocations, ' +
      '(SELECT count(*)::int FROM cash_movements) AS "cashMovements", ' +
      '(SELECT count(*)::int FROM audit_events) AS audits, ' +
      '(SELECT count(*)::int FROM outbox) AS outbox',
    );
    const value = rows.rows[0];
    if (value === undefined) throw new Error('P6 correction/void QA snapshot missing');
    return value;
  });
}
async function accountBalances(tenant: SeededTenant): Promise<Record<string, number>> {
  return asTenant(pool, tenant.tenantId, async client => {
    const rows = await client.query<{ account_code: string; total: string }>(
      'SELECT account_code, sum(amount_minor)::bigint AS total ' +
      'FROM journal_lines GROUP BY account_code',
    );
    return Object.fromEntries(rows.rows.map(row => [row.account_code, Number(row.total)]));
  });
}
async function assertBalanced(tenant: SeededTenant): Promise<void> {
  const imbalances = await asTenant(pool, tenant.tenantId, async client =>
    (await client.query(
      'SELECT journal_entry_id FROM journal_lines GROUP BY journal_entry_id ' +
      'HAVING sum(amount_minor) <> 0',
    )).rows);
  expect(imbalances).toEqual([]);
}


async function dueMinor(): Promise<number> {
  const response = await api().get('/api/v1/suppliers/' + supplierId + '/due')
    .set(auth(tokenA));
  expect(response.status).toBe(200);
  return response.body.data.outstandingMinor as number;
}

async function storedPayment(id: string): Promise<{
  id: string; number: string; status: string; version: number; amount_minor: number;
}> {
  return asTenant(pool, a.tenantId, async client => {
    const result = await client.query<{
      id: string; number: string; status: string; version: number; amount_minor: number;
    }>(
      'SELECT id, payment_number AS number, status, version, amount_minor FROM supplier_payments WHERE id=$1',
      [id],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('P6 correction payment source missing');
    return row;
  });
}

async function paidPurchase(): Promise<{
  purchaseId: string; payment: { id: string; number: string; amountMinor: number; version: number };
}> {
  const purchaseId = await postedBill(10_000);
  const paymentResponse = await post('/api/v1/suppliers/payments', payBody(4_000, purchaseId));
  expect(paymentResponse.status, JSON.stringify(paymentResponse.body)).toBe(201);
  expect(await dueMinor()).toBe(6_000);
  return {
    purchaseId,
    payment: paymentResponse.body.data as {
      id: string; number: string; amountMinor: number; version: number;
    },
  };
}

suite('MOD-008 P6 signed Supplier payment correction and void safety', () => {
  beforeAll(async () => {
    guard();
    pool = testPool();
    await prepareTestDatabase();
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    app.useGlobalFilters(new AppErrorFilter());
    await app.init();
  }, 120_000);
  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });
  beforeEach(async () => {
    await resetDatabase(pool);
    a = await seedTenant(pool, {
      name: 'P6 correction shop A', permissions: SHOP_PERMISSIONS,
    });
    b = await seedTenant(pool, {
      name: 'P6 correction shop B', permissions: SHOP_PERMISSIONS,
    });
    denied = await seedTenant(pool, {
      name: 'P6 correction unauthorized shop', permissions: [Permission.PURCHASE_VIEW],
    });
    tokenA = signToken(a, TEST_JWT_SECRET);
    tokenB = signToken(b, TEST_JWT_SECRET);
    tokenDenied = signToken(denied, TEST_JWT_SECRET);
    const units = await create('/api/v1/catalog/units', { name: 'P6 correction piece' });
    const unitId = (units.units as Array<{ id: string }>)[0]?.id;
    expect(typeof unitId).toBe('string');
    const product = await create('/api/v1/products', {
      name: 'P6 correction source item', baseUnitId: unitId,
      purchasePriceMinor: 10_000, sellingPriceMinor: 12_000, minStockQty: 0,
      brandId: null, categoryId: null, sku: null, barcode: null, description: null,
      defaultDiscountType: null, defaultDiscountValue: null, offerEnabled: false,
      offerPriceMinor: null, offerStartDate: null, offerEndDate: null,
      tracksExpiry: false, tracksSerial: false, conversionUnitId: null,
      conversionFactorQty: null,
    });
    productId = product.id as string;
    const supplier = await create('/api/v1/parties', {
      name: 'P6 correction Supplier', roles: ['SUPPLIER'], phone: null,
      address: null, guardianName: null, nid: null, email: null, notes: null,
      customerGroupId: null, creditLimitMinor: null,
    });
    supplierId = supplier.id as string;
    const bank = await create('/api/v1/money/accounts', {
      name: 'P6 correction Bank', type: 'BANK', holderName: 'Test Shop',
      reference: null, isDrawer: false, openingAmountMinor: 50_000,
      openingDate: '2026-01-01', operationId: Ulid.generate(clock),
    });
    bankCode = 'BANK:' + String(bank.id);
  }, 45_000);

  it('voids a posted Supplier payment exactly once and restores AP, Bank and bill due without changing stock', async () => {
    const { payment } = await paidPurchase();
    const before = await snapshot(a);
    const beforeBankAp = await accountBalances(a);
    const foreignBefore = await snapshot(b);
    const result = await post('/api/v1/suppliers/payments/' + payment.id + '/void', {
      version: payment.version, reason: 'Payment entered twice',
    });
    expect(result.status, JSON.stringify(result.body)).toBe(201);
    expect(result.body.data).toEqual({ ok: true });
    expect(await dueMinor()).toBe(10_000);
    const row = await storedPayment(payment.id);
    expect(row).toEqual(expect.objectContaining({
      id: payment.id, number: payment.number, status: 'VOIDED',
    }));
    const after = await snapshot(a);
    expect(after.payments).toBe(before.payments);
    expect(after.purchases).toBe(before.purchases);
    expect(after.stocks).toBe(before.stocks);
    expect(after.lots).toBe(before.lots);
    expect(after.journals).toBe(before.journals + 1);
    const afterBankAp = await accountBalances(a);
    expect((afterBankAp['AP'] ?? 0) - (beforeBankAp['AP'] ?? 0)).toBe(-4_000);
    expect((afterBankAp[bankCode] ?? 0) - (beforeBankAp[bankCode] ?? 0)).toBe(4_000);
    await assertBalanced(a);
    expect(await snapshot(b)).toEqual(foreignBefore);

    const frozen = await snapshot(a);
    const frozenBalances = await accountBalances(a);
    const again = await post('/api/v1/suppliers/payments/' + payment.id + '/void', {
      version: payment.version, reason: 'Repeat cancellation',
    });
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect(again.status).toBeLessThan(500);
    expect(await snapshot(a)).toEqual(frozen);
    expect(await accountBalances(a)).toEqual(frozenBalances);
  }, 50_000);

  it('corrects a Supplier payment under the same source number with atomic reversal, new allocation and balanced money', async () => {
    const { purchaseId, payment } = await paidPurchase();
    const before = await snapshot(a);
    const balancesBefore = await accountBalances(a);
    const corrected = await api().patch('/api/v1/suppliers/payments/' + payment.id)
      .set(auth(tokenA)).send({
        ...payBody(2_500, purchaseId), version: payment.version,
        reason: 'Correct cashier entered amount',
      });
    expect(corrected.status, JSON.stringify(corrected.body)).toBe(200);
    expect(corrected.body.data).toEqual({ ok: true });
    expect(await dueMinor()).toBe(7_500);
    const row = await storedPayment(payment.id);
    expect(row).toEqual(expect.objectContaining({
      id: payment.id, number: payment.number, status: 'POSTED', amount_minor: 2_500,
    }));
    expect(row.version).toBeGreaterThan(payment.version);
    const after = await snapshot(a);
    expect(after.purchases).toBe(before.purchases);
    expect(after.payments).toBe(before.payments);
    expect(after.stocks).toBe(before.stocks);
    expect(after.lots).toBe(before.lots);
    expect(after.journals).toBe(before.journals + 2);
    const balancesAfter = await accountBalances(a);
    expect((balancesAfter['AP'] ?? 0) - (balancesBefore['AP'] ?? 0)).toBe(-1_500);
    expect((balancesAfter[bankCode] ?? 0) - (balancesBefore[bankCode] ?? 0)).toBe(1_500);
    await assertBalanced(a);

    const frozen = await snapshot(a);
    const frozenBankAp = await accountBalances(a);
    const stale = await api().patch('/api/v1/suppliers/payments/' + payment.id)
      .set(auth(tokenA)).send({
        ...payBody(3_000, purchaseId), version: payment.version,
        reason: 'Stale correction must not apply',
      });
    expect(stale.status).toBeGreaterThanOrEqual(400);
    expect(stale.status).toBeLessThan(500);
    expect(await snapshot(a)).toEqual(frozen);
    expect(await accountBalances(a)).toEqual(frozenBankAp);
  }, 50_000);

  it('rejects overpay correction as a typed validation error and rolls back reversal, allocations and journals', async () => {
    const { purchaseId, payment } = await paidPurchase();
    const before = await snapshot(a);
    const beforeBalances = await accountBalances(a);
    const beforeSource = await storedPayment(payment.id);
    const result = await api().patch('/api/v1/suppliers/payments/' + payment.id)
      .set(auth(tokenA)).send({
        ...payBody(10_001, purchaseId), version: payment.version,
        reason: 'Invalid higher amount',
      });
    // Prove atomic rollback even on the current unhandled 500 regression.
    // Keep the typed API expectation last so a failing status cannot mask
    // accidental AP, bank, allocation, stock, audit or outbox mutations.
    expect(await snapshot(a)).toEqual(before);
    expect(await storedPayment(payment.id)).toEqual(beforeSource);
    expect(await accountBalances(a)).toEqual(beforeBalances);
    expect(await dueMinor()).toBe(6_000);
    await assertBalanced(a);
    expect(result.status, JSON.stringify(result.body)).toBe(400);
    expect(result.body.error?.code).toBe('VALIDATION_FAILED');
  }, 50_000);

  it('denies foreign, missing-reason, anonymous and role-denied cancellation and correction without financial writes', async () => {
    const { purchaseId, payment } = await paidPurchase();
    const before = await snapshot(a);
    const beforeBankAp = await accountBalances(a);
    const foreignBefore = await snapshot(b);
    const foreignVoid = await post('/api/v1/suppliers/payments/' + payment.id + '/void', {
      version: payment.version, reason: 'Wrong business',
    }, tokenB);
    expect(foreignVoid.status).toBe(404);
    const invalid = await post('/api/v1/suppliers/payments/' + payment.id + '/void', {
      version: payment.version, reason: ' ',
    });
    expect(invalid.status).toBe(400);
    const unauthenticated = await api().patch('/api/v1/suppliers/payments/' + payment.id)
      .send({ ...payBody(3_000, purchaseId), version: payment.version, reason: 'Wrong caller' });
    expect(unauthenticated.status).toBe(401);
    const roleDenied = await api().patch('/api/v1/suppliers/payments/' + payment.id)
      .set(auth(tokenDenied))
      .send({ ...payBody(3_000, purchaseId), version: payment.version, reason: 'No permission' });
    expect(roleDenied.status).toBe(403);
    expect(await snapshot(a)).toEqual(before);
    expect(await accountBalances(a)).toEqual(beforeBankAp);
    expect(await snapshot(b)).toEqual(foreignBefore);
    await assertBalanced(a);
  }, 50_000);
});
