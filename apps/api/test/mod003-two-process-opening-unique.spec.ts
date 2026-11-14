/*
 * MOD-003 C003-09, backend issue #197, independent process opening unique QA.
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

describe('C003-09 cross-process one-opening-per-product conflict', () => {
  const today = () => todayIn(tenant.timezone);
  const body = () => ({ productId, qty: 10_000, businessDate: today() });

  it.each([1, 2, 3])('refuses duplicate concurrent opening without 500, iteration %i', async () => {
    const children: ApiProcess[] = [];
    try {
      const first = await startApi();
      children.push(first);
      const second = await startApi();
      children.push(second);
      expect(first.child.pid).not.toBe(second.child.pid);

      const operationA = Ulid.generate(clock);
      const operationB = Ulid.generate(clock);
      expect(operationA).not.toBe(operationB);
      const [a, b] = await Promise.all([
        post(first, '/api/v1/inventory/openings', body(), operationA),
        post(second, '/api/v1/inventory/openings', body(), operationB),
      ]);

      // A competing writer must never present an internal SQL 23505 as 500.
      expect([a.status, b.status].filter((code) => code === 201)).toHaveLength(1);
      const failed = a.status === 201 ? b : a;
      expect([400, 409]).toContain(failed.status);

      // Only a successful document is allowed to create a source, lot,
      // stock movement, opening-equity journal, audit and outbox.
      expect(await sourceState()).toEqual({
        openings: 1, adjustments: 0,
        openingMovements: 1, adjustmentMovements: 0,
        stockQty: 10_000, lotQty: 10_000,
        journals: 1, audits: 1, events: 1,
      });
      await expectValuation(10_000, 100_000);

      // A lost-response retry by the winning client returns its original
      // source, not a second 10-unit opening or a second equity journal.
      const server = a.status === 201 ? first : second;
      const operation = a.status === 201 ? operationA : operationB;
      const firstResponse = a.status === 201 ? a : b;
      const replay = await post(server, '/api/v1/inventory/openings', body(), operation);
      expect(replay.status).toBe(201);
      expect(replay.data).toEqual(firstResponse.data);
      expect((await sourceState()).openings).toBe(1);
    } finally {
      await Promise.all(children.map(stopApi));
    }
  }, 90000);
});
