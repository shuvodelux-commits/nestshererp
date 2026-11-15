/*
 * MOD-003 #184 C003-15: purchase CORRECTION vs DAMAGE on its own source lot.
 * Real independent Nest processes; non-owner disposable PG16 tenant RLS.
 * Test-only, stacked on the guarded purchase-reversal source PR #271.
 * @covers endpoint:POST /api/v1/purchases
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

type PostResult = { status: number; data: unknown; error: { code?: string } | undefined };

function requireDisposableRls(): void {
  const runtime = process.env['DATABASE_URL'];
  const admin = process.env['ADMIN_DATABASE_URL'];
  if (!runtime || !admin) throw new Error('Missing explicit disposable PG16 database credentials');
  const a = new URL(runtime);
  const b = new URL(admin);
  if (a.username !== 'sher_app' || b.username !== 'postgres' ||
      a.pathname !== '/sher_test' || b.pathname !== '/sher_test' ||
      !['127.0.0.1', 'localhost'].includes(a.hostname) ||
      !['127.0.0.1', 'localhost'].includes(b.hostname)) {
    throw new Error('Refusing to run correction race outside disposable non-owner sher_test RLS');
  }
}

async function port(): Promise<number> {
  return new Promise<number>((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        fail(new Error('No loopback port'));
        return;
      }
      server.close((error) => error === undefined ? done(address.port) : fail(error));
    });
  });
}

interface ApiProcess { readonly child: ChildProcess; readonly port: number }

async function stopApi(server: ApiProcess): Promise<void> {
  if (server.child.exitCode !== null || server.child.signalCode !== null) return;
  const exit = new Promise<void>((done) => server.child.once('exit', () => done()));
  server.child.kill('SIGTERM');
  await Promise.race([exit, new Promise<void>((done) => setTimeout(done, 2000))]);
  if (server.child.exitCode === null && server.child.signalCode === null) {
    server.child.kill('SIGKILL');
    await exit;
  }
}

async function startApi(): Promise<ApiProcess> {
  requireDisposableRls();
  const entry = resolve(__dirname, '../dist/main.js');
  if (!existsSync(entry)) throw new Error('Nest API must be compiled before cross-process QA');
  const listenPort = await port();
  const child = spawn(process.execPath, [entry], {
    cwd: resolve(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: process.env['DATABASE_URL'],
      JWT_SECRET: TEST_JWT_SECRET, ENTITLEMENT_SOURCE: 'subscription',
      NODE_ENV: 'test', PORT: String(listenPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', () => {});
  child.stderr?.on('data', () => {});
  const server = { child, port: listenPort };
  try {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error('Independent Nest process exited before readiness');
      }
      try {
        const r = await fetch('http://127.0.0.1:' + listenPort + '/health',
          { signal: AbortSignal.timeout(800) });
        if (r.status === 200) return server;
      } catch { /* health endpoint is not bound yet */ }
      await new Promise<void>((done) => setTimeout(done, 100));
    }
    throw new Error('Nest process readiness timeout');
  } catch (error) {
    await stopApi(server);
    throw error;
  }
}

async function postApi(server: ApiProcess, path: string, body: Record<string, unknown>,
  key = Ulid.generate(clock)): Promise<PostResult> {
  const r = await fetch('http://127.0.0.1:' + server.port + path, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json',
      'Idempotency-Key': key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const json = await r.json() as { data?: unknown; error?: { code?: string } };
  return { status: r.status, data: json.data, error: json.error };
}

function purchaseBody(correctionOf: string | null, price = 10_000) {
  return {
    supplierPartyId: supplierId, correctionOf,
    lines: [{ productId, qty: 10_000, unitPriceMinor: price }],
    discountMinor: 0, paidMinor: 0, paidAccountCode: null,
  };
}

async function currentPosting(originalId: string): Promise<{
  originalStatus: string; purchases: number; reversals: number;
  reversalMoves: number; correctionAudits: number; cancellationEvents: number;
  damageMoves: number; damageJournals: number;
  qtyOnHand: number; lotQty: number; inventoryMinor: number; apMinor: number;
  stockAdjustmentMinor: number;
}> {
  const q = [
    'SELECT',
    '(SELECT status FROM purchases WHERE id = $3) AS "originalStatus",',
    '(SELECT count(*)::integer FROM purchases) AS purchases,',
    "(SELECT count(*)::integer FROM journal_entries WHERE source_document_type = 'PURCHASE_REVERSAL' AND source_document_id = $3) AS reversals,",
    "(SELECT count(*)::integer FROM stock_movements WHERE source_document_type = 'PURCHASE_REVERSAL' AND source_document_id = $3) AS \"reversalMoves\",",
    "(SELECT count(*)::integer FROM audit_events WHERE entity_type = 'purchase' AND entity_id = $3 AND action = 'CORRECT') AS \"correctionAudits\",",
    "(SELECT count(*)::integer FROM outbox WHERE event_type = 'purchase.cancelled' AND aggregate_id = $3) AS \"cancellationEvents\",",
    "(SELECT count(*)::integer FROM stock_movements WHERE product_id = $1 AND source_document_type = 'STOCK_ADJUSTMENT') AS \"damageMoves\",",
    "(SELECT count(*)::integer FROM journal_entries WHERE source_document_type = 'STOCK_ADJUSTMENT') AS \"damageJournals\",",
    '(SELECT coalesce(sum(qty_on_hand),0)::integer FROM product_cost_state WHERE product_id = $1) AS "qtyOnHand",',
    "(SELECT coalesce(sum(qty_remaining),0)::integer FROM inventory_lots WHERE product_id = $1 AND owner_type = 'OWNED') AS \"lotQty\",",
    "(SELECT coalesce(sum(amount_minor),0)::integer FROM journal_lines WHERE account_code = 'INVENTORY') AS \"inventoryMinor\",",
    "(SELECT coalesce(sum(amount_minor),0)::integer FROM journal_lines WHERE account_code = 'AP' AND party_id = $2) AS \"apMinor\",",
    "(SELECT coalesce(sum(amount_minor),0)::integer FROM journal_lines WHERE account_code = 'STOCK_ADJUSTMENT') AS \"stockAdjustmentMinor\"",
  ].join(' ');
  const result = await asTenant(pool, tenant.tenantId, (db) =>
    db.query(q, [productId, supplierId, originalId]));
  const row = result.rows[0];
  if (!row) throw new Error('No RLS-scoped posting snapshot');
  return {
    originalStatus: String(row.originalStatus), purchases: Number(row.purchases),
    reversals: Number(row.reversals), reversalMoves: Number(row.reversalMoves),
    correctionAudits: Number(row.correctionAudits), cancellationEvents: Number(row.cancellationEvents),
    damageMoves: Number(row.damageMoves), damageJournals: Number(row.damageJournals),
    qtyOnHand: Number(row.qtyOnHand), lotQty: Number(row.lotQty),
    inventoryMinor: Number(row.inventoryMinor), apMinor: Number(row.apMinor),
    stockAdjustmentMinor: Number(row.stockAdjustmentMinor),
  };
}

beforeAll(async () => {
  requireDisposableRls();
  pool = testPool();
  await prepareTestDatabase();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.useGlobalFilters(new AppErrorFilter());
  await app.init();
});
afterAll(async () => { if (app) await app.close(); if (pool) await pool.end(); });
beforeEach(async () => {
  await resetDatabase(pool);
  tenant = await seedTenant(pool, {
    name: 'MOD003 Correction Stock Race',
    permissions: [
      Permission.PURCHASE_CREATE, Permission.PURCHASE_EDIT, Permission.PURCHASE_VIEW,
      Permission.PRODUCT_VIEW, Permission.PRODUCT_CREATE, Permission.PRODUCT_EDIT,
      Permission.UNIT_MANAGE, Permission.SUPPLIER_VIEW, Permission.SUPPLIER_CREATE,
      Permission.COST_VIEW, Permission.INVENTORY_LOT_VIEW,
    ],
  });
  token = signToken(tenant, TEST_JWT_SECRET);
  const unit = await request(app.getHttpServer()).post('/api/v1/catalog/units')
    .set('Authorization', 'Bearer ' + token).send({ name: 'Piece' });
  expect(unit.status, JSON.stringify(unit.body)).toBe(201);
  const product = await request(app.getHttpServer()).post('/api/v1/products')
    .set('Authorization', 'Bearer ' + token)
    .set('Idempotency-Key', Ulid.generate(clock))
    .send({
      name: 'Correction Race Washer', baseUnitId: unit.body.data.units[0].id,
      purchasePriceMinor: 10_000, sellingPriceMinor: 12_000, minStockQty: 0,
      brandId: null, categoryId: null, sku: null, barcode: null, description: null,
      defaultDiscountType: null, defaultDiscountValue: null, offerEnabled: false,
      offerPriceMinor: null, offerStartDate: null, offerEndDate: null,
      tracksExpiry: false, tracksSerial: false, conversionUnitId: null, conversionFactorQty: null,
    });
  expect(product.status, JSON.stringify(product.body)).toBe(201);
  productId = product.body.data.id as string;
  const supplier = await request(app.getHttpServer()).post('/api/v1/parties')
    .set('Authorization', 'Bearer ' + token)
    .set('Idempotency-Key', Ulid.generate(clock))
    .send({
      name: 'Correction Race Supplier', roles: ['SUPPLIER'], phone: '01812345678',
      address: null, guardianName: null, nid: null, email: null, notes: null,
      customerGroupId: null, creditLimitMinor: null,
    });
  expect(supplier.status, JSON.stringify(supplier.body)).toBe(201);
  supplierId = supplier.body.data.id as string;
});
afterEach(async () => { await assertGoldenInvariants(pool, tenant.tenantId); });

async function createOriginal(): Promise<string> {
  const result = await request(app.getHttpServer()).post('/api/v1/purchases')
    .set('Authorization', 'Bearer ' + token)
    .set('Idempotency-Key', Ulid.generate(clock))
    .send(purchaseBody(null));
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  return result.body.data.id as string;
}

describe('MOD-003 #184: PURCHASE CORRECTION shares guarded original-lot reversal', () => {
  it('accepts an intact credit-bill correction and idempotent retry without duplicate inventory/AP', async () => {
    const originalId = await createOriginal();
    const operationId = Ulid.generate(clock);
    const payload = purchaseBody(originalId, 11_000);
    const first = await request(app.getHttpServer()).post('/api/v1/purchases')
      .set('Authorization', 'Bearer ' + token)
      .set('Idempotency-Key', operationId).send(payload);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const retry = await request(app.getHttpServer()).post('/api/v1/purchases')
      .set('Authorization', 'Bearer ' + token)
      .set('Idempotency-Key', operationId).send(payload);
    expect(retry.status, JSON.stringify(retry.body)).toBe(201);
    expect(retry.body.data.id).toBe(first.body.data.id);
    expect(first.body.data.id).not.toBe(originalId);
    const state = await currentPosting(originalId);
    expect(state).toMatchObject({
      originalStatus: 'VOIDED', purchases: 2, reversals: 1,
      reversalMoves: 1, correctionAudits: 1, damageMoves: 0, damageJournals: 0,
      qtyOnHand: 10_000, lotQty: 10_000, inventoryMinor: 110_000,
      apMinor: -110_000, stockAdjustmentMinor: 0,
    });
    const valuation = await request(app.getHttpServer()).get('/api/v1/inventory/valuation')
      .set('Authorization', 'Bearer ' + token);
    expect(valuation.status).toBe(200);
    expect(valuation.body.data).toMatchObject({
      totalValueMinor: 110_000, inventoryAccountMinor: 110_000,
      differenceMinor: 0, reconciled: true,
    });
  }, 90_000);

  it('rejects a late correction with 409 after independently posted DAMAGE, without reversing AP or stock', async () => {
    const originalId = await createOriginal();
    const processes: ApiProcess[] = [];
    try {
      processes.push(await startApi(), await startApi());
      const [damageServer, correctionServer] = processes as [ApiProcess, ApiProcess];
      expect(damageServer.child.pid).not.toBe(correctionServer.child.pid);
      let damagePending: Promise<PostResult> | undefined;
      let correctionPending: Promise<PostResult> | undefined;
      // The two Nest processes wait on one real tenant cost-state row. DAMAGE
      // queues first. CORRECTION reads the untouched purchase source while the
      // original lot still appears full, then waits for the same lock.
      await asTenant(pool, tenant.tenantId, async (db) => {
        const locked = await db.query(
          'SELECT id FROM product_cost_state WHERE tenant_id = $1 AND product_id = $2 FOR UPDATE',
          [tenant.tenantId, productId],
        );
        expect(locked.rows).toHaveLength(1);
        damagePending = postApi(damageServer, '/api/v1/inventory/adjustments', {
          productId, qtyDelta: -7_000, reason: 'DAMAGE', note: null,
          businessDate: todayIn(tenant.timezone),
        });
        await new Promise<void>((done) => setTimeout(done, 300));
        correctionPending = postApi(correctionServer, '/api/v1/purchases',
          purchaseBody(originalId, 11_000));
        await new Promise<void>((done) => setTimeout(done, 350));
      });
      if (!damagePending || !correctionPending) throw new Error('Independent race was never started');
      const [damaged, correction] = await Promise.all([damagePending, correctionPending]);
      expect(damaged.status).toBe(201);
      expect(correction.status).toBe(409);
      expect(correction.error).toMatchObject({ code: 'CONFLICT_STALE_VERSION' });

      expect(await currentPosting(originalId)).toMatchObject({
        originalStatus: 'POSTED', purchases: 1, reversals: 0,
        reversalMoves: 0, correctionAudits: 0, cancellationEvents: 0,
        damageMoves: 1, damageJournals: 1,
        qtyOnHand: 3_000, lotQty: 3_000,
        inventoryMinor: 30_000, apMinor: -100_000,
        stockAdjustmentMinor: 70_000,
      });
      const valuation = await request(app.getHttpServer()).get('/api/v1/inventory/valuation')
        .set('Authorization', 'Bearer ' + token);
      expect(valuation.status).toBe(200);
      expect(valuation.body.data).toMatchObject({
        totalValueMinor: 30_000, inventoryAccountMinor: 30_000,
        differenceMinor: 0, reconciled: true,
      });
    } finally {
      await Promise.all(processes.map(stopApi));
    }
  }, 90_000);
});
