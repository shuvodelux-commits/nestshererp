/*
 * MOD-003 C003-05 (#184): owned-stock sale vs sale / adjustment concurrency.
 * Only this new test file is in scope. Real Nest child processes, isolated
 * non-owner PG16/RLS, immutable stock/accounting sources, no mocks or cash.
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
import { asTenant, prepareTestDatabase, resetDatabase, seedTenant, seedWalkInCustomer, testPool, todayIn } from './support/database';
import { assertGoldenInvariants } from './support/invariants';

const clock = new SystemClock();
let app: INestApplication;
let pool: pg.Pool;
let tenant: SeededTenant;
let token: string;
let productId: string;
let customerId: string;

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
): Promise<{ status: number; data: unknown }> {
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
  if (response.status >= 500) {
    process.stderr.write('MOD-003 cross-source HTTP ' + response.status + ': ' + JSON.stringify(json.error) + '\n');
  }
  return { status: response.status, data: json.data };
}


interface StockSnapshot {
  readonly qty: number;
  readonly lotQty: number;
  readonly sales: number;
  readonly adjustments: number;
  readonly saleMovements: number;
  readonly adjustmentMovements: number;
  readonly saleJournals: number;
  readonly adjustmentJournals: number;
  readonly saleAudits: number;
  readonly adjustmentAudits: number;
  readonly saleEvents: number;
  readonly adjustmentEvents: number;
  readonly inventoryMinor: number;
  readonly cogsMinor: number;
  readonly adjustmentMinor: number;
  readonly receivableMinor: number;
  readonly revenueMinor: number;
}

async function snapshot(): Promise<StockSnapshot> {
  const result = await asTenant(pool, tenant.tenantId, (db) => db.query([
    'SELECT',
    '(SELECT COALESCE(SUM(qty_on_hand), 0)::integer FROM product_cost_state WHERE product_id = $1) AS qty,',
    "(SELECT COALESCE(SUM(qty_remaining),0)::integer FROM inventory_lots WHERE product_id = $1 AND owner_type = 'OWNED') AS \"lotQty\",",
    '(SELECT COUNT(*)::integer FROM sales) AS sales,',
    '(SELECT COUNT(*)::integer FROM stock_adjustments WHERE product_id = $1) AS adjustments,',
    "(SELECT COUNT(*)::integer FROM stock_movements WHERE product_id = $1 AND source_document_type = 'SALE') AS \"saleMovements\",",
    "(SELECT COUNT(*)::integer FROM stock_movements WHERE product_id = $1 AND source_document_type = 'STOCK_ADJUSTMENT') AS \"adjustmentMovements\",",
    "(SELECT COUNT(*)::integer FROM journal_entries WHERE source_document_type = 'SALE') AS \"saleJournals\",",
    "(SELECT COUNT(*)::integer FROM journal_entries WHERE source_document_type = 'STOCK_ADJUSTMENT') AS \"adjustmentJournals\",",
    "(SELECT COUNT(*)::integer FROM audit_events WHERE entity_type = 'sale') AS \"saleAudits\",",
    "(SELECT COUNT(*)::integer FROM audit_events WHERE entity_type = 'stock_adjustment') AS \"adjustmentAudits\",",
    "(SELECT COUNT(*)::integer FROM outbox WHERE event_type = 'sale.posted') AS \"saleEvents\",",
    "(SELECT COUNT(*)::integer FROM outbox WHERE event_type = 'inventory.stock-adjusted') AS \"adjustmentEvents\",",
    "(SELECT COALESCE(SUM(amount_minor),0)::integer FROM journal_lines WHERE account_code = 'INVENTORY') AS \"inventoryMinor\",",
    "(SELECT COALESCE(SUM(amount_minor),0)::integer FROM journal_lines WHERE account_code = 'COGS') AS \"cogsMinor\",",
    "(SELECT COALESCE(SUM(amount_minor),0)::integer FROM journal_lines WHERE account_code = 'STOCK_ADJUSTMENT') AS \"adjustmentMinor\",",
    "(SELECT COALESCE(SUM(amount_minor),0)::integer FROM journal_lines WHERE account_code = 'AR') AS \"receivableMinor\",",
    "(SELECT COALESCE(SUM(amount_minor),0)::integer FROM journal_lines WHERE account_code = 'SALES') AS \"revenueMinor\"",
  ].join(' '), [productId]));
  const r = result.rows[0];
  if (!r) throw new Error('No non-owner PostgreSQL snapshot');
  return {
    qty: Number(r.qty), lotQty: Number(r.lotQty),
    sales: Number(r.sales), adjustments: Number(r.adjustments),
    saleMovements: Number(r.saleMovements), adjustmentMovements: Number(r.adjustmentMovements),
    saleJournals: Number(r.saleJournals), adjustmentJournals: Number(r.adjustmentJournals),
    saleAudits: Number(r.saleAudits), adjustmentAudits: Number(r.adjustmentAudits),
    saleEvents: Number(r.saleEvents), adjustmentEvents: Number(r.adjustmentEvents),
    inventoryMinor: Number(r.inventoryMinor), cogsMinor: Number(r.cogsMinor),
    adjustmentMinor: Number(r.adjustmentMinor), receivableMinor: Number(r.receivableMinor),
    revenueMinor: Number(r.revenueMinor),
  };
}

async function valuation(qty: number, valueMinor: number): Promise<void> {
  const response = await request(app.getHttpServer()).get('/api/v1/inventory/valuation')
    .set('Authorization', 'Bearer ' + token);
  expect(response.status).toBe(200);
  expect(response.body.data).toMatchObject({
    method: 'FIFO',
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
    name: 'MOD003 Cross Source Race',
    permissions: [
      Permission.SALE_CREATE, Permission.SALE_VIEW, Permission.PRODUCT_VIEW,
      Permission.PRODUCT_CREATE, Permission.PRODUCT_EDIT, Permission.UNIT_MANAGE,
      Permission.COST_VIEW, Permission.INVENTORY_LOT_VIEW,
      Permission.CUSTOMER_VIEW, Permission.CUSTOMER_CREATE,
    ],
  });
  token = signToken(tenant, TEST_JWT_SECRET);
  await seedWalkInCustomer(pool, tenant);

  const unit = await request(app.getHttpServer()).post('/api/v1/catalog/units')
    .set('Authorization', 'Bearer ' + token).send({ name: 'Piece' });
  expect(unit.status, JSON.stringify(unit.body)).toBe(201);
  const product = await request(app.getHttpServer()).post('/api/v1/products')
    .set('Authorization', 'Bearer ' + token)
    .set('Idempotency-Key', Ulid.generate(clock))
    .send({
      name: 'Cross Source Race Bolt',
      baseUnitId: unit.body.data.units[0].id as string,
      purchasePriceMinor: 10_000, sellingPriceMinor: 12_000, minStockQty: 0,
      brandId: null, categoryId: null, sku: null, barcode: null, description: null,
      defaultDiscountType: null, defaultDiscountValue: null, offerEnabled: false,
      offerPriceMinor: null, offerStartDate: null, offerEndDate: null,
      tracksExpiry: false, tracksSerial: false, conversionUnitId: null,
      conversionFactorQty: null,
    });
  expect(product.status, JSON.stringify(product.body)).toBe(201);
  productId = product.body.data.id as string;
  const opening = await request(app.getHttpServer()).post('/api/v1/inventory/openings')
    .set('Authorization', 'Bearer ' + token)
    .set('Idempotency-Key', Ulid.generate(clock))
    .send({ productId, qty: 10_000, businessDate: todayIn(tenant.timezone) });
  expect(opening.status, JSON.stringify(opening.body)).toBe(201);

  const party = await request(app.getHttpServer()).post('/api/v1/parties')
    .set('Authorization', 'Bearer ' + token)
    .set('Idempotency-Key', Ulid.generate(clock))
    .send({
      name: 'Cross Source Customer', roles: ['CUSTOMER'], phone: '01712345678',
      address: null, guardianName: null, nid: null, email: null, notes: null,
      customerGroupId: null, creditLimitMinor: null,
    });
  expect(party.status, JSON.stringify(party.body)).toBe(201);
  customerId = party.body.data.id as string;
});

afterEach(async () => {
  await assertGoldenInvariants(pool, tenant.tenantId);
});

function sale(server: ApiProcess, qty: number, key?: string, bearer?: string) {
  // Credit sale: no cash/BANK/MFS movement, so an active cash session is inapplicable.
  return post(server, '/api/v1/sales', {
    partyId: customerId, customerName: null, customerPhone: null,
    lines: [{ productId, qty, unitPriceMinor: 12_000, lineDiscountMinor: 0 }],
    payments: [], discountMinor: 0,
  }, key, bearer);
}

function damage(server: ApiProcess, qty: number) {
  return post(server, '/api/v1/inventory/adjustments', {
    productId, qtyDelta: -qty, reason: 'DAMAGE', note: null,
    businessDate: todayIn(tenant.timezone),
  });
}

async function collide(
  first: () => Promise<{ status: number; data: unknown }>,
  second: () => Promise<{ status: number; data: unknown }>,
): Promise<readonly [{ status: number; data: unknown }, { status: number; data: unknown }]> {
  let pending: Promise<readonly [{ status: number; data: unknown }, { status: number; data: unknown }]> | undefined;
  // A real PG row lock makes both independent Nest writers overlap on the
  // existing cost state without mutating inventory/journal test data.
  await asTenant(pool, tenant.tenantId, async (db) => {
    const lock = await db.query(
      'SELECT id FROM product_cost_state WHERE tenant_id = $1 AND product_id = $2 FOR UPDATE',
      [tenant.tenantId, productId],
    );
    expect(lock.rows).toHaveLength(1);
    pending = Promise.all([first(), second()]);
    await new Promise<void>((done) => setTimeout(done, 400));
  });
  if (!pending) throw new Error('Independent process race never started');
  return pending;
}

async function assertOneWriter(winner: 'SALE' | 'DAMAGE'): Promise<void> {
  const sold = winner === 'SALE' ? 1 : 0;
  const adjusted = winner === 'DAMAGE' ? 1 : 0;
  expect(await snapshot()).toEqual({
    qty: 3_000, lotQty: 3_000,
    sales: sold, adjustments: adjusted,
    saleMovements: sold, adjustmentMovements: adjusted,
    saleJournals: sold, adjustmentJournals: adjusted,
    saleAudits: sold, adjustmentAudits: adjusted,
    saleEvents: sold, adjustmentEvents: adjusted,
    inventoryMinor: 30_000,
    cogsMinor: sold * 70_000, adjustmentMinor: adjusted * 70_000,
    receivableMinor: sold * 84_000, revenueMinor: sold === 1 ? -84_000 : 0,
  });
  await valuation(3_000, 30_000);
}

describe('MOD-003 #184: independent sale/stock-source PostgreSQL concurrency', () => {
  it('accepts exactly one of two 7-unit owned-stock sales from ten on hand', async () => {
    const servers: ApiProcess[] = [];
    try {
      servers.push(await startApi(), await startApi());
      const [a, b] = servers as [ApiProcess, ApiProcess];
      expect(a.child.pid).not.toBe(b.child.pid);
      const outcomes = await collide(() => sale(a, 7_000), () => sale(b, 7_000));
      const statuses = outcomes.map((x) => x.status);
      expect(statuses.filter((x) => x === 201)).toHaveLength(1);
      expect([400, 409]).toContain(statuses.find((x) => x !== 201));
      await assertOneWriter('SALE');
    } finally {
      await Promise.all(servers.map(stopApi));
    }
  }, 90_000);

  it('arbitrates a 7-unit credit sale versus a 7-unit damage adjustment', async () => {
    const servers: ApiProcess[] = [];
    try {
      servers.push(await startApi(), await startApi());
      const [a, b] = servers as [ApiProcess, ApiProcess];
      expect(a.child.pid).not.toBe(b.child.pid);
      const [sold, adjusted] = await collide(() => sale(a, 7_000), () => damage(b, 7_000));
      const accepted = [sold.status, adjusted.status];
      expect(accepted.filter((x) => x === 201)).toHaveLength(1);
      expect([400, 409]).toContain(accepted.find((x) => x !== 201));
      await assertOneWriter(sold.status === 201 ? 'SALE' : 'DAMAGE');
    } finally {
      await Promise.all(servers.map(stopApi));
    }
  }, 90_000);

  it('replays a lost credit-sale response without a second stock, AR, COGS or outbox entry', async () => {
    const servers: ApiProcess[] = [];
    try {
      servers.push(await startApi(), await startApi());
      const [a, b] = servers as [ApiProcess, ApiProcess];
      const key = Ulid.generate(clock);
      const first = await sale(a, 2_000, key);
      expect(first.status).toBe(201);
      const replay = await sale(b, 2_000, key);
      expect([200, 201]).toContain(replay.status);
      expect(replay.data).toEqual(first.data);
      expect(await snapshot()).toMatchObject({
        sales: 1, adjustments: 0, saleMovements: 1, adjustmentMovements: 0,
        saleJournals: 1, adjustmentJournals: 0, saleAudits: 1, saleEvents: 1,
        qty: 8_000, lotQty: 8_000, inventoryMinor: 80_000,
        cogsMinor: 20_000, receivableMinor: 24_000, revenueMinor: -24_000,
      });
      await valuation(8_000, 80_000);
    } finally {
      await Promise.all(servers.map(stopApi));
    }
  }, 90_000);

  it('does not permit a second tenant to read or sell another tenant owned lot', async () => {
    const other = await seedTenant(pool, {
      name: 'MOD003 RLS Attacker Shop', permissions: [
        Permission.SALE_CREATE, Permission.PRODUCT_VIEW, Permission.CUSTOMER_VIEW,
      ],
    });
    await seedWalkInCustomer(pool, other);
    const otherToken = signToken(other, TEST_JWT_SECRET);
    const servers: ApiProcess[] = [];
    try {
      servers.push(await startApi());
      const server = servers[0];
      if (!server) throw new Error('Missing independent Nest process');
      const read = await fetch('http://127.0.0.1:' + server.port + '/api/v1/products/' + productId, {
        headers: { Authorization: 'Bearer ' + otherToken },
      });
      expect([403, 404]).toContain(read.status);
      const refused = await sale(server, 2_000, undefined, otherToken);
      expect([400, 403, 404]).toContain(refused.status);
      expect(await snapshot()).toMatchObject({
        sales: 0, adjustments: 0, saleMovements: 0, adjustmentMovements: 0,
        qty: 10_000, lotQty: 10_000, inventoryMinor: 100_000,
        cogsMinor: 0, receivableMinor: 0, revenueMinor: 0,
      });
      const otherSales = await asTenant(pool, other.tenantId, (db) =>
        db.query('SELECT count(*)::integer AS count FROM sales'));
      expect(Number(otherSales.rows[0]?.count)).toBe(0);
      await valuation(10_000, 100_000);
    } finally {
      await Promise.all(servers.map(stopApi));
    }
  }, 90_000);
});
