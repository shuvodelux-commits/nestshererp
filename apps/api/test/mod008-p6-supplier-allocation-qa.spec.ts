/*
 * MOD-008 P6 #338 — signed Supplier settlement allocation QA.
 * @covers endpoint:POST /api/v1/purchases
 * @covers endpoint:POST /api/v1/suppliers/payments
 * @covers endpoint:GET /api/v1/suppliers/:id/due
 * @covers workflow:supplier-payment
 *
 * Only an explicit task-owned disposable PostgreSQL16 is permitted.
 * Legacy one-account settlement only; no advanced paymentLegs activation.
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
const PORT = '55766';
const NAME = 'hisabiq-mod008-p6-alloc-338-pg16';
const LABEL = 'mod008-p6-alloc-338';
const OWNER = 'mod008-p6-338-20261117';
const ACK = 'isolated-mod008-p6-alloc-338-only';
const DATABASE = 'sher_test';
const SHOP_PERMISSIONS = [
  Permission.PURCHASE_CREATE, Permission.PURCHASE_VIEW, Permission.PURCHASE_PAY,
  Permission.PRODUCT_CREATE, Permission.PRODUCT_VIEW, Permission.UNIT_MANAGE,
  Permission.SUPPLIER_CREATE, Permission.SUPPLIER_VIEW,
  Permission.BANK_ACCOUNT_VIEW, Permission.BANK_ACCOUNT_MANAGE,
  Permission.COST_VIEW,
];
const suite = process.env['HISABIQ_P6_ALLOC_338_ACK'] === ACK ? describe : describe.skip;

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
    HISABIQ_P6_ALLOC_338_ACK: ACK,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (process.env[key] !== value) throw new Error('P6 allocation QA forbidden environment: ' + key);
  }
  const inspected = spawnSync('podman', ['inspect', '--format', '{{json .}}', NAME],
    { encoding: 'utf8', timeout: 10_000 });
  if (inspected.status !== 0) throw new Error('P6 allocation QA owned PG16 missing');
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
    throw new Error('P6 allocation QA container owner, image or loopback mismatch');
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
    if (value === undefined) throw new Error('P6 allocation QA snapshot missing');
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

suite('MOD-008 P6 signed multi-bill Supplier allocation and AP integrity', () => {
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
    a = await seedTenant(pool, { name: 'P6 allocation shop A', permissions: SHOP_PERMISSIONS });
    b = await seedTenant(pool, { name: 'P6 allocation shop B', permissions: SHOP_PERMISSIONS });
    denied = await seedTenant(pool, {
      name: 'P6 unauthorized shop', permissions: [Permission.PURCHASE_VIEW],
    });
    tokenA = signToken(a, TEST_JWT_SECRET);
    tokenB = signToken(b, TEST_JWT_SECRET);
    tokenDenied = signToken(denied, TEST_JWT_SECRET);
    const units = await create('/api/v1/catalog/units', { name: 'P6 allocation piece' });
    const unitId = (units.units as Array<{ id: string }>)[0]?.id;
    expect(typeof unitId).toBe('string');
    const product = await create('/api/v1/products', {
      name: 'P6 source item', baseUnitId: unitId,
      purchasePriceMinor: 10_000, sellingPriceMinor: 12_000, minStockQty: 0,
      brandId: null, categoryId: null, sku: null, barcode: null, description: null,
      defaultDiscountType: null, defaultDiscountValue: null, offerEnabled: false,
      offerPriceMinor: null, offerStartDate: null, offerEndDate: null,
      tracksExpiry: false, tracksSerial: false, conversionUnitId: null,
      conversionFactorQty: null,
    });
    productId = product.id as string;
    const supplier = await create('/api/v1/parties', {
      name: 'P6 allocation supplier', roles: ['SUPPLIER'], phone: null,
      address: null, guardianName: null, nid: null, email: null, notes: null,
      customerGroupId: null, creditLimitMinor: null,
    });
    supplierId = supplier.id as string;
    const bank = await create('/api/v1/money/accounts', {
      name: 'P6 allocation bank', type: 'BANK', holderName: 'Test Shop',
      reference: null, isDrawer: false, openingAmountMinor: 50_000,
      openingDate: '2026-01-01', operationId: Ulid.generate(clock),
    });
    bankCode = 'BANK:' + String(bank.id);
  }, 45_000);

  it('allocates one payment oldest-first across two posted bills with exact AP and bank deltas', async () => {
    const older = await postedBill(10_000);
    const newer = await postedBill(7_000);
    const before = await snapshot(a);
    const balancesBefore = await accountBalances(a);
    const beforeB = await snapshot(b);
    const paid = await post('/api/v1/suppliers/payments', payBody(12_500));
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    const allocations = paid.body.data.allocations as Array<{
      purchaseId: string; amountMinor: number;
    }>;
    expect(allocations.map(x => [x.purchaseId, x.amountMinor])).toEqual([
      [older, 10_000], [newer, 2_500],
    ]);
    const due = await api().get('/api/v1/suppliers/' + supplierId + '/due')
      .set(auth(tokenA));
    expect(due.status).toBe(200);
    expect(due.body.data.outstandingMinor).toBe(4_500);
    const after = await snapshot(a);
    expect(after.purchases).toBe(before.purchases);
    expect(after.stocks).toBe(before.stocks);
    expect(after.lots).toBe(before.lots);
    expect(after.payments).toBe(before.payments + 1);
    expect(after.allocations).toBe(before.allocations + 2);
    expect(after.journals).toBe(before.journals + 1);
    const balancesAfter = await accountBalances(a);
    expect((balancesAfter['AP'] ?? 0) - (balancesBefore['AP'] ?? 0)).toBe(12_500);
    expect((balancesAfter[bankCode] ?? 0) - (balancesBefore[bankCode] ?? 0)).toBe(-12_500);
    expect(await snapshot(b)).toEqual(beforeB);
    await assertBalanced(a);
    await assertBalanced(b);
  }, 45_000);

  it('targets only the chosen newer bill and rejects overpay without mutation', async () => {
    const older = await postedBill(10_000);
    const newer = await postedBill(7_000);
    const paid = await post('/api/v1/suppliers/payments', payBody(2_000, newer));
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expect(paid.body.data.allocations).toEqual(expect.arrayContaining([
      expect.objectContaining({ purchaseId: newer, amountMinor: 2_000 }),
    ]));
    expect(paid.body.data.allocations).toHaveLength(1);
    const due = await api().get('/api/v1/suppliers/' + supplierId + '/due')
      .set(auth(tokenA));
    expect(due.status).toBe(200);
    expect(due.body.data.outstandingMinor).toBe(15_000);
    const perSource = Object.fromEntries(
      (due.body.data.bills as Array<{ id: string; dueMinor: number }>)
        .map(x => [x.id, x.dueMinor]),
    );
    expect(perSource).toEqual({ [older]: 10_000, [newer]: 5_000 });
    const before = await snapshot(a);
    const balancesBefore = await accountBalances(a);
    const refused = await post('/api/v1/suppliers/payments', payBody(5_001, newer));
    expect(refused.status).toBe(400);
    expect(refused.body.error?.code).toBe('VALIDATION_FAILED');
    expect(await snapshot(a)).toEqual(before);
    expect(await accountBalances(a)).toEqual(balancesBefore);
    await assertBalanced(a);
  }, 45_000);

  it('replays the same payment once and rejects changed-key intent', async () => {
    await postedBill(10_000);
    const key = Ulid.generate(clock);
    const intent = payBody(3_000);
    const first = await post('/api/v1/suppliers/payments', intent, tokenA, key);
    expect(first.status).toBe(201);
    const afterFirst = await snapshot(a);
    const balances = await accountBalances(a);
    const replay = await post('/api/v1/suppliers/payments', intent, tokenA, key);
    expect(replay.status).toBe(201);
    expect(replay.body.data).toEqual(first.body.data);
    expect(await snapshot(a)).toEqual(afterFirst);
    expect(await accountBalances(a)).toEqual(balances);
    const altered = await post('/api/v1/suppliers/payments', payBody(4_000), tokenA, key);
    expect(altered.status).toBeGreaterThanOrEqual(400);
    expect(altered.status).toBeLessThan(500);
    expect(altered.body.error?.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await snapshot(a)).toEqual(afterFirst);
    expect(await accountBalances(a)).toEqual(balances);
    await assertBalanced(a);
  }, 45_000);

  it('denies foreign, unprivileged, unsigned and invalid payments without tenant mutation', async () => {
    const purchaseId = await postedBill(10_000);
    const beforeA = await snapshot(a);
    const beforeB = await snapshot(b);
    const beforeDenied = await snapshot(denied);
    const foreign = await post('/api/v1/suppliers/payments',
      payBody(500, purchaseId), tokenB);
    expect(foreign.status).toBe(404);
    expect(JSON.stringify(foreign.body)).not.toContain(supplierId);
    const withoutPermission = await post('/api/v1/suppliers/payments',
      payBody(500, purchaseId), tokenDenied);
    expect(withoutPermission.status).toBe(403);
    const anonymous = await api().post('/api/v1/suppliers/payments')
      .set('Idempotency-Key', Ulid.generate(clock)).send(payBody(500, purchaseId));
    expect(anonymous.status).toBe(401);
    for (const amount of [0, -1, 10_001]) {
      const invalid = await post('/api/v1/suppliers/payments', payBody(amount, purchaseId));
      expect(invalid.status).toBeGreaterThanOrEqual(400);
      expect(invalid.status).toBeLessThan(500);
      expect(await snapshot(a)).toEqual(beforeA);
    }
    expect(await snapshot(a)).toEqual(beforeA);
    expect(await snapshot(b)).toEqual(beforeB);
    // Permission denial is intentionally security-audited. It must not create
    // a financial document, allocation, inventory movement or outbox event.
    const deniedAfter = await snapshot(denied);
    expect(deniedAfter).toEqual({ ...beforeDenied, audits: beforeDenied.audits + 1 });
    await assertBalanced(a);
    await assertBalanced(b);
  }, 45_000);
});
