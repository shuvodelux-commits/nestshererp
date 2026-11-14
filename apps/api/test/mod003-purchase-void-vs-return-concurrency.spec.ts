/*
 * MOD-003 #184 C003-13: purchase VOID versus purchase RETURN and duplicate
 * VOID, genuinely independent Nest OS processes and non-owner PG16 tenant RLS.
 * Do not write production business sources or bypass active cash-session rules.
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
import { asTenant, prepareTestDatabase, resetDatabase, seedTenant, testPool } from './support/database';
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
): Promise<{ status: number; data: unknown; error?: unknown }> {
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
  return { status: response.status, data: json.data, error: json.error };
}



interface PurchaseSeed {
  id: string;
  version: number;
  lineId: string;
}
interface PostingState {
  billStatus: string;
  purchases: number;
  returns: number;
  receiptMovements: number;
  reversalMovements: number;
  returnMovements: number;
  receiptJournals: number;
  reversalJournals: number;
  returnJournals: number;
  purchaseCreatedAudits: number;
  purchaseVoidedAudits: number;
  returnCreatedAudits: number;
  purchasePostedOutbox: number;
  purchaseVoidedOutbox: number;
  returnPostedOutbox: number;
  stockQty: number;
  lotQty: number;
  inventoryMinor: number;
  apMinor: number;
}
async function snapshot(purchaseId: string): Promise<PostingState> {
  const result = await asTenant(pool, tenant.tenantId, (db) => db.query([
    'SELECT',
    '(SELECT status FROM purchases WHERE id = $3) AS "billStatus",',
    '(SELECT count(*)::integer FROM purchases WHERE id = $3) AS purchases,',
    '(SELECT count(*)::integer FROM purchase_returns WHERE purchase_id = $3) AS returns,',
    "(SELECT count(*)::integer FROM stock_movements WHERE product_id = $1 AND source_document_type = 'PURCHASE') AS \"receiptMovements\",",
    "(SELECT count(*)::integer FROM stock_movements WHERE product_id = $1 AND source_document_type = 'PURCHASE_REVERSAL') AS \"reversalMovements\",",
    "(SELECT count(*)::integer FROM stock_movements WHERE product_id = $1 AND source_document_type = 'PURCHASE_RETURN') AS \"returnMovements\",",
    "(SELECT count(*)::integer FROM journal_entries WHERE source_document_type = 'PURCHASE' AND source_document_id = $3) AS \"receiptJournals\",",
    "(SELECT count(*)::integer FROM journal_entries WHERE source_document_type = 'PURCHASE_REVERSAL' AND source_document_id = $3) AS \"reversalJournals\",",
    "(SELECT count(*)::integer FROM journal_entries WHERE source_document_type = 'PURCHASE_RETURN') AS \"returnJournals\",",
    "(SELECT count(*)::integer FROM audit_events WHERE entity_type = 'purchase' AND entity_id = $3 AND action = 'CREATE') AS \"purchaseCreatedAudits\",",
    "(SELECT count(*)::integer FROM audit_events WHERE entity_type = 'purchase' AND entity_id = $3 AND action = 'DELETE') AS \"purchaseVoidedAudits\",",
    "(SELECT count(*)::integer FROM audit_events WHERE entity_type = 'purchase_return' AND action = 'CREATE') AS \"returnCreatedAudits\",",
    "(SELECT count(*)::integer FROM outbox WHERE event_type = 'purchase.recorded' AND aggregate_id = $3) AS \"purchasePostedOutbox\",",
    "(SELECT count(*)::integer FROM outbox WHERE event_type = 'purchase.cancelled' AND aggregate_id = $3) AS \"purchaseVoidedOutbox\",",
    "(SELECT count(*)::integer FROM outbox WHERE event_type = 'purchase.return.posted') AS \"returnPostedOutbox\",",
    '(SELECT COALESCE(SUM(qty_on_hand),0)::integer FROM product_cost_state WHERE product_id = $1) AS "stockQty",',
    "(SELECT COALESCE(SUM(qty_remaining),0)::integer FROM inventory_lots WHERE product_id = $1 AND owner_type = 'OWNED') AS \"lotQty\",",
    "(SELECT COALESCE(SUM(amount_minor),0)::integer FROM journal_lines WHERE account_code = 'INVENTORY') AS \"inventoryMinor\",",
    "(SELECT COALESCE(SUM(amount_minor),0)::integer FROM journal_lines WHERE account_code = 'AP' AND party_id = $2) AS \"apMinor\"",
  ].join(' '), [productId, supplierId, purchaseId]));
  const r = result.rows[0];
  if (!r) throw new Error('Missing non-owner purchase snapshot');
  return {
    billStatus: String(r.billStatus),
    purchases: Number(r.purchases),
    returns: Number(r.returns),
    receiptMovements: Number(r.receiptMovements),
    reversalMovements: Number(r.reversalMovements),
    returnMovements: Number(r.returnMovements),
    receiptJournals: Number(r.receiptJournals),
    reversalJournals: Number(r.reversalJournals),
    returnJournals: Number(r.returnJournals),
    purchaseCreatedAudits: Number(r.purchaseCreatedAudits),
    purchaseVoidedAudits: Number(r.purchaseVoidedAudits),
    returnCreatedAudits: Number(r.returnCreatedAudits),
    purchasePostedOutbox: Number(r.purchasePostedOutbox),
    purchaseVoidedOutbox: Number(r.purchaseVoidedOutbox),
    returnPostedOutbox: Number(r.returnPostedOutbox),
    stockQty: Number(r.stockQty),
    lotQty: Number(r.lotQty),
    inventoryMinor: Number(r.inventoryMinor),
    apMinor: Number(r.apMinor),
  };
}
async function expectPosting(purchaseId: string, outcome: 'VOID' | 'RETURN'): Promise<void> {
  const voided = outcome === 'VOID';
  const qty = voided ? 0 : 8_000;
  const minor = voided ? 0 : 80_000;
  expect(await snapshot(purchaseId)).toEqual({
    billStatus: voided ? 'VOIDED' : 'POSTED',
    purchases: 1, returns: voided ? 0 : 1,
    receiptMovements: 1,
    reversalMovements: voided ? 1 : 0,
    returnMovements: voided ? 0 : 1,
    receiptJournals: 1,
    reversalJournals: voided ? 1 : 0,
    returnJournals: voided ? 0 : 1,
    purchaseCreatedAudits: 1, purchaseVoidedAudits: voided ? 1 : 0,
    returnCreatedAudits: voided ? 0 : 1,
    purchasePostedOutbox: 1, purchaseVoidedOutbox: voided ? 1 : 0,
    returnPostedOutbox: voided ? 0 : 1,
    stockQty: qty, lotQty: qty,
    inventoryMinor: minor, apMinor: minor === 0 ? 0 : -minor,
  });
  const response = await request(app.getHttpServer())
    .get('/api/v1/inventory/valuation')
    .set('Authorization', 'Bearer ' + token);
  expect(response.status).toBe(200);
  expect(response.body.data).toMatchObject({
    totalValueMinor: minor,
    inventoryAccountMinor: minor,
    differenceMinor: 0,
    reconciled: true,
  });
}
function purchaseBody() {
  return {
    supplierPartyId: supplierId,
    lines: [{ productId, qty: 10_000, unitPriceMinor: 10_000 }],
    discountMinor: 0, paidMinor: 0, paidAccountCode: null,
  };
}
async function createBill(): Promise<PurchaseSeed> {
  const r = await request(app.getHttpServer()).post('/api/v1/purchases')
    .set('Authorization', 'Bearer ' + token)
    .set('Idempotency-Key', Ulid.generate(clock))
    .send(purchaseBody());
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return {
    id: r.body.data.id as string,
    version: r.body.data.version as number,
    lineId: r.body.data.lines[0].id as string,
  };
}
function returnTwo(bill: PurchaseSeed) {
  return {
    purchaseId: bill.id, lines: [{ sourceLineId: bill.lineId, qty: 2_000 }],
    reason: 'DAMAGED', note: null, receivedMinor: 0, receiptAccountCode: null,
  };
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
    name: 'MOD003 Purchase Void Return Concurrency',
    permissions: [
      Permission.PRODUCT_VIEW, Permission.PRODUCT_CREATE, Permission.PRODUCT_EDIT,
      Permission.UNIT_MANAGE, Permission.COST_VIEW, Permission.INVENTORY_LOT_VIEW,
      Permission.PURCHASE_CREATE, Permission.PURCHASE_VIEW, Permission.PURCHASE_VOID,
      Permission.PURCHASE_RETURN_CREATE, Permission.PURCHASE_RETURN_VIEW,
      Permission.SUPPLIER_VIEW, Permission.SUPPLIER_CREATE,
    ],
  });
  token = signToken(tenant, TEST_JWT_SECRET);
  const unit = await request(app.getHttpServer()).post('/api/v1/catalog/units')
    .set('Authorization', 'Bearer ' + token)
    .send({ name: 'Piece' });
  expect(unit.status, JSON.stringify(unit.body)).toBe(201);
  const product = await request(app.getHttpServer()).post('/api/v1/products')
    .set('Authorization', 'Bearer ' + token)
    .set('Idempotency-Key', Ulid.generate(clock))
    .send({
      name: 'Purchase Void Return Race Washer',
      baseUnitId: unit.body.data.units[0].id as string,
      purchasePriceMinor: 10_000, sellingPriceMinor: 12_000, minStockQty: 0,
      brandId: null, categoryId: null, sku: null, barcode: null,
      description: null, defaultDiscountType: null, defaultDiscountValue: null,
      offerEnabled: false, offerPriceMinor: null, offerStartDate: null,
      offerEndDate: null, tracksExpiry: false, tracksSerial: false,
      conversionUnitId: null, conversionFactorQty: null,
    });
  expect(product.status, JSON.stringify(product.body)).toBe(201);
  productId = product.body.data.id as string;
  const supplier = await request(app.getHttpServer()).post('/api/v1/parties')
    .set('Authorization', 'Bearer ' + token)
    .set('Idempotency-Key', Ulid.generate(clock))
    .send({
      name: 'Credit Return Supplier', roles: ['SUPPLIER'],
      phone: '01812345678', address: null, guardianName: null, nid: null,
      email: null, notes: null, customerGroupId: null, creditLimitMinor: null,
    });
  expect(supplier.status, JSON.stringify(supplier.body)).toBe(201);
  supplierId = supplier.body.data.id as string;
});
afterEach(async () => {
  await assertGoldenInvariants(pool, tenant.tenantId);
});

describe('MOD-003 #184: independent-process purchase cancellation vs supplier returns', () => {
  it('serializes two same-version purchase voids to one reversal source, journal, movement and outbox', async () => {
    const bill = await createBill();
    const children: ApiProcess[] = [];
    try {
      children.push(await startApi(), await startApi());
      const [a, b] = children as [ApiProcess, ApiProcess];
      expect(a.child.pid).not.toBe(b.child.pid);
      const body = { version: bill.version, reason: 'Duplicated bill' };
      const [one, two] = await Promise.all([
        post(a, '/api/v1/purchases/' + bill.id + '/void', body),
        post(b, '/api/v1/purchases/' + bill.id + '/void', body),
      ]);
      expect([one.status, two.status].filter((status) => status === 201)).toHaveLength(1);
      for (const loser of [one, two].filter((r) => r.status !== 201)) {
        expect([400, 409]).toContain(loser.status);
      }
      await expectPosting(bill.id, 'VOID');
    } finally {
      await Promise.all(children.map(stopApi));
    }
  }, 90_000);

  it('refuses voiding a posted purchase after a 2-unit supplier return, without refunding AP twice', async () => {
    const bill = await createBill();
    const children: ApiProcess[] = [];
    try {
      children.push(await startApi(), await startApi());
      const [a, b] = children as [ApiProcess, ApiProcess];
      const returned = await post(a, '/api/v1/purchase-returns', returnTwo(bill));
      expect(returned.status).toBe(201);
      const denied = await post(b, '/api/v1/purchases/' + bill.id + '/void', {
        version: bill.version, reason: 'Cannot void after return',
      });
      expect([400, 409]).toContain(denied.status);
      await expectPosting(bill.id, 'RETURN');
    } finally {
      await Promise.all(children.map(stopApi));
    }
  }, 90_000);

  it('arbitrates a concurrent supplier return against purchase void without double reversal', async () => {
    const bill = await createBill();
    const children: ApiProcess[] = [];
    try {
      children.push(await startApi(), await startApi());
      const [a, b] = children as [ApiProcess, ApiProcess];
      expect(a.child.pid).not.toBe(b.child.pid);
      const [voided, returned] = await Promise.all([
        post(a, '/api/v1/purchases/' + bill.id + '/void', { version: bill.version, reason: 'Voiding bill' }),
        post(b, '/api/v1/purchase-returns', returnTwo(bill)),
      ]);
      expect([voided.status, returned.status].filter((status) => status === 201)).toHaveLength(1);
      for (const loser of [voided, returned].filter((result) => result.status !== 201)) {
        expect([400, 409]).toContain(loser.status); // Neither SQL 500 nor silent success is acceptable.
      }
      await expectPosting(bill.id, voided.status === 201 ? 'VOID' : 'RETURN');
    } finally {
      await Promise.all(children.map(stopApi));
    }
  }, 90_000);
});
