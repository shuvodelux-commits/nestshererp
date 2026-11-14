/*
 * MOD-003 C003-05, backend issue #186, test-only independent QA.
 * Two genuinely separate Nest operating-system processes on one disposable
 * PG16/non-owner RLS database. No mock inventory, stock or journal writers.
 *
 * The 201 and 409/400 cases are deliberately both acceptable during races:
 * a rejected writer must not leave partial stock, equity, audit or outbox.
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
  const json = await response.json() as { data?: unknown };
  return { status: response.status, data: json.data };
}

interface SourceState {
  openings: number;
  adjustments: number;
  openingMovements: number;
  adjustmentMovements: number;
  stockQty: number | null;
  lotQty: number | null;
  journals: number;
  audits: number;
  events: number;
}

async function sourceState(): Promise<SourceState> {
  const r = await asTenant(pool, tenant.tenantId, (db) => db.query([
    'SELECT',
    '(SELECT count(*)::integer FROM stock_openings WHERE product_id = $1) AS openings,',
    '(SELECT count(*)::integer FROM stock_adjustments WHERE product_id = $1) AS adjustments,',
    "(SELECT count(*)::integer FROM stock_movements WHERE product_id = $1 AND source_document_type = 'OPENING_STOCK') AS \"openingMovements\",",
    "(SELECT count(*)::integer FROM stock_movements WHERE product_id = $1 AND source_document_type = 'STOCK_ADJUSTMENT') AS \"adjustmentMovements\",",
    '(SELECT sum(qty_on_hand)::integer FROM product_cost_state WHERE product_id = $1) AS "stockQty",',
    "(SELECT sum(qty_remaining)::integer FROM inventory_lots WHERE product_id = $1 AND owner_type = 'OWNED') AS \"lotQty\",",
    "(SELECT count(*)::integer FROM journal_entries WHERE source_document_type IN ('OPENING_STOCK','STOCK_ADJUSTMENT')) AS journals,",
    "(SELECT count(*)::integer FROM audit_events WHERE entity_type IN ('stock_opening','stock_adjustment')) AS audits,",
    "(SELECT count(*)::integer FROM outbox WHERE event_type IN ('inventory.opening-recorded','inventory.stock-adjusted')) AS events",
  ].join(' '), [productId]));
  const row = r.rows[0];
  if (!row) throw new Error('Missing PostgreSQL inventory snapshot');
  return {
    openings: Number(row.openings),
    adjustments: Number(row.adjustments),
    openingMovements: Number(row.openingMovements),
    adjustmentMovements: Number(row.adjustmentMovements),
    stockQty: row.stockQty === null ? null : Number(row.stockQty),
    lotQty: row.lotQty === null ? null : Number(row.lotQty),
    journals: Number(row.journals),
    audits: Number(row.audits),
    events: Number(row.events),
  };
}

async function expectValuation(qty: number, valueMinor: number): Promise<void> {
  const res = await request(app.getHttpServer())
    .get('/api/v1/inventory/valuation')
    .set('Authorization', 'Bearer ' + token);
  expect(res.status).toBe(200);
  expect(res.body.data).toMatchObject({
    rows: [expect.objectContaining({ productId, qtyOnHand: qty, valueMinor })],
    totalValueMinor: valueMinor,
    inventoryAccountMinor: valueMinor,
    differenceMinor: 0,
    reconciled: true,
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
    name: 'MOD003 C00305 Shop',
    permissions: [
      Permission.PRODUCT_VIEW, Permission.PRODUCT_CREATE, Permission.PRODUCT_EDIT,
      Permission.UNIT_MANAGE, Permission.COST_VIEW, Permission.INVENTORY_LOT_VIEW,
    ],
  });
  token = signToken(tenant, TEST_JWT_SECRET);
  const u = await request(app.getHttpServer())
    .post('/api/v1/catalog/units').set('Authorization', 'Bearer ' + token)
    .send({ name: 'Piece' });
  expect(u.status).toBe(201);
  const unitId = u.body.data.units[0].id as string;
  const p = await request(app.getHttpServer())
    .post('/api/v1/products').set('Authorization', 'Bearer ' + token)
    .set('Idempotency-Key', Ulid.generate(clock))
    .send({
      name: 'Independent Race Bolt',
      baseUnitId: unitId, purchasePriceMinor: 10_000,
      sellingPriceMinor: 12_000, minStockQty: 2_000,
      brandId: null, categoryId: null, sku: null, barcode: null, description: null,
      defaultDiscountType: null, defaultDiscountValue: null, offerEnabled: false,
      offerPriceMinor: null, offerStartDate: null, offerEndDate: null,
      tracksExpiry: false, tracksSerial: false, conversionUnitId: null,
      conversionFactorQty: null,
    });
  expect(p.status).toBe(201);
  productId = p.body.data.id as string;
});

afterEach(async () => {
  await assertGoldenInvariants(pool, tenant.tenantId);
});

describe('C003-05 independent Nest-process stock arbitration', () => {
  const opening = (server: ApiProcess) => post(server, '/api/v1/inventory/openings', {
    productId, qty: 10_000, businessDate: todayIn(tenant.timezone),
  });
  const adjustment = (server: ApiProcess, qtyDelta: number) => post(
    server,
    '/api/v1/inventory/adjustments',
    { productId, qtyDelta, reason: 'RECOUNT', note: null, businessDate: todayIn(tenant.timezone) },
  );

  it('arbitrates an opening and simultaneous positive adjustment across two OS processes', async () => {
    const children: ApiProcess[] = [];
    try {
      children.push(await startApi(), await startApi());
      const [first, second] = children as [ApiProcess, ApiProcess];
      expect(first.child.pid).not.toBe(second.child.pid);
      const [opened, changed] = await Promise.all([opening(first), adjustment(second, 5_000)]);
      expect([201, 400, 409]).toContain(opened.status);
      expect([201, 400, 409]).toContain(changed.status);
      expect([opened.status, changed.status]).toContain(201);
      const a = opened.status === 201 ? 1 : 0;
      const b = changed.status === 201 ? 1 : 0;
      const expectedQty = a * 10_000 + b * 5_000;
      const expectedValue = a * 100_000 + b * 50_000;
      expect(await sourceState()).toEqual({
        openings: a, adjustments: b,
        openingMovements: a, adjustmentMovements: b,
        stockQty: expectedQty, lotQty: expectedQty,
        journals: a + b, audits: a + b, events: a + b,
      });
      await expectValuation(expectedQty, expectedValue);
    } finally {
      await Promise.all(children.map(stopApi));
    }
  }, 90000);

  it('refuses one of two simultaneous 7-unit write-offs from a 10-unit opening', async () => {
    const children: ApiProcess[] = [];
    try {
      children.push(await startApi(), await startApi());
      const [first, second] = children as [ApiProcess, ApiProcess];
      const opened = await opening(first);
      expect(opened.status).toBe(201);
      const [a, b] = await Promise.all([adjustment(first, -7_000), adjustment(second, -7_000)]);
      expect([a.status, b.status].filter((status) => status === 201)).toHaveLength(1);
      expect([400, 409]).toContain(a.status === 201 ? b.status : a.status);
      expect(await sourceState()).toEqual({
        openings: 1, adjustments: 1,
        openingMovements: 1, adjustmentMovements: 1,
        stockQty: 3_000, lotQty: 3_000,
        journals: 2, audits: 2, events: 2,
      });
      await expectValuation(3_000, 30_000);
    } finally {
      await Promise.all(children.map(stopApi));
    }
  }, 90000);

  it('refuses historical opening after a posted adjustment has already initialized stock', async () => {
    const children: ApiProcess[] = [];
    try {
      children.push(await startApi(), await startApi());
      const [first, second] = children as [ApiProcess, ApiProcess];
      expect((await adjustment(first, 5_000)).status).toBe(201);
      const refused = await opening(second);
      expect([400, 409]).toContain(refused.status);
      expect(await sourceState()).toEqual({
        openings: 0, adjustments: 1,
        openingMovements: 0, adjustmentMovements: 1,
        stockQty: 5_000, lotQty: 5_000,
        journals: 1, audits: 1, events: 1,
      });
      await expectValuation(5_000, 50_000);
    } finally {
      await Promise.all(children.map(stopApi));
    }
  }, 90000);
});
