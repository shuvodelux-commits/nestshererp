/*
 * MOD-008 P6: real Nest/PostgreSQL purchasing-source QA.
 *
 * @covers endpoint:POST /api/v1/purchases
 * @covers endpoint:GET /api/v1/purchases
 * @covers endpoint:GET /api/v1/purchases/:id
 * @covers permission:purchase.bill.create
 *
 * Use ONLY with the dedicated, labelled disposable P6 PostgreSQL16 container.
 * Never connect a retained shop DB; real purchase journal/stock writes are
 * created ONLY inside the disposable test tenant and reset between cases.
 * The existing production purchasing contracts remain unchanged.
 * Opt-in: HISABIQ_P6_DISPOSABLE_ACK=isolated-pg16-only; skipped in ordinary CI.
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
import {
  asTenant, prepareTestDatabase, resetDatabase, seedTenant, testPool,
} from './support/database';

const clock = new SystemClock();
const MISSING_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAX';
const PERMISSIONS = [
  Permission.PURCHASE_CREATE, Permission.PURCHASE_VIEW,
  Permission.PRODUCT_VIEW, Permission.PRODUCT_CREATE,
  Permission.PRODUCT_EDIT, Permission.PRODUCT_DEACTIVATE,
  Permission.UNIT_MANAGE, Permission.SUPPLIER_VIEW,
  Permission.SUPPLIER_CREATE, Permission.CUSTOMER_CREATE,
  Permission.CUSTOMER_VIEW, Permission.COST_VIEW,
];

let app: INestApplication;
let pool: pg.Pool;
let a: SeededTenant;
let b: SeededTenant;
let tokenA: string;
let tokenB: string;
let productId: string;
let supplierId: string;
let customerId: string;

function checkDisposable(): void {
  const expected = {
    DATABASE_URL: 'postgres://sher_app:sher_app_test@127.0.0.1:55682/sher_test',
    ADMIN_DATABASE_URL: 'postgres://postgres:dev@127.0.0.1:55682/sher_test',
    JWT_SECRET: TEST_JWT_SECRET,
    HISABIQ_P6_DISPOSABLE_ACK: 'isolated-pg16-only',
  };
  for (const [key, value] of Object.entries(expected)) {
    if (process.env[key] !== value) throw Error('P6 isolated database/secret guard failed: ' + key);
  }
  const checked = spawnSync('podman', ['inspect', '--format',
    '{{index .Config.Labels "hisabiq.qa"}}|{{.State.Running}}',
    'hisabiq-mod008-p6-pg16'], { encoding: 'utf8' });
  if (checked.status !== 0 || checked.stdout.trim() !== 'mod008-p6-535|true') {
    throw Error('P6 task-owned disposable PostgreSQL label/running guard failed');
  }
}

const api = () => request(app.getHttpServer());
const bearer = (token: string) => ({ Authorization: 'Bearer ' + token });
const post = (path: string, body: unknown, token = tokenA, key = Ulid.generate(clock)) =>
  api().post(path).set(bearer(token)).set('Idempotency-Key', key).send(body as object);
const bill = (overrides: Record<string, unknown> = {}) => ({
  supplierPartyId: supplierId,
  lines: [{ productId, qty: 1_000, unitPriceMinor: 10_000 }],
  discountMinor: 0, paidMinor: 0, paidAccountCode: null, ...overrides,
});

async function postingRows(tenant: SeededTenant) {
  return asTenant(pool, tenant.tenantId, async db => {
    const counts = await db.query(`SELECT
      (SELECT count(*)::int FROM purchases) purchases,
      (SELECT count(*)::int FROM journal_entries) journals,
      (SELECT count(*)::int FROM stock_movements) stocks,
      (SELECT count(*)::int FROM inventory_lots) lots,
      (SELECT count(*)::int FROM supplier_payments) payments`);
    return counts.rows[0] as {
      purchases: number; journals: number; stocks: number;
      lots: number; payments: number;
    };
  });
}
const zero = { purchases: 0, journals: 0, stocks: 0, lots: 0, payments: 0 };

/** Verify each real journal entry balances without undeclared workspace imports. */
async function assertBalancedEntries(tenant: SeededTenant) {
  const imbalances = await asTenant(pool, tenant.tenantId, async db => {
    const found = await db.query(`
      SELECT journal_entry_id, sum(amount_minor)::bigint AS imbalance
      FROM journal_lines GROUP BY journal_entry_id
      HAVING sum(amount_minor) <> 0`);
    return found.rows;
  });
  expect(imbalances).toEqual([]);
}

const p6Suite = process.env.HISABIQ_P6_DISPOSABLE_ACK === 'isolated-pg16-only'
  ? describe : describe.skip;
p6Suite('MOD-008 P6 real source/financial acceptance', () => {
beforeAll(async () => {
  checkDisposable();
  pool = testPool();
  await prepareTestDatabase();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.useGlobalFilters(new AppErrorFilter());
  await app.init();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

beforeEach(async () => {
  await resetDatabase(pool);
  a = await seedTenant(pool, { name: 'P6 isolated supplier shop A', permissions: PERMISSIONS });
  b = await seedTenant(pool, { name: 'P6 isolated other shop B', permissions: PERMISSIONS });
  tokenA = signToken(a, TEST_JWT_SECRET);
  tokenB = signToken(b, TEST_JWT_SECRET);

  const units = await post('/api/v1/catalog/units', { name: 'Piece' });
  expect(units.status).toBe(201);
  const unitId = units.body.data.units[0].id as string;
  const product = await post('/api/v1/products', {
    name: 'P6 Stock Item', baseUnitId: unitId,
    purchasePriceMinor: 10_000, sellingPriceMinor: 12_000, minStockQty: 0,
    brandId: null, categoryId: null, sku: null, barcode: null,
    description: null, defaultDiscountType: null, defaultDiscountValue: null,
    offerEnabled: false, offerPriceMinor: null,
    offerStartDate: null, offerEndDate: null,
    tracksExpiry: false, tracksSerial: false,
    conversionUnitId: null, conversionFactorQty: null,
  });
  expect(product.status).toBe(201);
  productId = product.body.data.id as string;
  const supplier = await post('/api/v1/parties', {
    name: 'P6 Supplier A', roles: ['SUPPLIER'], phone: null, address: null,
    guardianName: null, nid: null, email: null, notes: null,
    customerGroupId: null, creditLimitMinor: null,
  });
  expect(supplier.status).toBe(201);
  supplierId = supplier.body.data.id as string;
  const customer = await post('/api/v1/parties', {
    name: 'P6 Customer A', roles: ['CUSTOMER'], phone: '01790000123', address: null,
    guardianName: null, nid: null, email: null, notes: null,
    customerGroupId: null, creditLimitMinor: null,
  });
  expect(customer.status).toBe(201);
  customerId = customer.body.data.id as string;
}, 45_000);

  it.each([
    ['missing supplier', () => bill({ supplierPartyId: MISSING_ID })],
    ['wrong-role customer', () => bill({ supplierPartyId: customerId })],
    ['missing product', () => bill({ lines: [{ productId: MISSING_ID, qty: 1_000, unitPriceMinor: 10_000 }] })],
    ['overpayment', () => bill({ paidMinor: 10_001, paidAccountCode: null })],
  ])('rejects %s without creating financial, lot or payment rows', async (_label, makeBody) => {
    expect(await postingRows(a)).toEqual(zero);
    const result = await post('/api/v1/purchases', makeBody());
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.status).toBeLessThan(500);
    expect(await postingRows(a)).toEqual(zero);
    await assertBalancedEntries(a);
  }, 35_000);

  it('rejects inactive product and preserves an empty posting ledger', async () => {
    const changed = await post('/api/v1/products/' + productId + '/status',
      { status: 'INACTIVE' });
    expect(changed.status).toBe(200);
    const refused = await post('/api/v1/purchases', bill());
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.status).toBeLessThan(500);
    expect(await postingRows(a)).toEqual(zero);
  }, 35_000);

  it('enforces PostgreSQL tenant isolation on purchase list, detail and foreign source create', async () => {
    const created = await post('/api/v1/purchases', bill());
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.data.id as string;
    const listB = await api().get('/api/v1/purchases').set(bearer(tokenB));
    expect(listB.status).toBe(200);
    expect(listB.body.data).toEqual([]);
    const detailB = await api().get('/api/v1/purchases/' + id).set(bearer(tokenB));
    expect(detailB.status).toBe(404);
    const cross = await post('/api/v1/purchases', bill(), tokenB);
    expect(cross.status).toBeGreaterThanOrEqual(400);
    expect(cross.status).toBeLessThan(500);
    expect(await postingRows(b)).toEqual(zero);
    expect((await postingRows(a)).purchases).toBe(1);
    await assertBalancedEntries(a);
    await assertBalancedEntries(b);
  }, 35_000);

  it('posts discounted purchase exactly once with balanced inventory and AP', async () => {
    const response = await post('/api/v1/purchases', bill({ discountMinor: 2_000 }));
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.data.grandTotalMinor).toBe(8_000);
    const totals = await asTenant(pool, a.tenantId, async db => {
      const result = await db.query<{account_code:string; net:string}>(`
        SELECT account_code, sum(amount_minor)::bigint AS net
        FROM journal_lines WHERE account_code IN ('INVENTORY', 'AP')
        GROUP BY account_code`);
      return Object.fromEntries(result.rows.map(row => [row.account_code, Number(row.net)]));
    });
    expect(totals).toEqual({ INVENTORY: 8_000, AP: -8_000 });
    expect((await postingRows(a)).purchases).toBe(1);
    await assertBalancedEntries(a);
  }, 35_000);

  it('replays the same signed creation intent without duplicating stock or AP', async () => {
    const key = Ulid.generate(clock);
    const payload = bill();
    const first = await post('/api/v1/purchases', payload, tokenA, key);
    expect(first.status).toBe(201);
    const again = await post('/api/v1/purchases', payload, tokenA, key);
    expect(again.status).toBe(201);
    expect(again.body.data.id).toBe(first.body.data.id);
    const changed = await post('/api/v1/purchases', bill({ discountMinor: 100 }), tokenA, key);
    expect(changed.status).toBe(409);
    const counts = await postingRows(a);
    expect(counts).toMatchObject({ purchases: 1, journals: 1, stocks: 1, lots: 1 });
    await assertBalancedEntries(a);
  }, 35_000);

  it('refuses unsupported advanced split payments and independent unit parts before posting', async () => {
    const unsupported = [
      bill({ payments: [{ accountCode: 'CASH:unknown', amountMinor: 1_000 }] }),
      bill({ lines: [{ productId, unitParts: [{ unitId: MISSING_ID,
        quantityMilli: 1_000, unitPriceTakaX10000: 100_000 }] }] }),
    ];
    for (const body of unsupported) {
      const refused = await post('/api/v1/purchases', body);
      expect(refused.status).toBe(400);
      expect(refused.body.error.code).toBe('VALIDATION_FAILED');
      expect(await postingRows(a)).toEqual(zero);
    }
  }, 35_000);

  it('validates list query keys rather than treating arbitrary filters as trusted', async () => {
    const response = await api().get('/api/v1/purchases?surpriseFilter=TRUE')
      .set(bearer(tokenA));
    expect(response.status).toBe(400);
    expect(await postingRows(a)).toEqual(zero);
  }, 35_000);
});
