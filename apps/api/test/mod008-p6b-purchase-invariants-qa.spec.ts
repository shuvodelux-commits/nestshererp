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

const DB_PORT = 55683;
const DB_NAME = 'hisabiq-mod008-p6b-pg16';
const DB_LABEL = 'mod008-p6b-147';
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
  const existingUnit = (await api().get('/api/v1/catalog/units').set(bearer(tokenA)));
  expect(existingUnit.status).toBe(200);
  const unitId = existingUnit.body.data.units[0].id as string;
  const response = await post('/api/v1/products', {
    name, baseUnitId: unitId, purchasePriceMinor: 10000,
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

  it('serializes deactivation committed during an in-flight purchase, failing closed', async () => {
    // Hold the later purchase_lines INSERT, not the earlier product status SELECT.
    // This makes the interleaving observable, not timing dependent.
    const admin = new Pool({ connectionString: ADMIN_URL, max: 3 });
    const locker = await admin.connect();
    let locked = false;
    let pending: Promise<request.Response> | undefined;
    try {
      await locker.query('BEGIN');
      await locker.query('LOCK TABLE purchase_lines IN ACCESS EXCLUSIVE MODE');
      locked = true;
      pending = post('/api/v1/purchases', bill([line(activeId)])).then(x => x);
      let waiting = false;
      for (let i = 0; i < 240; i++) {
        const response = await admin.query<{ n: number }>(`
          SELECT count(*)::int AS n FROM pg_locks l
          JOIN pg_class c ON c.oid = l.relation
          WHERE c.relname='purchase_lines' AND l.granted=false`);
        if (Number(response.rows[0]?.n ?? 0) > 0) {
          waiting = true;
          break;
        }
        await new Promise<void>(resolve => setTimeout(resolve, 50));
      }
      expect(waiting, 'purchase must reach the post-validation purchase_lines lock').toBe(true);
      await makeInactive(activeId);
      const beforeRelease = await snapshot();
      expect(beforeRelease.purchases).toBe(0);
      await locker.query('COMMIT');
      locked = false;
      const result = await pending;
      expect(result.status, 'a purchase should fail after the source was deactivated')
        .toBe(400);
      expect(result.body.error.details.reason).toBe('PRODUCT_INACTIVE');
      expect((await snapshot()).purchases).toBe(0);
    } finally {
      if (locked) await locker.query('ROLLBACK');
      locker.release();
      if (pending !== undefined) await pending.catch(() => undefined);
      await admin.end();
    }
  }, 120000);
});
