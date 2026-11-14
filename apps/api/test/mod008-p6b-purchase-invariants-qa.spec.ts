/*
 * MOD-008 P6B: fail-closed purchase validation under actual Nest/PostgreSQL16.
 * Test-only: no existing UI, purchasing service, schema or accounting code edits.
 * Destructive test setup is forbidden unless labelled disposable PG is present.
 *
 * @covers endpoint:POST /api/v1/purchases
 * @covers endpoint:POST /api/v1/products/:id/status
 */
import 'reflect-metadata';

import { spawnSync } from 'node:child_process';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Permission } from '@sher/core-contracts';
import { SystemClock, Ulid } from '@sher/shared-utils';
import { Pool } from 'pg';
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

const DB_PORT = 55684;
const DB_NAME = 'hisabiq-mod008-p6b-155-pg16';
const DB_LABEL = 'mod008-p6b-155';
const APP_URL = `postgres://sher_app:sher_app_test@127.0.0.1:${DB_PORT}/sher_test`;
const ADMIN_URL = `postgres://postgres:dev@127.0.0.1:${DB_PORT}/sher_test`;
const clock = new SystemClock();
const permissions = [
  Permission.PURCHASE_CREATE, Permission.PURCHASE_VIEW, Permission.PURCHASE_EDIT,
  Permission.PRODUCT_VIEW, Permission.PRODUCT_CREATE, Permission.PRODUCT_EDIT,
  Permission.PRODUCT_DEACTIVATE, Permission.UNIT_MANAGE, Permission.SUPPLIER_VIEW,
  Permission.SUPPLIER_CREATE, Permission.COST_VIEW,
];
let app: INestApplication;
let pool: pg.Pool;
let a: SeededTenant;
let tokenA: string;
let supplierId: string;
let baseUnitId: string;
let activeId: string;
let inactiveCandidateId: string;

function assertDisposable(): void {
  const allowed = {
    DATABASE_URL: APP_URL,
    TEST_DATABASE_URL: APP_URL,
    ADMIN_DATABASE_URL: ADMIN_URL,
    JWT_SECRET: TEST_JWT_SECRET,
    HISABIQ_P6B_DISPOSABLE_ACK: 'isolated-pg16-only',
  };
  for (const [key, value] of Object.entries(allowed)) {
    if (process.env[key] !== value) {
      throw Error(`P6B disposable PostgreSQL/secret guard failed: ${key}`);
    }
  }
  const container = spawnSync('podman', [
    'inspect', '--format', '{{index .Config.Labels "hisabiq.qa"}}|{{.State.Running}}',
    DB_NAME,
  ], { encoding: 'utf8' });
  if (container.status !== 0 || container.stdout.trim() !== `${DB_LABEL}|true`) {
    throw Error('P6B task-owned PostgreSQL container label/running check failed');
  }
}

const api = () => request(app.getHttpServer());
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const post = (route: string, body: object, key = Ulid.generate(clock)) =>
  api().post(route).set(bearer(tokenA)).set('Idempotency-Key', key).send(body);

function bill(lines: readonly { productId: string; qty: number; unitPriceMinor: number }[],
  overrides: Record<string, unknown> = {}) {
  return {
    supplierPartyId: supplierId,
    lines,
    discountMinor: 0,
    paidMinor: 0,
    paidAccountCode: null,
    ...overrides,
  };
}
function line(productId: string, price = 10000) {
  return { productId, qty: 1000, unitPriceMinor: price };
}

async function snapshot() {
  return asTenant(pool, a.tenantId, async db => {
    const result = await db.query(`SELECT
      (SELECT count(*)::int FROM purchases) AS purchases,
      (SELECT count(*)::int FROM journal_entries) AS journals,
      (SELECT count(*)::int FROM journal_lines) AS journal_lines,
      (SELECT count(*)::int FROM stock_movements) AS movements,
      (SELECT count(*)::int FROM inventory_lots) AS lots,
      (SELECT count(*)::int FROM supplier_payments) AS payments,
      (SELECT count(*)::int FROM audit_events) AS audits,
      (SELECT count(*)::int FROM outbox) AS outbox,
      (SELECT count(*)::int FROM product_cost_state) AS cost_positions,
      (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'status', status,
        'version', version) ORDER BY id), '[]'::jsonb) FROM purchases) AS bills`);
    return result.rows[0];
  });
}

async function createProduct(name: string): Promise<string> {
  const response = await post('/api/v1/products', {
    name, baseUnitId, purchasePriceMinor: 10000,
    sellingPriceMinor: 12000, minStockQty: 0,
    brandId: null, categoryId: null, sku: null, barcode: null,
    description: null, defaultDiscountType: null,
    defaultDiscountValue: null, offerEnabled: false,
    offerPriceMinor: null, offerStartDate: null, offerEndDate: null,
    tracksExpiry: false, tracksSerial: false,
    conversionUnitId: null, conversionFactorQty: null,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data.id as string;
}

async function makeInactive(productId: string) {
  const response = await post(`/api/v1/products/${productId}/status`,
    { status: 'INACTIVE' });
  expect(response.status).toBe(200);
  expect(response.body.data.status).toBe('INACTIVE');
}


/** Poll the owned disposable PostgreSQL, not timing sleeps or an app mock. */
async function waitForPgLock(admin: Pool, relation: string): Promise<boolean> {
  for (let i = 0; i < 240; i++) {
    const blocked = await admin.query<{ waiting: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND query ILIKE $1
      ) AS waiting
    `, [`%${relation}%`]);
    if (blocked.rows[0]?.waiting === true) return true;
    await new Promise<void>(resolve => setTimeout(resolve, 50));
  }
  return false;
}

const gated = process.env.HISABIQ_P6B_DISPOSABLE_ACK === 'isolated-pg16-only'
  ? describe : describe.skip;

gated('MOD-008 P6B source-locked purchases and rollback', () => {
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
    a = await seedTenant(pool, { name: 'P6B disposable correction shop A', permissions });
    tokenA = signToken(a, TEST_JWT_SECRET);
    const unit = await post('/api/v1/catalog/units', { name: 'Piece' });
    expect(unit.status).toBe(201);
    baseUnitId = unit.body.data.units[0].id as string;
    activeId = await createProduct('P6B Active Item');
    inactiveCandidateId = await createProduct('P6B Other Item');
    const supplier = await post('/api/v1/parties', {
      name: 'P6B Real Supplier', roles: ['SUPPLIER'],
      phone: null, address: null, guardianName: null,
      nid: null, email: null, notes: null,
      customerGroupId: null, creditLimitMinor: null,
    });
    expect(supplier.status, JSON.stringify(supplier.body)).toBe(201);
    supplierId = supplier.body.data.id as string;
  }, 60000);

  it('returns exact PRODUCT_INACTIVE code/details, with zero financial/audit writes', async () => {
    await makeInactive(inactiveCandidateId);
    const before = await snapshot();
    const rejected = await post('/api/v1/purchases', bill([line(inactiveCandidateId)]));
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { reason: 'PRODUCT_INACTIVE', productId: inactiveCandidateId },
    });
    expect(await snapshot()).toEqual(before);
    const accepted = await post('/api/v1/purchases', bill([line(activeId)]));
    expect(accepted.status).toBe(201);
    expect((await snapshot()).purchases).toBe(1);
  }, 60000);

  it('rejects mixed ACTIVE then INACTIVE basket atomically', async () => {
    await makeInactive(inactiveCandidateId);
    const before = await snapshot();
    const rejected = await post('/api/v1/purchases',
      bill([line(activeId), line(inactiveCandidateId)]));
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.details.reason).toBe('PRODUCT_INACTIVE');
    expect(await snapshot()).toEqual(before);
  }, 60000);

  it('rolls back correction reversal, stock, AP, audit and outbox if replacement is inactive', async () => {
    const original = await post('/api/v1/purchases', bill([line(activeId)]));
    expect(original.status).toBe(201);
    await makeInactive(inactiveCandidateId);
    const before = await snapshot();
    const attempt = await post('/api/v1/purchases',
      bill([line(inactiveCandidateId, 11000)], { correctionOf: original.body.data.id }));
    expect(attempt.status).toBe(400);
    expect(attempt.body.error.details.reason).toBe('PRODUCT_INACTIVE');
    expect(await snapshot()).toEqual(before);
    const detail = await api().get(`/api/v1/purchases/${original.body.data.id}`)
      .set(bearer(tokenA));
    expect(detail.status).toBe(200);
    expect(detail.body.data.status).toBe('POSTED');
  }, 60000);

  it('replays a previously posted operation after deactivation without new posting', async () => {
    const key = Ulid.generate(clock);
    const payload = bill([line(activeId)]);
    const first = await post('/api/v1/purchases', payload, key);
    expect(first.status).toBe(201);
    await makeInactive(activeId);
    const before = await snapshot();
    const retry = await post('/api/v1/purchases', payload, key);
    expect(retry.status).toBe(201);
    expect(retry.body.data.id).toBe(first.body.data.id);
    expect(await snapshot()).toEqual(before);
    const mismatched = await post('/api/v1/purchases',
      bill([line(activeId, 9000)]), key);
    expect(mismatched.status).toBe(409);
    expect(await snapshot()).toEqual(before);
  }, 60000);


  it('holds product status until purchase-first transaction commits', async () => {
    // A purchase which already locked its product may commit first. The
    // deactivation must WAIT, not silently commit ahead of that purchase.
    const admin = new Pool({ connectionString: ADMIN_URL, max: 3 });
    const locker = await admin.connect();
    let locked = false;
    let pendingPurchase: Promise<request.Response> | undefined;
    let pendingDeactivation: Promise<request.Response> | undefined;
    try {
      await locker.query('BEGIN');
      await locker.query('LOCK TABLE purchase_lines IN ACCESS EXCLUSIVE MODE');
      locked = true;
      pendingPurchase = post('/api/v1/purchases', bill([line(activeId)])).then(x => x);
      expect(await waitForPgLock(admin, 'purchase_lines'),
        'purchase must reach the post-validation line-insert barrier').toBe(true);

      let deactivated = false;
      pendingDeactivation = post(`/api/v1/products/${activeId}/status`,
        { status: 'INACTIVE' }).then(response => {
        deactivated = true;
        return response;
      });
      expect(await waitForPgLock(admin, 'products'),
        'deactivation must wait for the purchase-held product row').toBe(true);
      expect(deactivated, 'status cannot commit while purchase holds the product lock').toBe(false);

      await locker.query('COMMIT');
      locked = false;
      const posted = await pendingPurchase;
      expect(posted.status, JSON.stringify(posted.body)).toBe(201);
      const status = await pendingDeactivation;
      expect(status.status).toBe(200);
      expect(status.body.data.status).toBe('INACTIVE');
      const after = await snapshot();
      expect(after.purchases).toBe(1);
      expect(after.journals).toBe(1);
      expect(after.movements).toBe(1);
    } finally {
      if (locked) await locker.query('ROLLBACK');
      locker.release();
      if (pendingPurchase) await pendingPurchase.catch(() => undefined);
      if (pendingDeactivation) await pendingDeactivation.catch(() => undefined);
      await admin.end();
    }
  }, 120000);

  it('rejects after an in-flight product deactivation acquires the row first', async () => {
    // A held UPDATE models a product-status transaction before COMMIT.
    // The signed Nest purchase uses the tenant RLS role and must wait, then
    // observe INACTIVE at READ COMMITTED after the status transaction commits.
    const admin = new Pool({ connectionString: ADMIN_URL, max: 3 });
    const locker = await admin.connect();
    let locked = false;
    let pendingPurchase: Promise<request.Response> | undefined;
    try {
      await locker.query('BEGIN');
      locked = true;
      const updated = await locker.query(
        "UPDATE products SET status = 'INACTIVE' WHERE tenant_id = $1 AND id = $2",
        [a.tenantId, activeId]);
      expect(updated.rowCount).toBe(1);
      pendingPurchase = post('/api/v1/purchases', bill([line(activeId)])).then(x => x);
      expect(await waitForPgLock(admin, 'products'),
        'purchase must wait for the uncommitted product status change').toBe(true);
      expect((await snapshot()).purchases).toBe(0);

      await locker.query('COMMIT');
      locked = false;
      const rejected = await pendingPurchase;
      expect(rejected.status).toBe(400);
      expect(rejected.body.error).toMatchObject({
        code: 'VALIDATION_FAILED',
        details: { reason: 'PRODUCT_INACTIVE', productId: activeId },
      });
      const after = await snapshot();
      expect(after.purchases).toBe(0);
      expect(after.journals).toBe(0);
      expect(after.movements).toBe(0);
      expect(after.lots).toBe(0);
      expect(after.payments).toBe(0);
    } finally {
      if (locked) await locker.query('ROLLBACK');
      locker.release();
      if (pendingPurchase) await pendingPurchase.catch(() => undefined);
      await admin.end();
    }
  }, 120000);

  it('locks unique products in fixed order under opposite-order duplicate-line carts', async () => {
    const left = bill([line(activeId), line(inactiveCandidateId), line(activeId)]);
    const right = bill([line(inactiveCandidateId), line(activeId)]);
    const results = await Promise.all([
      post('/api/v1/purchases', left),
      post('/api/v1/purchases', right),
    ]);
    expect(results.map(x => x.status)).toEqual([201, 201]);
    const after = await snapshot();
    expect(after.purchases).toBe(2);
    expect(after.journals).toBe(2);
    expect(after.movements).toBe(5);
    expect(after.lots).toBe(5);
  }, 120000);

});
