/*
 * MOD-003 C003-06: historical late landed cost versus posted stock adjustment.
 * Source-linked, real two-Nest-process / PG16 non-owner RLS accounting QA.
 * RED outcomes are documented; no source code is altered in this test PR.
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
let purchaseId: string;

interface ApiProcess {
  readonly child: ChildProcess;
  readonly port: number;
  readonly logs: string[];
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
  const logs: string[] = [];
  const capture = (chunk: Buffer) => {
    logs.push(chunk.toString());
    if (logs.length > 120) logs.shift();
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  const server = { child, port, logs };
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
): Promise<{ status: number; data: unknown }> {
  const response = await fetch('http://127.0.0.1:' + server.port + path, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const json = await response.json() as { data?: unknown; error?: unknown };
  if (response.status >= 500) {
    // Keep the actual Nest exception in RED QA evidence. Never whitelist 500.
    console.error('C003-06 server error', JSON.stringify(json.error),
      server.logs.slice(-35).join('').slice(-9000));
  }
  return { status: response.status, data: json.data };
}


interface InventorySourceSnapshot {
  readonly landed: number;
  readonly adjustments: number;
  readonly adjustmentMovements: number;
  readonly qty: number;
  readonly lotQty: number;
  readonly inventoryMinor: number;
  readonly landedAudits: number;
  readonly adjustmentAudits: number;
  readonly landedEvents: number;
  readonly adjustmentEvents: number;
}

async function snapshot(): Promise<InventorySourceSnapshot> {
  const x = await asTenant(pool, tenant.tenantId, (db) => db.query([
    'SELECT',
    '(SELECT count(*)::integer FROM purchase_landed_costs WHERE purchase_id = $2) AS landed,',
    '(SELECT count(*)::integer FROM stock_adjustments WHERE product_id = $1) AS adjustments,',
    "(SELECT count(*)::integer FROM stock_movements WHERE product_id = $1 AND source_document_type = 'STOCK_ADJUSTMENT') AS \"adjustmentMovements\",",
    '(SELECT COALESCE(sum(qty_on_hand),0)::integer FROM product_cost_state WHERE product_id = $1) AS qty,',
    "(SELECT COALESCE(sum(qty_remaining),0)::integer FROM inventory_lots WHERE product_id = $1 AND owner_type = 'OWNED') AS \"lotQty\",",
    "(SELECT COALESCE(sum(amount_minor),0)::integer FROM journal_lines WHERE account_code = 'INVENTORY') AS \"inventoryMinor\",",
    "(SELECT count(*)::integer FROM audit_events WHERE entity_type = 'purchase_landed_cost') AS \"landedAudits\",",
    "(SELECT count(*)::integer FROM audit_events WHERE entity_type = 'stock_adjustment') AS \"adjustmentAudits\",",
    "(SELECT count(*)::integer FROM outbox WHERE event_type = 'purchase.landed_cost.added') AS \"landedEvents\",",
    "(SELECT count(*)::integer FROM outbox WHERE event_type = 'inventory.stock-adjusted') AS \"adjustmentEvents\"",
  ].join(' '), [productId, purchaseId]));
  const row = x.rows[0];
  if (!row) throw new Error('No PostgreSQL inventory snapshot');
  return {
    landed: Number(row.landed),
    adjustments: Number(row.adjustments),
    adjustmentMovements: Number(row.adjustmentMovements),
    qty: Number(row.qty),
    lotQty: Number(row.lotQty),
    inventoryMinor: Number(row.inventoryMinor),
    landedAudits: Number(row.landedAudits),
    adjustmentAudits: Number(row.adjustmentAudits),
    landedEvents: Number(row.landedEvents),
    adjustmentEvents: Number(row.adjustmentEvents),
  };
}

async function assertValuation(qty: number, valueMinor: number): Promise<void> {
  const check = async (method: 'FIFO' | 'AVERAGE') => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/inventory/valuation')
      .set('Authorization', 'Bearer ' + token);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      method,
      rows: [expect.objectContaining({ productId, qtyOnHand: qty, valueMinor })],
      totalValueMinor: valueMinor,
      inventoryAccountMinor: valueMinor,
      differenceMinor: 0,
      reconciled: true,
    });
  };
  await check('FIFO');
  await asTenant(pool, tenant.tenantId, (db) => db.query([
    'INSERT INTO settings',
    '(id, tenant_id, setting_key, value, created_at, updated_at, created_by, updated_by, version)',
    "VALUES ($1, $2, 'sale_costing_method', 'AVERAGE', now(), now(), $3, $3, 1)",
  ].join(' '), [Ulid.generate(clock), tenant.tenantId, tenant.userId]));
  await check('AVERAGE');
}

beforeAll(async () => {
  enforceDisposableTestDatabase();
  pool = testPool();
  await prepareTestDatabase();
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication();
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
    name: 'MOD003 Late Freight Race',
    permissions: [
      Permission.PURCHASE_CREATE, Permission.PURCHASE_VIEW, Permission.PURCHASE_EDIT,
      Permission.PRODUCT_VIEW, Permission.PRODUCT_CREATE, Permission.PRODUCT_EDIT,
      Permission.UNIT_MANAGE, Permission.COST_VIEW, Permission.INVENTORY_LOT_VIEW,
      Permission.SUPPLIER_VIEW, Permission.SUPPLIER_CREATE,
    ],
  });
  token = signToken(tenant, TEST_JWT_SECRET);

  const unit = await request(app.getHttpServer())
    .post('/api/v1/catalog/units')
    .set('Authorization', 'Bearer ' + token)
    .send({ name: 'Piece' });
  expect(unit.status, JSON.stringify(unit.body)).toBe(201);

  const product = await request(app.getHttpServer())
    .post('/api/v1/products')
    .set('Authorization', 'Bearer ' + token)
    .set('Idempotency-Key', Ulid.generate(clock))
    .send({
      name: 'Freight Cost Bolt',
      baseUnitId: unit.body.data.units[0].id as string,
      purchasePriceMinor: 10_000, sellingPriceMinor: 12_000, minStockQty: 0,
      brandId: null, categoryId: null, sku: null, barcode: null, description: null,
      defaultDiscountType: null, defaultDiscountValue: null,
      offerEnabled: false, offerPriceMinor: null, offerStartDate: null,
      offerEndDate: null, tracksExpiry: false, tracksSerial: false,
      conversionUnitId: null, conversionFactorQty: null,
    });
  expect(product.status, JSON.stringify(product.body)).toBe(201);
  productId = product.body.data.id as string;

  const supplier = await request(app.getHttpServer())
    .post('/api/v1/parties')
    .set('Authorization', 'Bearer ' + token)
    .set('Idempotency-Key', Ulid.generate(clock))
    .send({
      name: 'Test Freight Supplier', roles: ['SUPPLIER'], phone: '01812345678',
      address: null, guardianName: null, nid: null, email: null,
      notes: null, customerGroupId: null, creditLimitMinor: null,
    });
  expect(supplier.status, JSON.stringify(supplier.body)).toBe(201);

  const purchase = await request(app.getHttpServer())
    .post('/api/v1/purchases')
    .set('Authorization', 'Bearer ' + token)
    .set('Idempotency-Key', Ulid.generate(clock))
    .send({
      supplierPartyId: supplier.body.data.id as string,
      lines: [{ productId, qty: 10_000, unitPriceMinor: 10_000 }],
      discountMinor: 0, paidMinor: 0, paidAccountCode: null,
    });
  expect(purchase.status, JSON.stringify(purchase.body)).toBe(201);
  purchaseId = purchase.body.data.id as string;
});

afterEach(async () => {
  await assertGoldenInvariants(pool, tenant.tenantId);
});

describe('MOD-003 C003-06 landed freight vs stock adjustment consistency', () => {
  const lateFreight = (server: ApiProcess) => post(
    server,
    '/api/v1/purchases/' + purchaseId + '/landed-costs',
    {
      category: 'TRANSPORT',
      method: 'BY_VALUE',
      amountMinor: 20_000,
      paidAccountCode: null,
      note: null,
      description: 'Freight billed after the goods arrived',
      manualAllocations: [],
      businessDate: todayIn(tenant.timezone),
    },
  );
  const writeOff = (server: ApiProcess) => post(
    server, '/api/v1/inventory/adjustments', {
      productId, qtyDelta: -3_000, reason: 'DAMAGE',
      note: null, businessDate: todayIn(tenant.timezone),
    },
  );

  async function assertAccepted(landed: number, adjusted: number): Promise<void> {
    const qty = 10_000 - adjusted * 3_000;
    const value = landed === 1
      ? (adjusted === 1 ? 84_000 : 120_000)
      : (adjusted === 1 ? 70_000 : 100_000);
    expect(await snapshot()).toEqual({
      landed,
      adjustments: adjusted,
      adjustmentMovements: adjusted,
      qty,
      lotQty: qty,
      inventoryMinor: value,
      landedAudits: landed,
      adjustmentAudits: adjusted,
      landedEvents: landed,
      adjustmentEvents: adjusted,
    });
    await assertValuation(qty, value);
  }

  it('keeps value after late freight then damage is written off', async () => {
    const children: ApiProcess[] = [];
    try {
      children.push(await startApi());
      const first = children[0];
      if (!first) throw new Error('Missing isolated Nest process');
      expect((await lateFreight(first)).status).toBe(201);
      expect((await writeOff(first)).status).toBe(201);
      await assertAccepted(1, 1);
    } finally {
      await Promise.all(children.map(stopApi));
    }
  }, 90000);

  it('keeps value after damage then late freight is booked', async () => {
    const children: ApiProcess[] = [];
    try {
      children.push(await startApi());
      const first = children[0];
      if (!first) throw new Error('Missing isolated Nest process');
      expect((await writeOff(first)).status).toBe(201);
      expect((await lateFreight(first)).status).toBe(201);
      await assertAccepted(1, 1);
    } finally {
      await Promise.all(children.map(stopApi));
    }
  }, 90000);

  it.each([1, 2, 3])('arbitrates two Nest processes during a cost-state row lock, iteration %i', async () => {
    const children: ApiProcess[] = [];
    try {
      children.push(await startApi(), await startApi());
      const first = children[0];
      const second = children[1];
      if (!first || !second) throw new Error('Missing independent Nest processes');
      expect(first.child.pid).not.toBe(second.child.pid);

      const holder: { promise?: Promise<readonly [
        { status: number; data: unknown },
        { status: number; data: unknown },
      ]> } = {};
      await asTenant(pool, tenant.tenantId, async (db) => {
        const lock = await db.query(
          'SELECT id FROM product_cost_state WHERE tenant_id = $1 AND product_id = $2 FOR UPDATE',
          [tenant.tenantId, productId],
        );
        expect(lock.rows).toHaveLength(1);
        // Hold one real PostgreSQL row lock while the two independent Nest
        // processes calculate and attempt their separate writes. No stock,
        // lot, or journal is directly modified by this test barrier.
        holder.promise = Promise.all([lateFreight(first), writeOff(second)]);
        await new Promise<void>((done) => setTimeout(done, 500));
      });
      const requests = holder.promise;
      if (!requests) throw new Error('Concurrent requests were not started');
      const [landedResult, adjustmentResult] = await requests;
      expect([201, 400, 409]).toContain(landedResult.status);
      expect([201, 400, 409]).toContain(adjustmentResult.status);
      expect([landedResult.status, adjustmentResult.status]).toContain(201);
      await assertAccepted(
        landedResult.status === 201 ? 1 : 0,
        adjustmentResult.status === 201 ? 1 : 0,
      );
    } finally {
      await Promise.all(children.map(stopApi));
    }
  }, 90000);
});
