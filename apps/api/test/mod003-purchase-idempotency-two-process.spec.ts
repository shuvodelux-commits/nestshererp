/*
 * MOD-003 #184 / C003-12: the same PURCHASE operation across independent
 * Nest processes. Real non-owner PG16 RLS, tenant-scoped durable identity,
 * exact replay vs changed financial intent, and no multiplied stock/AP.
 * Test-only: do not touch production posting or frontend code.
 */
import 'reflect-metadata';

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Permission } from '@sher/core-contracts';
import { SystemClock, Ulid } from '@sher/shared-utils';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { AppErrorFilter } from '../src/common/app-error.filter';
import { signToken, TEST_JWT_SECRET } from './support/auth';
import type { SeededTenant } from './support/database';
import { asTenant, prepareTestDatabase, resetDatabase, seedTenant, testPool, todayIn } from './support/database';
import { assertGoldenInvariants } from './support/invariants';

const clock = new SystemClock();
let app: INestApplication;
let pool: pg.Pool;
let tenant: SeededTenant;
let token: string;
let productId: string;
let supplierId: string;

interface ApiProcess {
  readonly child: ChildProcess;
  readonly port: number;
}

function enforceDisposableTestDatabase(): void {
  const raw = process.env['DATABASE_URL'];
  const admin = process.env['ADMIN_DATABASE_URL'];
  if (!raw || !admin) throw new Error('Only an explicitly configured disposable database is supported');
  const runtimeUrl = new URL(raw);
  const adminUrl = new URL(admin);
  if (runtimeUrl.username !== 'sher_app' ||
      adminUrl.username !== 'postgres' ||
      runtimeUrl.pathname !== '/sher_test' ||
      adminUrl.pathname !== '/sher_test' ||
      !['localhost', '127.0.0.1'].includes(runtimeUrl.hostname) ||
      !['localhost', '127.0.0.1'].includes(adminUrl.hostname)) {
    throw new Error('Refusing to run inventory race tests outside isolated non-owner local sher_test');
  }
}

async function availablePort(): Promise<number> {
  return new Promise<number>((done, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const address = s.address();
      if (address === null || typeof address === 'string') {
        s.close();
        fail(new Error('Could not reserve loopback test port'));
      } else {
        s.close((error) => error === undefined ? done(address.port) : fail(error));
      }
    });
  });
}

async function stopApi(server: ApiProcess): Promise<void> {
  if (server.child.exitCode !== null || server.child.signalCode !== null) return;
  const exited = new Promise<void>((done) => server.child.once('exit', () => done()));
  server.child.kill('SIGTERM');
  await Promise.race([exited, new Promise<void>((done) => setTimeout(done, 2000))]);
  if (server.child.exitCode === null && server.child.signalCode === null) {
    server.child.kill('SIGKILL');
    await exited;
  }
}

async function startApi(): Promise<ApiProcess> {
  enforceDisposableTestDatabase();
  const entry = resolve(__dirname, '../dist/main.js');
  if (!existsSync(entry)) throw new Error('Compile the Nest API before cross-process QA');
  const port = await availablePort();
  const child = spawn(process.execPath, [entry], {
    cwd: resolve(__dirname, '..'),
    env: {
      ...process.env,
      DATABASE_URL: process.env['DATABASE_URL'],
      JWT_SECRET: TEST_JWT_SECRET,
      ENTITLEMENT_SOURCE: 'subscription',
      NODE_ENV: 'test',
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', () => {});
  child.stderr?.on('data', () => {});
  const server = { child, port };
  try {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error('Nest test process exited before readiness');
      }
      try {
        const response = await fetch('http://127.0.0.1:' + port + '/health', {
          signal: AbortSignal.timeout(800),
        });
        if (response.status === 200) return server;
      } catch {
        // The process has not bound its port yet.
      }
      await new Promise<void>((done) => setTimeout(done, 100));
    }
    throw new Error('Nest test process health timeout');
  } catch (error) {
    await stopApi(server);
    throw error;
  }
}

async function post(
  server: ApiProcess,
  path: string,
  body: Record<string, unknown>,
  key = Ulid.generate(clock),
  bearer = token,
): Promise<{ status: number; data: unknown; error?: unknown }> {
  const response = await fetch('http://127.0.0.1:' + server.port + path, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + bearer,
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const json = await response.json() as { data?: unknown; error?: unknown };
  return { status: response.status, data: json.data, error: json.error };
}



interface Fixture {
  readonly productId: string;
  readonly supplierId: string;
}
interface Snapshot {
  readonly purchases: number;
  readonly lines: number;
  readonly movements: number;
  readonly journals: number;
  readonly audits: number;
  readonly events: number;
  readonly qty: number;
  readonly lotQty: number;
  readonly inventoryMinor: number;
  readonly payableMinor: number;
}
function creditPurchase(product: string, supplier: string, qty = 7_000) {
  // An unpaid purchase creates AP, INVENTORY and owned stock; no cash session.
  return {
    supplierPartyId: supplier,
    lines: [{ productId: product, qty, unitPriceMinor: 10_000 }],
    discountMinor: 0,
    paidMinor: 0,
    paidAccountCode: null,
  };
}

async function makeFixture(bearer: string, suffix: string): Promise<Fixture> {
  const unit = await request(app.getHttpServer()).post('/api/v1/catalog/units')
    .set('Authorization', 'Bearer ' + bearer)
    .send({ name: 'Piece' });
  expect(unit.status, JSON.stringify(unit.body)).toBe(201);
  const product = await request(app.getHttpServer()).post('/api/v1/products')
    .set('Authorization', 'Bearer ' + bearer)
    .set('Idempotency-Key', Ulid.generate(clock))
    .send({
      name: 'Purchase Replay Bolt ' + suffix,
      baseUnitId: unit.body.data.units[0].id as string,
      purchasePriceMinor: 10_000, sellingPriceMinor: 12_000, minStockQty: 0,
      brandId: null, categoryId: null, sku: null, barcode: null,
      description: null, defaultDiscountType: null, defaultDiscountValue: null,
      offerEnabled: false, offerPriceMinor: null, offerStartDate: null,
      offerEndDate: null, tracksExpiry: false, tracksSerial: false,
      conversionUnitId: null, conversionFactorQty: null,
    });
  expect(product.status, JSON.stringify(product.body)).toBe(201);
  const supplier = await request(app.getHttpServer()).post('/api/v1/parties')
    .set('Authorization', 'Bearer ' + bearer)
    .set('Idempotency-Key', Ulid.generate(clock))
    .send({
      name: 'Supplier ' + suffix, roles: ['SUPPLIER'],
      phone: suffix === 'A' ? '01812345678' : '01812345679',
      address: null, guardianName: null, nid: null, email: null, notes: null,
      customerGroupId: null, creditLimitMinor: null,
    });
  expect(supplier.status, JSON.stringify(supplier.body)).toBe(201);
  return {
    productId: product.body.data.id as string,
    supplierId: supplier.body.data.id as string,
  };
}

async function snapshot(tenantId: string, f: Fixture): Promise<Snapshot> {
  const result = await asTenant(pool, tenantId, (db) => db.query([
    'SELECT',
    '(SELECT count(*)::integer FROM purchases WHERE supplier_party_id = $2) AS purchases,',
    '(SELECT count(*)::integer FROM purchase_lines WHERE product_id = $1) AS lines,',
    "(SELECT count(*)::integer FROM stock_movements WHERE product_id = $1 AND source_document_type = 'PURCHASE') AS movements,",
    "(SELECT count(*)::integer FROM journal_entries WHERE source_document_type = 'PURCHASE') AS journals,",
    "(SELECT count(*)::integer FROM audit_events WHERE entity_type = 'purchase') AS audits,",
    "(SELECT count(*)::integer FROM outbox WHERE event_type = 'purchase.recorded') AS events,",
    '(SELECT COALESCE(SUM(qty_on_hand), 0)::integer FROM product_cost_state WHERE product_id = $1) AS qty,',
    "(SELECT COALESCE(SUM(qty_remaining), 0)::integer FROM inventory_lots WHERE product_id = $1 AND owner_type = 'OWNED') AS \"lotQty\",",
    "(SELECT COALESCE(SUM(amount_minor), 0)::integer FROM journal_lines WHERE account_code = 'INVENTORY') AS \"inventoryMinor\",",
    "(SELECT COALESCE(SUM(amount_minor), 0)::integer FROM journal_lines WHERE account_code = 'AP' AND party_id = $2) AS \"payableMinor\"",
  ].join(' '), [f.productId, f.supplierId]));
  const row = result.rows[0];
  if (!row) throw new Error('No non-owner purchase inventory snapshot');
  return {
    purchases: Number(row.purchases),
    lines: Number(row.lines),
    movements: Number(row.movements),
    journals: Number(row.journals),
    audits: Number(row.audits),
    events: Number(row.events),
    qty: Number(row.qty),
    lotQty: Number(row.lotQty),
    inventoryMinor: Number(row.inventoryMinor),
    payableMinor: Number(row.payableMinor),
  };
}
async function expectOnce(tenantId: string, f: Fixture, bearer = token): Promise<void> {
  expect(await snapshot(tenantId, f)).toEqual({
    purchases: 1, lines: 1, movements: 1, journals: 1, audits: 1,
    events: 1, qty: 7_000, lotQty: 7_000,
    inventoryMinor: 70_000, payableMinor: -70_000,
  });
  const valuation = await request(app.getHttpServer())
    .get('/api/v1/inventory/valuation')
    .set('Authorization', 'Bearer ' + bearer);
  expect(valuation.status).toBe(200);
  expect(valuation.body.data).toMatchObject({
    rows: [expect.objectContaining({ productId: f.productId, qtyOnHand: 7_000, valueMinor: 70_000 })],
    totalValueMinor: 70_000, inventoryAccountMinor: 70_000,
    differenceMinor: 0, reconciled: true,
  });
}

beforeAll(async () => {
  enforceDisposableTestDatabase();
  pool = testPool();
  await prepareTestDatabase();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.useGlobalFilters(new AppErrorFilter());
  await app.init();
});
afterAll(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
});
beforeEach(async () => {
  await resetDatabase(pool);
  tenant = await seedTenant(pool, {
    name: 'MOD003 Purchase Operation Identity',
    permissions: [
      Permission.PRODUCT_VIEW, Permission.PRODUCT_CREATE, Permission.PRODUCT_EDIT,
      Permission.UNIT_MANAGE, Permission.COST_VIEW, Permission.INVENTORY_LOT_VIEW,
      Permission.PURCHASE_CREATE, Permission.PURCHASE_VIEW,
      Permission.SUPPLIER_VIEW, Permission.SUPPLIER_CREATE,
    ],
  });
  token = signToken(tenant, TEST_JWT_SECRET);
  const f = await makeFixture(token, 'A');
  productId = f.productId;
  supplierId = f.supplierId;
});
afterEach(async () => {
  await assertGoldenInvariants(pool, tenant.tenantId);
});

describe('MOD-003 #184: durable purchase operation identity across two Nest processes', () => {
  it('serializes two concurrent exact-key credit purchases into one stock and AP posting', async () => {
    const children: ApiProcess[] = [];
    try {
      children.push(await startApi(), await startApi());
      const [a, b] = children as [ApiProcess, ApiProcess];
      expect(a.child.pid).not.toBe(b.child.pid);
      const key = Ulid.generate(clock);
      const body = creditPurchase(productId, supplierId);
      const [first, second] = await Promise.all([
        post(a, '/api/v1/purchases', body, key),
        post(b, '/api/v1/purchases', body, key),
      ]);
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.data).toEqual(first.data);
      await expectOnce(tenant.tenantId, { productId, supplierId });
    } finally {
      await Promise.all(children.map(stopApi));
    }
  }, 90_000);

  it('rejects changed quantity or price under the same operation identity without modifying stock/AP', async () => {
    const children: ApiProcess[] = [];
    try {
      children.push(await startApi(), await startApi());
      const [a, b] = children as [ApiProcess, ApiProcess];
      const key = Ulid.generate(clock);
      const body = creditPurchase(productId, supplierId);
      const first = await post(a, '/api/v1/purchases', body, key);
      expect(first.status).toBe(201);
      const changedQty = await post(b, '/api/v1/purchases', creditPurchase(productId, supplierId, 8_000), key);
      const changedPrice = await post(b, '/api/v1/purchases', {
        ...body,
        lines: [{ productId, qty: 7_000, unitPriceMinor: 11_000 }],
      }, key);
      for (const rejected of [changedQty, changedPrice]) {
        expect(rejected.status).toBe(409);
        expect(rejected.error).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
      }
      const replay = await post(b, '/api/v1/purchases', body, key);
      expect(replay.status).toBe(201);
      expect(replay.data).toEqual(first.data);
      await expectOnce(tenant.tenantId, { productId, supplierId });
    } finally {
      await Promise.all(children.map(stopApi));
    }
  }, 90_000);

  it('isolates the same operation ID across two tenants and denies foreign product access', async () => {
    const other = await seedTenant(pool, {
      name: 'Independent second supplier shop', permissions: [
        Permission.PRODUCT_VIEW, Permission.PRODUCT_CREATE, Permission.PRODUCT_EDIT,
        Permission.UNIT_MANAGE, Permission.COST_VIEW, Permission.INVENTORY_LOT_VIEW,
        Permission.PURCHASE_CREATE, Permission.PURCHASE_VIEW,
        Permission.SUPPLIER_VIEW, Permission.SUPPLIER_CREATE,
      ],
    });
    const otherToken = signToken(other, TEST_JWT_SECRET);
    const f2 = await makeFixture(otherToken, 'B');
    const f1 = { productId, supplierId };
    const children: ApiProcess[] = [];
    try {
      children.push(await startApi(), await startApi());
      const [a, b] = children as [ApiProcess, ApiProcess];
      const sharedKey = Ulid.generate(clock);
      const [one, two] = await Promise.all([
        post(a, '/api/v1/purchases', creditPurchase(f1.productId, f1.supplierId), sharedKey, token),
        post(b, '/api/v1/purchases', creditPurchase(f2.productId, f2.supplierId), sharedKey, otherToken),
      ]);
      expect(one.status).toBe(201);
      expect(two.status).toBe(201);
      expect(one.data).not.toEqual(two.data);
      await expectOnce(tenant.tenantId, f1);
      await expectOnce(other.tenantId, f2, otherToken);
      await assertGoldenInvariants(pool, other.tenantId);
      const foreign = await fetch('http://127.0.0.1:' + b.port + '/api/v1/products/' + productId, {
        headers: { Authorization: 'Bearer ' + otherToken },
      });
      expect([403, 404]).toContain(foreign.status);
      await expectOnce(tenant.tenantId, f1);
      await expectOnce(other.tenantId, f2, otherToken);
    } finally {
      await Promise.all(children.map(stopApi));
    }
  }, 90_000);
});
