/*
 * MOD-003 C003-05 issue #184: real independent-process PURCHASE vs first
 * OPENING_STOCK, same tenant and same owned stock position. Test-only source.
 * Only an explicitly disposable PG16 sher_test + non-owner RLS is accepted.
 * Purchase API POST immediately receives stock; do not claim a separate
 * partial-receipt endpoint or paid-drawer semantics not present in this API.
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
  purchaseCount: number;
  openingCount: number;
  purchaseMovements: number;
  openingMovements: number;
  purchaseJournals: number;
  openingJournals: number;
  purchaseAudits: number;
  openingAudits: number;
  purchaseEvents: number;
  openingEvents: number;
  stockQty: number | null;
  lotQty: number | null;
  inventoryMinor: number;
  payableMinor: number;
  openingEquityMinor: number;
}

async function sourceState(): Promise<SourceState> {
  const result = await asTenant(pool, tenant.tenantId, (db) => db.query([
    'SELECT',
    '(SELECT count(*)::integer FROM purchases WHERE supplier_party_id = $2) AS "purchaseCount",',
    '(SELECT count(*)::integer FROM stock_openings WHERE product_id = $1) AS "openingCount",',
    "(SELECT count(*)::integer FROM stock_movements WHERE product_id = $1 AND source_document_type = 'PURCHASE') AS \"purchaseMovements\",",
    "(SELECT count(*)::integer FROM stock_movements WHERE product_id = $1 AND source_document_type = 'OPENING_STOCK') AS \"openingMovements\",",
    "(SELECT count(*)::integer FROM journal_entries WHERE source_document_type = 'PURCHASE') AS \"purchaseJournals\",",
    "(SELECT count(*)::integer FROM journal_entries WHERE source_document_type = 'OPENING_STOCK') AS \"openingJournals\",",
    "(SELECT count(*)::integer FROM audit_events WHERE entity_type = 'purchase') AS \"purchaseAudits\",",
    "(SELECT count(*)::integer FROM audit_events WHERE entity_type = 'stock_opening') AS \"openingAudits\",",
    "(SELECT count(*)::integer FROM outbox WHERE event_type = 'purchase.recorded') AS \"purchaseEvents\",",
    "(SELECT count(*)::integer FROM outbox WHERE event_type = 'inventory.opening-recorded') AS \"openingEvents\",",
    '(SELECT sum(qty_on_hand)::integer FROM product_cost_state WHERE product_id = $1) AS "stockQty",',
    "(SELECT sum(qty_remaining)::integer FROM inventory_lots WHERE product_id = $1 AND owner_type = 'OWNED') AS \"lotQty\",",
    "(SELECT COALESCE(SUM(amount_minor),0)::integer FROM journal_lines WHERE account_code = 'INVENTORY') AS \"inventoryMinor\",",
    "(SELECT COALESCE(SUM(amount_minor),0)::integer FROM journal_lines WHERE account_code = 'AP' AND party_id = $2) AS \"payableMinor\",",
    "(SELECT COALESCE(SUM(amount_minor),0)::integer FROM journal_lines WHERE account_code = 'OPENING_EQUITY') AS \"openingEquityMinor\"",
  ].join(' '), [productId, supplierId]));
  const r = result.rows[0];
  if (!r) throw new Error('Missing non-owner inventory/journal snapshot');
  return {
    purchaseCount: Number(r.purchaseCount),
    openingCount: Number(r.openingCount),
    purchaseMovements: Number(r.purchaseMovements),
    openingMovements: Number(r.openingMovements),
    purchaseJournals: Number(r.purchaseJournals),
    openingJournals: Number(r.openingJournals),
    purchaseAudits: Number(r.purchaseAudits),
    openingAudits: Number(r.openingAudits),
    purchaseEvents: Number(r.purchaseEvents),
    openingEvents: Number(r.openingEvents),
    stockQty: r.stockQty === null ? null : Number(r.stockQty),
    lotQty: r.lotQty === null ? null : Number(r.lotQty),
    inventoryMinor: Number(r.inventoryMinor),
    payableMinor: Number(r.payableMinor),
    openingEquityMinor: Number(r.openingEquityMinor),
  };
}

async function valuation(qty: number, valueMinor: number): Promise<void> {
  const r = await request(app.getHttpServer()).get('/api/v1/inventory/valuation')
    .set('Authorization', 'Bearer ' + token);
  expect(r.status).toBe(200);
  expect(r.body.data).toMatchObject({
    rows: [expect.objectContaining({ productId, qtyOnHand: qty, valueMinor })],
    totalValueMinor: valueMinor,
    inventoryAccountMinor: valueMinor,
    differenceMinor: 0,
    reconciled: true,
  });
}

async function expectedCommittedSources(purchased: boolean, opened: boolean): Promise<void> {
  const qty = Number(purchased) * 7_000 + Number(opened) * 10_000;
  const valueMinor = Number(purchased) * 70_000 + Number(opened) * 100_000;
  expect(await sourceState()).toEqual({
    purchaseCount: Number(purchased), openingCount: Number(opened),
    purchaseMovements: Number(purchased), openingMovements: Number(opened),
    purchaseJournals: Number(purchased), openingJournals: Number(opened),
    purchaseAudits: Number(purchased), openingAudits: Number(opened),
    purchaseEvents: Number(purchased), openingEvents: Number(opened),
    stockQty: qty, lotQty: qty,
    inventoryMinor: valueMinor,
    payableMinor: purchased ? -70_000 : 0,
    openingEquityMinor: opened ? -100_000 : 0,
  });
  await valuation(qty, valueMinor);
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
    name: 'MOD003 C00305 Purchase Opening Source Race',
    permissions: [
      Permission.PRODUCT_VIEW, Permission.PRODUCT_CREATE, Permission.PRODUCT_EDIT,
      Permission.UNIT_MANAGE, Permission.COST_VIEW, Permission.INVENTORY_LOT_VIEW,
      Permission.PURCHASE_CREATE, Permission.PURCHASE_VIEW,
      Permission.SUPPLIER_VIEW, Permission.SUPPLIER_CREATE,
    ],
  });
  token = signToken(tenant, TEST_JWT_SECRET);
  const u = await request(app.getHttpServer()).post('/api/v1/catalog/units')
    .set('Authorization', 'Bearer ' + token)
    .send({ name: 'Piece' });
  expect(u.status, JSON.stringify(u.body)).toBe(201);
  const p = await request(app.getHttpServer()).post('/api/v1/products')
    .set('Authorization', 'Bearer ' + token)
    .set('Idempotency-Key', Ulid.generate(clock))
    .send({
      name: 'Unopened Purchase Race Bolt',
      baseUnitId: u.body.data.units[0].id as string,
      purchasePriceMinor: 10_000, sellingPriceMinor: 12_000, minStockQty: 0,
      brandId: null, categoryId: null, sku: null, barcode: null,
      description: null, defaultDiscountType: null, defaultDiscountValue: null,
      offerEnabled: false, offerPriceMinor: null, offerStartDate: null,
      offerEndDate: null, tracksExpiry: false, tracksSerial: false,
      conversionUnitId: null, conversionFactorQty: null,
    });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  productId = p.body.data.id as string;

  const supplier = await request(app.getHttpServer()).post('/api/v1/parties')
    .set('Authorization', 'Bearer ' + token)
    .set('Idempotency-Key', Ulid.generate(clock))
    .send({
      name: 'Concurrent Wholesale Supplier',
      roles: ['SUPPLIER'], phone: '01812345678', address: null,
      guardianName: null, nid: null, email: null, notes: null,
      customerGroupId: null, creditLimitMinor: null,
    });
  expect(supplier.status, JSON.stringify(supplier.body)).toBe(201);
  supplierId = supplier.body.data.id as string;
});

afterEach(async () => {
  await assertGoldenInvariants(pool, tenant.tenantId);
});

function opening() {
  return { productId, qty: 10_000, businessDate: todayIn(tenant.timezone) };
}
function creditPurchase() {
  // Paid=0 and no cash/MFS/bank posting; cash-session feature is irrelevant here.
  return {
    supplierPartyId: supplierId,
    lines: [{ productId, qty: 7_000, unitPriceMinor: 10_000 }],
    discountMinor: 0, paidMinor: 0, paidAccountCode: null,
  };
}

describe('MOD-003 C003-05 purchase posting vs first opening stock (real PG16)', () => {
  it('rejects a historical opening after a posted supplier purchase without source drift', async () => {
    const children: ApiProcess[] = [];
    try {
      children.push(await startApi(), await startApi());
      const [a, b] = children as [ApiProcess, ApiProcess];
      const bought = await post(a, '/api/v1/purchases', creditPurchase());
      expect(bought.status).toBe(201);
      const rejected = await post(b, '/api/v1/inventory/openings', opening());
      expect([400, 409]).toContain(rejected.status);
      await expectedCommittedSources(true, false);
    } finally {
      await Promise.all(children.map(stopApi));
    }
  }, 90_000);

  it.each([1, 2, 3])('serializes same-product purchase vs first opening, race %i', async () => {
    const children: ApiProcess[] = [];
    try {
      children.push(await startApi(), await startApi());
      const [a, b] = children as [ApiProcess, ApiProcess];
      expect(a.child.pid).not.toBe(b.child.pid);
      const purchaseKey = Ulid.generate(clock);
      const openingKey = Ulid.generate(clock);
      expect(purchaseKey).not.toBe(openingKey);
      const [bought, opened] = await Promise.all([
        post(a, '/api/v1/purchases', creditPurchase(), purchaseKey),
        post(b, '/api/v1/inventory/openings', opening(), openingKey),
      ]);
      // An available document may succeed, or a stale first writer may be
      // rejected with a documented business conflict. HTTP 500 is NEVER valid.
      expect([201, 409]).toContain(bought.status);
      expect([201, 400, 409]).toContain(opened.status);
      const boughtOk = bought.status === 201;
      const openedOk = opened.status === 201;
      expect(boughtOk || openedOk).toBe(true);
      await expectedCommittedSources(boughtOk, openedOk);

      // Replaying an accepted first-opening cannot add another 10-unit lot
      // or duplicate the opening-equity journal.
      if (openedOk) {
        const replay = await post(b, '/api/v1/inventory/openings', opening(), openingKey);
        expect(replay.status).toBe(201);
        expect(replay.data).toEqual(opened.data);
        await expectedCommittedSources(boughtOk, openedOk);
      }
    } finally {
      await Promise.all(children.map(stopApi));
    }
  }, 90_000);
});
