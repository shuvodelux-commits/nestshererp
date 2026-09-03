/*
 * Coverage claims, read by `pnpm test:inventory` (owner request 2026-09-03).
 *
 * @covers endpoint:POST /api/v1/stock-counts
 * @covers endpoint:GET /api/v1/stock-counts
 * @covers endpoint:POST /api/v1/inventory/adjustments
 * @covers permission:stock.count.post
 * @covers workflow:stock-count
 */
import 'reflect-metadata';

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

/**
 * Counting the shelf and making the books agree with it (§5.13, §5.10).
 *
 * A stock count is the one operation whose entire purpose is to *change* what
 * the system believes, so it is the operation most able to break INV-02 and
 * INV-05 at once — and the golden invariants after each case are as much the
 * point of this file as the assertions inside it. The variance has to reach
 * `STOCK_ADJUSTMENT` rather than `COGS`: goods that were lost were not sold,
 * and burying shrinkage in cost of sales destroys the margin figure the shop is
 * run on (§3.11's note on the account).
 */

const clock = new SystemClock();
let app: INestApplication;
let pool: pg.Pool;
let tenant: SeededTenant;
let token: string;
let productId: string;

const PERMISSIONS = [
  Permission.STOCK_COUNT_POST, Permission.PRODUCT_VIEW, Permission.PRODUCT_CREATE,
  Permission.PRODUCT_EDIT, Permission.UNIT_MANAGE, Permission.COST_VIEW,
  Permission.INVENTORY_LOT_VIEW,
];

beforeAll(async () => {
  pool = testPool();
  await prepareTestDatabase();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.useGlobalFilters(new AppErrorFilter());
  await app.init();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

afterEach(async () => {
  await assertGoldenInvariants(pool, tenant.tenantId);
});

const api = (): ReturnType<typeof request> => request(app.getHttpServer());
const auth = (test: request.Test, as = token): request.Test =>
  test.set('Authorization', `Bearer ${as}`).set('Idempotency-Key', Ulid.generate(clock));

function must(response: request.Response, what: string): request.Response {
  if (response.status >= 400) {
    throw new Error(`${what} failed: ${String(response.status)} ${JSON.stringify(response.body)}`);
  }
  return response;
}

beforeEach(async () => {
  await resetDatabase(pool);
  tenant = await seedTenant(pool, { name: 'Stock Count Test', permissions: PERMISSIONS });
  token = signToken(tenant, TEST_JWT_SECRET);

  const unit = must(await auth(api().post('/api/v1/catalog/units')).send({ name: 'Piece' }), 'unit');
  const unitId = unit.body.data.units[0].id as string;

  const product = must(await auth(api().post('/api/v1/products')).send({
    name: 'Rice', baseUnitId: unitId,
    purchasePriceMinor: 100_00, sellingPriceMinor: 120_00, minStockQty: 0,
    brandId: null, categoryId: null, sku: null, barcode: null, description: null,
    defaultDiscountType: null, defaultDiscountValue: null, offerEnabled: false,
    offerPriceMinor: null, offerStartDate: null, offerEndDate: null,
    tracksExpiry: false, tracksSerial: false, conversionUnitId: null, conversionFactorQty: null,
  }), 'product');
  productId = product.body.data.id as string;

  // Twenty on the shelf at 100.00 — the shop's own belief, before anyone counts.
  must(await auth(api().post('/api/v1/inventory/openings'))
    .send({ productId, qty: 20_000 }), 'opening stock');
});

async function ledger(): Promise<Record<string, number>> {
  return asTenant(pool, tenant.tenantId, async (db) => {
    const rows = await db.query<{ account_code: string; total: string }>(
      `SELECT account_code, SUM(amount_minor)::bigint AS total
         FROM journal_lines GROUP BY account_code`,
    );
    return Object.fromEntries(rows.rows.map((row) => [row.account_code, Number(row.total)]));
  });
}

async function onHand(): Promise<number> {
  return asTenant(pool, tenant.tenantId, async (db) => {
    const row = await db.query<{ net: string }>(
      `SELECT COALESCE(SUM(CASE direction WHEN 'IN' THEN qty ELSE -qty END), 0)::bigint AS net
         FROM stock_movements WHERE product_id = $1`,
      [productId],
    );
    return Number(row.rows[0]?.net ?? 0);
  });
}

describe('counting the shelf (§5.13)', () => {
  it('writes the shortfall off to shrinkage, not to cost of sales', async () => {
    const counted = await auth(api().post('/api/v1/stock-counts')).send({
      scopeLabel: 'Rice shelf', note: 'Monthly count',
      lines: [{ productId, countedQty: 18_000, systemQty: 20_000 }],
    });
    expect(counted.status, JSON.stringify(counted.body)).toBeLessThan(300);

    const accounts = await ledger();
    expect(await onHand()).toBe(18_000);
    // Two sacks at 100.00 are gone.
    expect(accounts['INVENTORY']).toBe(1800_00);
    expect(accounts['STOCK_ADJUSTMENT']).toBe(200_00);
    // Not sold, so never cost of sales.
    expect(accounts['COGS'] ?? 0).toBe(0);
  });

  it('credits shrinkage when more is found than the books said', async () => {
    const counted = await auth(api().post('/api/v1/stock-counts')).send({
      scopeLabel: 'Rice shelf', note: null,
      lines: [{ productId, countedQty: 23_000, systemQty: 20_000 }],
    });
    expect(counted.status, JSON.stringify(counted.body)).toBeLessThan(300);

    const accounts = await ledger();
    expect(await onHand()).toBe(23_000);
    expect(accounts['INVENTORY']).toBe(2300_00);
    // A gain is a credit — the mirror of the write-off above.
    expect(accounts['STOCK_ADJUSTMENT']).toBe(-300_00);
  });

  it('posts nothing at all when the count agrees with the books', async () => {
    const counted = await auth(api().post('/api/v1/stock-counts')).send({
      scopeLabel: 'Rice shelf', note: null,
      lines: [{ productId, countedQty: 20_000, systemQty: 20_000 }],
    });
    expect(counted.status, JSON.stringify(counted.body)).toBeLessThan(300);

    const accounts = await ledger();
    expect(await onHand()).toBe(20_000);
    expect(accounts['INVENTORY']).toBe(2000_00);
    // Nothing happened, so nothing is recorded as having happened.
    expect(accounts['STOCK_ADJUSTMENT'] ?? 0).toBe(0);
  });

  it('refuses a negative counted quantity — you cannot count minus three', async () => {
    const refused = await auth(api().post('/api/v1/stock-counts')).send({
      scopeLabel: 'Rice shelf', note: null,
      lines: [{ productId, countedQty: -1_000, systemQty: 20_000 }],
    });
    expect(refused.status).toBe(400);
    expect(await onHand()).toBe(20_000);
  });

  it('is refused without stock.count.post', async () => {
    const clerk = await seedTenant(pool, {
      name: 'Stock Count Test', permissions: [Permission.PRODUCT_VIEW],
    });
    const refused = await auth(
      api().post('/api/v1/stock-counts'), signToken(clerk, TEST_JWT_SECRET),
    ).send({
      scopeLabel: 'Rice shelf', note: null,
      lines: [{ productId, countedQty: 18_000, systemQty: 20_000 }],
    });
    expect(refused.status).toBe(403);
  });
});

describe('correcting one product’s stock (§5.10)', () => {
  it('records a loss against shrinkage and moves the shelf', async () => {
    const adjusted = await auth(api().post('/api/v1/inventory/adjustments')).send({
      productId, qtyDelta: -3_000, reason: 'DAMAGE', note: 'Rain got in',
    });
    expect(adjusted.status, JSON.stringify(adjusted.body)).toBeLessThan(300);

    const accounts = await ledger();
    expect(await onHand()).toBe(17_000);
    expect(accounts['INVENTORY']).toBe(1700_00);
    expect(accounts['STOCK_ADJUSTMENT']).toBe(300_00);
  });

  it('refuses writing off more than is there (§5.10)', async () => {
    const refused = await auth(api().post('/api/v1/inventory/adjustments')).send({
      productId, qtyDelta: -50_000, reason: 'DAMAGE', note: 'Typo',
    });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.status).toBeLessThan(500);
    expect(await onHand()).toBe(20_000);
  });

  it('refuses an adjustment of nothing', async () => {
    const refused = await auth(api().post('/api/v1/inventory/adjustments')).send({
      productId, qtyDelta: 0, reason: 'RECOUNT', note: null,
    });
    expect(refused.status).toBe(400);
  });
});
