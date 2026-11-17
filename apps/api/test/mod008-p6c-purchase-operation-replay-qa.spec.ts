/*
 * MOD-008 P6C: full purchase-operation replay identity, RED-first QA.
 * Scope: this new file only; no production purchase, schema, UI or migration edits.
 * Test is opt-in and can only touch its own label-checked disposable PG16.
 *
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

const DB_NAME = 'hisabiq-mod008-p6c-172-pg16';
const DB_LABEL = 'mod008-p6c-172';
const DB_PORT = 55685;
const APP_URL = 'postgres://sher_app:sher_app_test@127.0.0.1:' + DB_PORT + '/sher_test';
const ADMIN_URL = 'postgres://postgres:dev@127.0.0.1:' + DB_PORT + '/sher_test';
const clock = new SystemClock();
const permissions = [
  Permission.PURCHASE_CREATE, Permission.PURCHASE_VIEW, Permission.PURCHASE_EDIT,
  Permission.PRODUCT_VIEW, Permission.PRODUCT_CREATE, Permission.PRODUCT_EDIT,
  Permission.PRODUCT_DEACTIVATE, Permission.UNIT_MANAGE, Permission.SUPPLIER_VIEW,
  Permission.SUPPLIER_CREATE, Permission.COST_VIEW,
];

let app: INestApplication;
let pool: pg.Pool;
let tenantA: SeededTenant;
let tokenA: string;
let supplierId: string;
let productId: string;

function assertDisposable(): void {
  const required = {
    DATABASE_URL: APP_URL,
    TEST_DATABASE_URL: APP_URL,
    ADMIN_DATABASE_URL: ADMIN_URL,
    JWT_SECRET: TEST_JWT_SECRET,
    HISABIQ_P6C_DISPOSABLE_ACK: 'isolated-pg16-only',
  };
  for (const [name, value] of Object.entries(required)) {
    if (process.env[name] !== value) {
      throw Error('P6C disposable PostgreSQL/secret guard failed: ' + name);
    }
  }
  const result = spawnSync('podman', [
    'inspect', '--format', '{{index .Config.Labels "hisabiq.qa"}}|{{.State.Running}}',
    DB_NAME,
  ], { encoding: 'utf8' });
  if (result.status !== 0 || result.stdout.trim() !== DB_LABEL + '|true') {
    throw Error('P6C task-owned PostgreSQL container label/running check failed');
  }
}

const api = () => request(app.getHttpServer());
const auth = (token: string) => ({ Authorization: 'Bearer ' + token });
const post = (route: string, payload: object, key = Ulid.generate(clock), token = tokenA) =>
  api().post(route).set(auth(token)).set('Idempotency-Key', key).send(payload);

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    supplierPartyId: supplierId,
    lines: [{ productId, qty: 1000, unitPriceMinor: 10000 }],
    discountMinor: 0,
    paidMinor: 0,
    paidAccountCode: null,
    ...overrides,
  };
}

/** Count actual tenant-scoped business and audit rows, never HTTP totals alone. */
async function snapshot(tenantId = tenantA.tenantId) {
  return asTenant(pool, tenantId, async db => {
    const result = await db.query(
      'SELECT ' +
      '(SELECT count(*)::int FROM purchases) AS purchases, ' +
      '(SELECT count(*)::int FROM purchase_lines) AS purchase_lines, ' +
      '(SELECT count(*)::int FROM journal_entries) AS journals, ' +
      '(SELECT count(*)::int FROM journal_lines) AS journal_lines, ' +
      '(SELECT count(*)::int FROM stock_movements) AS movements, ' +
      '(SELECT count(*)::int FROM inventory_lots) AS lots, ' +
      '(SELECT count(*)::int FROM supplier_payments) AS payments, ' +
      '(SELECT count(*)::int FROM audit_events) AS audits, ' +
      '(SELECT count(*)::int FROM outbox) AS outbox, ' +
      '(SELECT count(*)::int FROM idempotency_keys) AS idempotency_keys, ' +
      "(SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'status', status, 'version', version) ORDER BY id), '[]'::jsonb) FROM purchases) AS bills"
    );
    return result.rows[0];
  });
}

async function seedSources(token: string, label: string) {
  const unit = await post('/api/v1/catalog/units', { name: 'Pieces ' + label }, undefined, token);
  expect(unit.status, JSON.stringify(unit.body)).toBe(201);
  const baseUnitId = unit.body.data.units[0].id as string;
  const product = await post('/api/v1/products', {
    name: 'P6C Product ' + label, baseUnitId,
    purchasePriceMinor: 10000, sellingPriceMinor: 12000, minStockQty: 0,
    brandId: null, categoryId: null, sku: null, barcode: null, description: null,
    defaultDiscountType: null, defaultDiscountValue: null, offerEnabled: false,
    offerPriceMinor: null, offerStartDate: null, offerEndDate: null,
    tracksExpiry: false, tracksSerial: false,
    conversionUnitId: null, conversionFactorQty: null,
  }, undefined, token);
  expect(product.status, JSON.stringify(product.body)).toBe(201);
  const supplier = await post('/api/v1/parties', {
    name: 'P6C Supplier ' + label, roles: ['SUPPLIER'],
    phone: null, address: null, guardianName: null,
    nid: null, email: null, notes: null,
    customerGroupId: null, creditLimitMinor: null,
  }, undefined, token);
  expect(supplier.status, JSON.stringify(supplier.body)).toBe(201);
  return { productId: product.body.data.id as string, supplierId: supplier.body.data.id as string };
}

async function firstPost(key: string, payload = body()) {
  const result = await post('/api/v1/purchases', payload, key);
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  return result;
}

async function assertKeyRejected(key: string, modified: object) {
  const before = await snapshot();
  const response = await post('/api/v1/purchases', modified, key);
  // RED-first: current service misses source-metadata fingerprint fields.
  expect(response.status, JSON.stringify(response.body)).toBe(409);
  expect(response.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  expect(await snapshot()).toEqual(before);
}

const gated = process.env.HISABIQ_P6C_DISPOSABLE_ACK === 'isolated-pg16-only'
  ? describe : describe.skip;

gated('MOD-008 P6C purchase operation replay identity (real signed Nest + RLS PG16)', () => {
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
    tenantA = await seedTenant(pool, { name: 'P6C shop A', permissions });
    tokenA = signToken(tenantA, TEST_JWT_SECRET);
    const sources = await seedSources(tokenA, 'A');
    productId = sources.productId;
    supplierId = sources.supplierId;
  }, 60000);

  it('replays an identical operation without duplicate stock, AP, audit or outbox', async () => {
    const key = Ulid.generate(clock);
    const payload = body({ supplierBillRef: 'INV-A', notes: 'Original note' });
    const first = await firstPost(key, payload);
    const before = await snapshot();
    const retry = await post('/api/v1/purchases', payload, key);
    expect(retry.status, JSON.stringify(retry.body)).toBe(201);
    expect(retry.body.data.id).toBe(first.body.data.id);
    expect(await snapshot()).toEqual(before);
  });

  it('refuses same-key reuse with a different supplier bill reference', async () => {
    const key = Ulid.generate(clock);
    await firstPost(key, body({ supplierBillRef: 'INV-1001' }));
    await assertKeyRejected(key, body({ supplierBillRef: 'INV-1002' }));
  });

  it('refuses same-key reuse with different notes', async () => {
    const key = Ulid.generate(clock);
    await firstPost(key, body({ notes: 'Received in full' }));
    await assertKeyRejected(key, body({ notes: 'Damaged packaging' }));
  });

  it('refuses same-key reuse that changes an ordinary purchase into a correction', async () => {
    const key = Ulid.generate(clock);
    const first = await firstPost(key);
    await assertKeyRejected(key, body({ correctionOf: first.body.data.id }));
  });

  it('refuses same-key reuse with a different supplier-order source ID', async () => {
    // The source differs but is shape-valid. A separate test must validate
    // full supplier-order conversion using a real open source fixture.
    const key = Ulid.generate(clock);
    await firstPost(key);
    await assertKeyRejected(key, body({ supplierOrderId: Ulid.generate(clock) }));
  });

  it('retains mismatch protection for an already-fingerprinted price change', async () => {
    const key = Ulid.generate(clock);
    await firstPost(key);
    await assertKeyRejected(key, body({
      lines: [{ productId, qty: 1000, unitPriceMinor: 11000 }],
    }));
  });

  it('replays exact purchase after response-cache pruning without a second posting', async () => {
    const key = Ulid.generate(clock);
    const payload = body({ supplierBillRef: 'INV-KEEP' });
    const first = await firstPost(key, payload);
    const count = await asTenant(pool, tenantA.tenantId, db =>
      db.query('DELETE FROM idempotency_keys WHERE tenant_id = $1 AND operation_id = $2',
        [tenantA.tenantId, key]));
    expect(count.rowCount).toBe(1);
    const before = await snapshot();
    const retry = await post('/api/v1/purchases', payload, key);
    expect(retry.status, JSON.stringify(retry.body)).toBe(201);
    expect(retry.body.data.id).toBe(first.body.data.id);
    expect(await snapshot()).toEqual(before);
  });

  it('refuses changed payload after response-cache pruning, preserving durable identity', async () => {
    const key = Ulid.generate(clock);
    await firstPost(key, body({ supplierBillRef: 'INV-OLD' }));
    const deleted = await asTenant(pool, tenantA.tenantId, db =>
      db.query('DELETE FROM idempotency_keys WHERE tenant_id = $1 AND operation_id = $2',
        [tenantA.tenantId, key]));
    expect(deleted.rowCount).toBe(1);
    await assertKeyRejected(key, body({ supplierBillRef: 'INV-CHANGED' }));
  });

  it('isolates equal operation keys between tenants with real distinct source records', async () => {
    const key = Ulid.generate(clock);
    const first = await firstPost(key);
    const beforeA = await snapshot();
    const tenantB = await seedTenant(pool, { name: 'P6C shop B', permissions });
    const tokenB = signToken(tenantB, TEST_JWT_SECRET);
    const sourcesB = await seedSources(tokenB, 'B');
    const payloadB = {
      supplierPartyId: sourcesB.supplierId,
      lines: [{ productId: sourcesB.productId, qty: 1000, unitPriceMinor: 10000 }],
      discountMinor: 0, paidMinor: 0, paidAccountCode: null,
    };
    const second = await post('/api/v1/purchases', payloadB, key, tokenB);
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect(second.body.data.id).not.toBe(first.body.data.id);
    expect(await snapshot()).toEqual(beforeA);
    const tenantBRows = await snapshot(tenantB.tenantId);
    expect(tenantBRows.purchases).toBe(1);
    const unauthorized = await api().get('/api/v1/purchases/' + first.body.data.id)
      .set(auth(tokenB));
    expect([403, 404]).toContain(unauthorized.status);
  });
});
