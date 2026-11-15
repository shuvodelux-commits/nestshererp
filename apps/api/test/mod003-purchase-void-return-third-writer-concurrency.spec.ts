/*
 * MOD-003 #184: three-writer purchase VOID vs supplier RETURN vs credit SALE
 * or DAMAGE adjustment. Real distinct Nest OS processes + nonowner PG16 RLS.
 * Stacked on narrow lock-order PR #250; test-only, no business-source change.
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
let supplierId: string;
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
      Permission.SALE_CREATE, Permission.SALE_VIEW,
      Permission.CUSTOMER_VIEW, Permission.CUSTOMER_CREATE,
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
  // Credit sales are journal-only; they must never be forced through a cash session.
  await seedWalkInCustomer(pool, tenant);
  const customer = await request(app.getHttpServer()).post('/api/v1/parties')
    .set('Authorization', 'Bearer ' + token)
    .set('Idempotency-Key', Ulid.generate(clock))
    .send({
      name: 'Three Writer Race Customer', roles: ['CUSTOMER'], phone: '01712345678',
      address: null, guardianName: null, nid: null, email: null, notes: null,
      customerGroupId: null, creditLimitMinor: null,
    });
  expect(customer.status, JSON.stringify(customer.body)).toBe(201);
  customerId = customer.body.data.id as string;
});
afterEach(async () => {
  await assertGoldenInvariants(pool, tenant.tenantId);
});


type ApiResult = Awaited<ReturnType<typeof post>>;
type ThirdWriter = 'SALE' | 'DAMAGE';

function creditSale(server: ApiProcess): Promise<ApiResult> {
  return post(server, '/api/v1/sales', {
    partyId: customerId, customerName: null, customerPhone: null,
    lines: [{ productId, qty: 7_000, unitPriceMinor: 12_000, lineDiscountMinor: 0 }],
    payments: [], discountMinor: 0,
  });
}

function damageAdjustment(server: ApiProcess): Promise<ApiResult> {
  return post(server, '/api/v1/inventory/adjustments', {
    productId, qtyDelta: -7_000, reason: 'DAMAGE', note: null,
    businessDate: todayIn(tenant.timezone),
  });
}

async function sourceSideEffects(): Promise<{
  sales: number; adjustments: number;
  saleMovements: number; adjustmentMovements: number;
  saleJournals: number; adjustmentJournals: number;
  saleAudits: number; adjustmentAudits: number;
  saleEvents: number; adjustmentEvents: number;
  cogsMinor: number; adjustmentMinor: number; arMinor: number; revenueMinor: number;
}> {
  const query = [
    'SELECT',
    '(SELECT count(*)::integer FROM sales) AS sales,',
    '(SELECT count(*)::integer FROM stock_adjustments WHERE product_id = $1) AS adjustments,',
    "(SELECT count(*)::integer FROM stock_movements WHERE product_id = $1 AND source_document_type = 'SALE') AS \"saleMovements\",",
    "(SELECT count(*)::integer FROM stock_movements WHERE product_id = $1 AND source_document_type = 'STOCK_ADJUSTMENT') AS \"adjustmentMovements\",",
    "(SELECT count(*)::integer FROM journal_entries WHERE source_document_type = 'SALE') AS \"saleJournals\",",
    "(SELECT count(*)::integer FROM journal_entries WHERE source_document_type = 'STOCK_ADJUSTMENT') AS \"adjustmentJournals\",",
    "(SELECT count(*)::integer FROM audit_events WHERE entity_type = 'sale') AS \"saleAudits\",",
    "(SELECT count(*)::integer FROM audit_events WHERE entity_type = 'stock_adjustment') AS \"adjustmentAudits\",",
    "(SELECT count(*)::integer FROM outbox WHERE event_type = 'sale.posted') AS \"saleEvents\",",
    "(SELECT count(*)::integer FROM outbox WHERE event_type = 'inventory.stock-adjusted') AS \"adjustmentEvents\",",
    "(SELECT coalesce(sum(amount_minor),0)::integer FROM journal_lines WHERE account_code = 'COGS') AS \"cogsMinor\",",
    "(SELECT coalesce(sum(amount_minor),0)::integer FROM journal_lines WHERE account_code = 'STOCK_ADJUSTMENT') AS \"adjustmentMinor\",",
    "(SELECT coalesce(sum(amount_minor),0)::integer FROM journal_lines WHERE account_code = 'AR') AS \"arMinor\",",
    "(SELECT coalesce(sum(amount_minor),0)::integer FROM journal_lines WHERE account_code = 'SALES') AS \"revenueMinor\"",
  ].join(' ');
  const result = await asTenant(pool, tenant.tenantId, (db) => db.query(query, [productId]));
  const row = result.rows[0];
  if (!row) throw new Error('No tenant-scoped financial snapshot');
  return {
    sales: Number(row.sales), adjustments: Number(row.adjustments),
    saleMovements: Number(row.saleMovements),
    adjustmentMovements: Number(row.adjustmentMovements),
    saleJournals: Number(row.saleJournals),
    adjustmentJournals: Number(row.adjustmentJournals),
    saleAudits: Number(row.saleAudits), adjustmentAudits: Number(row.adjustmentAudits),
    saleEvents: Number(row.saleEvents), adjustmentEvents: Number(row.adjustmentEvents),
    cogsMinor: Number(row.cogsMinor), adjustmentMinor: Number(row.adjustmentMinor),
    arMinor: Number(row.arMinor), revenueMinor: Number(row.revenueMinor),
  };
}

async function assertThreeWriterOutcome(
  bill: PurchaseSeed,
  mode: ThirdWriter,
  voided: ApiResult,
  returned: ApiResult,
  third: ApiResult,
): Promise<void> {
  const success = (result: ApiResult) => result.status === 201;
  const winners = [voided, returned, third].filter(success);
  expect(winners.length).toBeGreaterThanOrEqual(1);
  for (const loser of [voided, returned, third].filter((response) => !success(response))) {
    // No PostgreSQL deadlock 500, silent success, or wrong-tenant leakage.
    expect([400, 409, 422]).toContain(loser.status);
  }
  const voidWon = success(voided);
  const returnWon = success(returned);
  const thirdWon = success(third);
  if (voidWon) {
    // A void can never coexist with sale/damage consumption or a return.
    expect(returnWon).toBe(false);
    expect(thirdWon).toBe(false);
    await expectPosting(bill.id, 'VOID');
  }

  const side = await sourceSideEffects();
  const saleCount = mode === 'SALE' && thirdWon ? 1 : 0;
  const damageCount = mode === 'DAMAGE' && thirdWon ? 1 : 0;
  expect(side).toEqual({
    sales: saleCount, adjustments: damageCount,
    saleMovements: saleCount, adjustmentMovements: damageCount,
    saleJournals: saleCount, adjustmentJournals: damageCount,
    saleAudits: saleCount, adjustmentAudits: damageCount,
    saleEvents: saleCount, adjustmentEvents: damageCount,
    cogsMinor: saleCount * 70_000, adjustmentMinor: damageCount * 70_000,
    arMinor: saleCount * 84_000, revenueMinor: saleCount === 0 ? 0 : -saleCount * 84_000,
  });

  if (voidWon) return;
  const qty = 10_000 - (returnWon ? 2_000 : 0) - (thirdWon ? 7_000 : 0);
  const value = qty * 10;
  const purchase = await snapshot(bill.id);
  expect(purchase).toMatchObject({
    billStatus: 'POSTED', purchases: 1,
    returns: returnWon ? 1 : 0,
    receiptMovements: 1,
    reversalMovements: 0, returnMovements: returnWon ? 1 : 0,
    receiptJournals: 1, reversalJournals: 0, returnJournals: returnWon ? 1 : 0,
    purchaseCreatedAudits: 1, purchaseVoidedAudits: 0,
    returnCreatedAudits: returnWon ? 1 : 0,
    purchasePostedOutbox: 1, purchaseVoidedOutbox: 0,
    returnPostedOutbox: returnWon ? 1 : 0,
    stockQty: qty, lotQty: qty, inventoryMinor: value,
    apMinor: -100_000 + (returnWon ? 20_000 : 0),
  });
  expect(qty).toBeGreaterThanOrEqual(0);
  const valuation = await request(app.getHttpServer())
    .get('/api/v1/inventory/valuation')
    .set('Authorization', 'Bearer ' + token);
  expect(valuation.status).toBe(200);
  expect(valuation.body.data).toMatchObject({
    totalValueMinor: value, inventoryAccountMinor: value,
    differenceMinor: 0, reconciled: true,
  });

  // A failed stale void must not post a later AP or stock reversal either.
  const stale = await request(app.getHttpServer())
    .post('/api/v1/purchases/' + bill.id + '/void')
    .set('Authorization', 'Bearer ' + token)
    .send({ version: bill.version, reason: 'Source already consumed' });
  expect([400, 409]).toContain(stale.status);
  expect(await snapshot(bill.id)).toEqual(purchase);
}

describe('MOD-003 #184: three independent posting writers share one source lot', () => {
  it.each([
    ['SALE', 1], ['SALE', 2], ['SALE', 3], ['SALE', 4], ['SALE', 5],
    ['DAMAGE', 1], ['DAMAGE', 2], ['DAMAGE', 3], ['DAMAGE', 4], ['DAMAGE', 5],
  ] as const)('%s vs purchase VOID and supplier RETURN (round %i)', async (mode, round) => {
    const bill = await createBill();
    const children: ApiProcess[] = [];
    try {
      children.push(await startApi(), await startApi(), await startApi());
      const [a, b, c] = children as [ApiProcess, ApiProcess, ApiProcess];
      expect(new Set(children.map((x) => x.child.pid)).size).toBe(3);
      type Action = 'void' | 'return' | 'third';
      const operations: Record<Action, () => Promise<ApiResult>> = {
        void: () => post(a, '/api/v1/purchases/' + bill.id + '/void', {
          version: bill.version, reason: 'Undo entire unpaid bill',
        }),
        return: () => post(b, '/api/v1/purchase-returns', returnTwo(bill)),
        third: () => mode === 'SALE' ? creditSale(c) : damageAdjustment(c),
      };
      // Change which independent Nest writer sends first; never serialize
      // their results and never rewrite fixture stock directly.
      const orders: readonly (readonly Action[])[] = [
        ['void', 'return', 'third'],
        ['third', 'return', 'void'],
        ['return', 'void', 'third'],
        ['third', 'void', 'return'],
        ['return', 'third', 'void'],
      ];
      const order = orders[round - 1];
      if (!order) throw new Error('Missing test permutation');
      const outcomes: Partial<Record<Action, ApiResult>> = {};
      await Promise.all(order.map(async (action) => {
        outcomes[action] = await operations[action]();
      }));
      const voided = outcomes.void;
      const returned = outcomes.return;
      const third = outcomes.third;
      if (!voided || !returned || !third) throw new Error('Missing a concurrent HTTP response');
      await assertThreeWriterOutcome(bill, mode, voided, returned, third);
    } finally {
      await Promise.all(children.map(stopApi));
    }
  }, 90_000);

  it('returns a typed conflict when a damage adjustment consumes a lot after void read but before void lock', async () => {
    // Hold the cost-state row so the independently started DAMAGE writer queues
    // before VOID. VOID takes the purchase lock and reads the lot before it
    // can take the cost-state lock. When the held lock releases, DAMAGE posts
    // first; a stale VOID must return a typed conflict and roll back its
    // source status, stock movements, AP/INVENTORY journal and outbox.
    const bill = await createBill();
    const servers: ApiProcess[] = [];
    try {
      servers.push(await startApi(), await startApi(), await startApi());
      const [voidServer, returnServer, damageServer] = servers as [ApiProcess, ApiProcess, ApiProcess];
      expect(new Set(servers.map((server) => server.child.pid)).size).toBe(3);

      let damagePending: Promise<ApiResult> | undefined;
      let voidPending: Promise<ApiResult> | undefined;
      let returnPending: Promise<ApiResult> | undefined;

      await asTenant(pool, tenant.tenantId, async (db) => {
        const lock = await db.query(
          'SELECT id FROM product_cost_state WHERE tenant_id = $1 AND product_id = $2 FOR UPDATE',
          [tenant.tenantId, productId],
        );
        expect(lock.rows).toHaveLength(1);

        damagePending = damageAdjustment(damageServer);
        await new Promise<void>((done) => setTimeout(done, 300));
        voidPending = post(voidServer, '/api/v1/purchases/' + bill.id + '/void', {
          version: bill.version, reason: 'Refuse stale source-lot reversal',
        });
        await new Promise<void>((done) => setTimeout(done, 300));
        returnPending = post(returnServer, '/api/v1/purchase-returns', returnTwo(bill));
        await new Promise<void>((done) => setTimeout(done, 200));
      });

      if (!damagePending || !voidPending || !returnPending) {
        throw new Error('Required three-process PostgreSQL race never started');
      }
      const [damaged, voided, returned] = await Promise.all([
        damagePending, voidPending, returnPending,
      ]);
      expect(damaged.status).toBe(201);
      expect(voided.status).toBe(409);
      expect(voided.error).toMatchObject({ code: 'CONFLICT_STALE_VERSION' });
      expect(returned.status).toBe(201);
      await assertThreeWriterOutcome(bill, 'DAMAGE', voided, returned, damaged);
    } finally {
      await Promise.all(servers.map(stopApi));
    }
  }, 90_000);

  it('commits a 7-unit credit sale and 2-unit supplier return, then rejects a source-bill void', async () => {
    const bill = await createBill();
    const children: ApiProcess[] = [];
    try {
      children.push(await startApi(), await startApi(), await startApi());
      const [a, b, c] = children as [ApiProcess, ApiProcess, ApiProcess];
      const sold = await creditSale(c);
      const returned = await post(b, '/api/v1/purchase-returns', returnTwo(bill));
      const voided = await post(a, '/api/v1/purchases/' + bill.id + '/void', {
        version: bill.version, reason: 'Must reject already consumed source',
      });
      expect(sold.status).toBe(201);
      expect(returned.status).toBe(201);
      await assertThreeWriterOutcome(bill, 'SALE', voided, returned, sold);
    } finally {
      await Promise.all(children.map(stopApi));
    }
  }, 90_000);
});
