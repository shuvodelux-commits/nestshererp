/*
 * MOD-008 P6D #213 — real OPEN supplier order→purchase source-integrity QA.
 * QA-only. NEVER change backend posting code from this test branch.
 * Opt-in, label-checked disposable PostgreSQL16 only; no shared DB or UI.
 *
 * @covers endpoint:POST /api/v1/purchase-plans
 * @covers endpoint:POST /api/v1/purchase-plans/:id/decide
 * Supplier-order detail GET assertions remain executable, but its route is not in the
 * generated endpoint census; do not invent a @covers inventory claim.
 * @covers endpoint:POST /api/v1/purchases
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

const DB_NAME = 'hisabiq-mod008-p6d-213-pg16';
const DB_LABEL = 'mod008-p6d-213';
const DB_PORT = 55686;
const APP_URL = 'postgres://sher_app:sher_app_test@127.0.0.1:' + DB_PORT + '/sher_test';
const ADMIN_URL = 'postgres://postgres:dev@127.0.0.1:' + DB_PORT + '/sher_test';

const permissions = [
  Permission.PURCHASE_CREATE, Permission.PURCHASE_VIEW, Permission.PURCHASE_EDIT,
  Permission.PURCHASE_PLAN_VIEW, Permission.PURCHASE_PLAN_MANAGE,
  Permission.PRODUCT_VIEW, Permission.PRODUCT_CREATE, Permission.PRODUCT_EDIT,
  Permission.UNIT_MANAGE, Permission.SUPPLIER_VIEW, Permission.SUPPLIER_CREATE,
  Permission.COST_VIEW,
];

const clock = new SystemClock();
let app: INestApplication;
let pool: pg.Pool;
let tenant: SeededTenant;
let token: string;
let supplierId: string;
let productId: string;

function assertDisposable(): void {
  const required = {
    DATABASE_URL: APP_URL,
    TEST_DATABASE_URL: APP_URL,
    ADMIN_DATABASE_URL: ADMIN_URL,
    JWT_SECRET: TEST_JWT_SECRET,
    HISABIQ_P6D_DISPOSABLE_ACK: 'isolated-pg16-only',
  };
  for (const [key, value] of Object.entries(required)) {
    if (process.env[key] !== value) throw Error('P6D disposable test environment refused: ' + key);
  }
  const result = spawnSync('podman', [
    'inspect', '--format', '{{index .Config.Labels "hisabiq.qa"}}|{{.State.Running}}', DB_NAME,
  ], { encoding: 'utf8' });
  if (result.status !== 0 || result.stdout.trim() !== DB_LABEL + '|true') {
    throw Error('P6D own labelled PostgreSQL16 is not running');
  }
}

const api = () => request(app.getHttpServer());
const signed = (jwt = token) => ({ Authorization: 'Bearer ' + jwt });
const post = (path: string, body: object, jwt = token, key = Ulid.generate(clock)) =>
  api().post(path).set(signed(jwt)).set('Idempotency-Key', key).send(body);
const get = (path: string, jwt = token) => api().get(path).set(signed(jwt));

async function seedSources(jwt: string, suffix: string) {
  const unit = await post('/api/v1/catalog/units', { name: 'Pieces ' + suffix }, jwt);
  expect(unit.status, JSON.stringify(unit.body)).toBe(201);
  const baseUnitId = unit.body.data.units[0].id as string;
  const product = await post('/api/v1/products', {
    name: 'P6D Product ' + suffix, baseUnitId,
    purchasePriceMinor: 10000, sellingPriceMinor: 12000, minStockQty: 0,
    brandId: null, categoryId: null, sku: null, barcode: null, description: null,
    defaultDiscountType: null, defaultDiscountValue: null, offerEnabled: false,
    offerPriceMinor: null, offerStartDate: null, offerEndDate: null,
    tracksExpiry: false, tracksSerial: false,
    conversionUnitId: null, conversionFactorQty: null,
  }, jwt);
  expect(product.status, JSON.stringify(product.body)).toBe(201);
  const supplier = await post('/api/v1/parties', {
    name: 'P6D Supplier ' + suffix, roles: ['SUPPLIER'],
    phone: null, address: null, guardianName: null,
    nid: null, email: null, notes: null,
    customerGroupId: null, creditLimitMinor: null,
  }, jwt);
  expect(supplier.status, JSON.stringify(supplier.body)).toBe(201);
  return { productId: product.body.data.id as string, supplierId: supplier.body.data.id as string };
}

type OrderFixture = { orderId: string; planLineId: string; supplierId: string; productId: string };

async function approvedOrder(ids: { supplierId: string; productId: string }, jwt = token): Promise<OrderFixture> {
  const plan = await post('/api/v1/purchase-plans', {
    notes: 'P6D reviewed order',
    lookBackDays: 30,
    coverDays: 7,
    budgetMinor: null,
    lines: [{ productId: ids.productId, supplierPartyId: ids.supplierId, plannedQty: 1000 }],
  }, jwt);
  expect(plan.status, JSON.stringify(plan.body)).toBe(201);
  expect(plan.body.data.status).toBe('DRAFT');
  const planId = plan.body.data.id as string;
  const planLineId = plan.body.data.lines[0].id as string;
  const accepted = await post('/api/v1/purchase-plans/' + planId + '/decide', {
    decision: 'APPROVED', version: plan.body.data.version,
  }, jwt);
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
  expect(accepted.body.data.status).toBe('APPROVED');
  const orderList = await get('/api/v1/supplier-orders', jwt);
  expect(orderList.status, JSON.stringify(orderList.body)).toBe(200);
  const order = (orderList.body.data as Array<{ id: string; supplierPartyId: string; status: string }>)
    .find(row => row.supplierPartyId === ids.supplierId && row.status === 'OPEN');
  expect(order).toBeDefined();
  const orderId = order?.id ?? '';
  const source = await get('/api/v1/supplier-orders/' + orderId, jwt);
  expect(source.status, JSON.stringify(source.body)).toBe(200);
  expect(source.body.data.status).toBe('OPEN');
  expect(source.body.data.supplierPartyId).toBe(ids.supplierId);
  return { orderId, planLineId, ...ids };
}

function purchaseBody(source: OrderFixture, overrides: Record<string, unknown> = {}) {
  return {
    supplierPartyId: source.supplierId,
    supplierOrderId: source.orderId,
    lines: [{
      productId: source.productId, qty: 1000, unitPriceMinor: 10000,
      planLineId: source.planLineId,
    }],
    discountMinor: 0, paidMinor: 0, paidAccountCode: null, ...overrides,
  };
}

/** Financial, document, audit and outbox rows as tenant-seen PostgreSQL facts. */
async function snapshot(tenantId = tenant.tenantId) {
  return asTenant(pool, tenantId, async db => {
    const rows = await db.query(
      'SELECT ' +
      '(SELECT count(*)::int FROM purchases) AS purchases, ' +
      '(SELECT count(*)::int FROM purchase_lines) AS purchase_lines, ' +
      '(SELECT count(*)::int FROM journal_entries) AS journal_entries, ' +
      '(SELECT count(*)::int FROM journal_lines) AS journal_lines, ' +
      '(SELECT count(*)::int FROM stock_movements) AS stock_movements, ' +
      '(SELECT count(*)::int FROM inventory_lots) AS inventory_lots, ' +
      '(SELECT count(*)::int FROM payment_allocations) AS payments, ' +
      '(SELECT count(*)::int FROM audit_events) AS audits, ' +
      '(SELECT count(*)::int FROM outbox) AS outbox, ' +
      "(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'status',status,'purchaseId',purchase_id) ORDER BY id),'[]'::jsonb) FROM supplier_purchase_orders) AS orders",
    );
    return rows.rows[0];
  });
}

async function assertSourceUnchanged(source: OrderFixture, before: unknown) {
  const order = await get('/api/v1/supplier-orders/' + source.orderId);
  expect(order.status, JSON.stringify(order.body)).toBe(200);
  expect(order.body.data.status).toBe('OPEN');
  expect(order.body.data.purchaseId).toBeNull();
  expect(await snapshot()).toEqual(before);
}

const gated = process.env.HISABIQ_P6D_DISPOSABLE_ACK === 'isolated-pg16-only' ? describe : describe.skip;

gated('MOD-008 P6D approved supplier-order conversion source invariants (real signed Nest, RLS PG16)', () => {
  beforeAll(async () => {
    assertDisposable();
    pool = testPool();
    await prepareTestDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AppErrorFilter());
    await app.init();
  }, 120000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    tenant = await seedTenant(pool, { name: 'P6D QA shop', permissions });
    token = signToken(tenant, TEST_JWT_SECRET);
    ({ supplierId, productId } = await seedSources(token, 'A'));
  }, 60000);

  it('plans and approves an OPEN supplier order without any financial posting or price leak', async () => {
    const before = await snapshot();
    const source = await approvedOrder({ supplierId, productId });
    const after = await snapshot();
    expect(after.purchases).toBe(before.purchases);
    expect(after.journal_entries).toBe(before.journal_entries);
    expect(after.stock_movements).toBe(before.stock_movements);
    expect(after.inventory_lots).toBe(before.inventory_lots);
    const response = await get('/api/v1/supplier-orders/' + source.orderId);
    expect(response.status).toBe(200);
    const serialized = JSON.stringify(response.body.data).toLowerCase();
    for (const prohibited of ['priceminor', 'costminor', 'sellingprice', 'profitminor', 'marginminor', 'stockqty']) {
      expect(serialized, prohibited).not.toContain(prohibited);
    }
  });

  it('converts a real matching OPEN order into one purchase, then exact key replay has zero side effects', async () => {
    const source = await approvedOrder({ supplierId, productId });
    const key = Ulid.generate(clock);
    const payload = purchaseBody(source);
    const created = await post('/api/v1/purchases', payload, token, key);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const order = await get('/api/v1/supplier-orders/' + source.orderId);
    expect(order.status).toBe(200);
    expect(order.body.data.status).toBe('CONVERTED');
    expect(order.body.data.purchaseId).toBe(created.body.data.id);
    const before = await snapshot();
    expect(before.purchases).toBe(1);
    expect(before.journal_entries).toBe(1);
    expect(before.stock_movements).toBe(1);
    const repeat = await post('/api/v1/purchases', payload, token, key);
    expect(repeat.status, JSON.stringify(repeat.body)).toBe(201);
    expect(repeat.body.data.id).toBe(created.body.data.id);
    expect(await snapshot()).toEqual(before);
  });

  it('rejects converting supplier A order onto supplier B purchase atomically', async () => {
    const source = await approvedOrder({ supplierId, productId });
    const wrong = await seedSources(token, 'B');
    const before = await snapshot();
    const result = await post('/api/v1/purchases', purchaseBody(source, {
      supplierPartyId: wrong.supplierId,
    }));
    expect(result.status, JSON.stringify(result.body)).toBeGreaterThanOrEqual(400);
    expect(result.status, JSON.stringify(result.body)).toBeLessThan(500);
    await assertSourceUnchanged(source, before);
  });

  it('rejects a different operation attempting to convert an already CONVERTED order', async () => {
    const source = await approvedOrder({ supplierId, productId });
    const first = await post('/api/v1/purchases', purchaseBody(source));
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const before = await snapshot();
    const second = await post('/api/v1/purchases', purchaseBody(source));
    expect(second.status, JSON.stringify(second.body)).toBeGreaterThanOrEqual(400);
    expect(second.status, JSON.stringify(second.body)).toBeLessThan(500);
    expect(await snapshot()).toEqual(before);
    const order = await get('/api/v1/supplier-orders/' + source.orderId);
    expect(order.body.data.purchaseId).toBe(first.body.data.id);
  });

  it('rejects receiving a different product against a real approved supplier order', async () => {
    const source = await approvedOrder({ supplierId, productId });
    const otherProduct = await seedSources(token, 'C');
    const before = await snapshot();
    const result = await post('/api/v1/purchases', purchaseBody(source, {
      lines: [{ productId: otherProduct.productId, qty: 1000, unitPriceMinor: 10000 }],
    }));
    expect(result.status, JSON.stringify(result.body)).toBeGreaterThanOrEqual(400);
    expect(result.status, JSON.stringify(result.body)).toBeLessThan(500);
    await assertSourceUnchanged(source, before);
  });

  it('serializes two distinct operation keys targeting one OPEN order into exactly one purchase', async () => {
    const source = await approvedOrder({ supplierId, productId });
    const payload = purchaseBody(source);
    const responses = await Promise.all([
      post('/api/v1/purchases', payload, token, Ulid.generate(clock)),
      post('/api/v1/purchases', payload, token, Ulid.generate(clock)),
    ]);
    const statuses = responses.map(row => row.status).sort((a, b) => a - b);
    expect(statuses, JSON.stringify(responses.map(row => row.body))).toEqual([201, 409]);
    const after = await snapshot();
    expect(after.purchases).toBe(1);
    expect(after.journal_entries).toBe(1);
    expect(after.stock_movements).toBe(1);
    const order = await get('/api/v1/supplier-orders/' + source.orderId);
    expect(order.status).toBe(200);
    expect(order.body.data.status).toBe('CONVERTED');
    const winner = responses.find(row => row.status === 201);
    expect(order.body.data.purchaseId).toBe(winner?.body.data.id);
  }, 120000);

  it('rejects a foreign-tenant order even with a valid local supplier and product', async () => {
    const source = await approvedOrder({ supplierId, productId });
    const tenantB = await seedTenant(pool, { name: 'P6D shop B', permissions });
    const tokenB = signToken(tenantB, TEST_JWT_SECRET);
    const localB = await seedSources(tokenB, 'TenantB');
    const beforeA = await snapshot();
    const beforeB = await snapshot(tenantB.tenantId);
    const outcome = await post('/api/v1/purchases', purchaseBody(source, {
      supplierPartyId: localB.supplierId,
      lines: [{ productId: localB.productId, qty: 1000, unitPriceMinor: 10000 }],
    }), tokenB);
    expect(outcome.status, JSON.stringify(outcome.body)).toBeGreaterThanOrEqual(400);
    expect(outcome.status, JSON.stringify(outcome.body)).toBeLessThan(500);
    expect(await snapshot()).toEqual(beforeA);
    expect(await snapshot(tenantB.tenantId)).toEqual(beforeB);
    const inaccessible = await get('/api/v1/supplier-orders/' + source.orderId, tokenB);
    expect([403, 404]).toContain(inaccessible.status);
  });
});
