/*
 * Coverage claims, read by `pnpm test:inventory` (owner request 2026-09-03).
 *
 * These are what this file is answerable for in the test matrix. A claim naming
 * something the inventory no longer contains fails the scan, so a screen renamed
 * out from under a test cannot leave the coverage report quietly overstating itself.
 *
 * @covers endpoint:GET /api/v1/inventory/valuation
 * @covers endpoint:POST /api/v1/catalog/units
 * @covers endpoint:POST /api/v1/inventory/adjustments
 * @covers endpoint:POST /api/v1/inventory/openings
 * @covers endpoint:POST /api/v1/products
 */
import 'reflect-metadata';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Permission } from '@sher/core-contracts';
import { SystemClock, Ulid } from '@sher/shared-utils';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { AppErrorFilter } from '../src/common/app-error.filter';
import { signToken, TEST_JWT_SECRET } from './support/auth';
import type { SeededTenant } from './support/database';
import { asTenant, prepareTestDatabase, resetDatabase, seedTenant, testPool, todayIn } from './support/database';
import { assertGoldenInvariants } from './support/invariants';

/**
 * §3.11's golden invariants, on the two document types that can move stock
 * today: opening stock and stock adjustment. Purchase and sale arrive in
 * phases 5 and 6 and will post through the same lots, movements and journal —
 * `assertGoldenInvariants` is already watching, so the day they land, a costing
 * mistake fails here rather than in a shop.
 *
 * Everything runs twice, once per costing method (D-05). The physical path is
 * the same either way — a decrease always consumes lots in FIFO/FEFO order —
 * but the valuation basis is not, and INV-05 is the invariant that would catch
 * the two disagreeing.
 *
 * **What this cannot yet reach:** two live lots at *different* costs. An
 * adjustment increase takes its cost from the moving average, so every lot a
 * shop can create today is worth what its other stock is worth. The multi-cost
 * FIFO ladder (buy 10 @ 100, buy 10 @ 120, sell 15) needs a purchase document
 * to exist, and it is added here when one does.
 */

const clock = new SystemClock();
const METHODS = ['FIFO', 'AVERAGE'] as const;

let app: INestApplication;
let pool: pg.Pool;
let tenant: SeededTenant;
let token: string;
let riceId: string;
let teaId: string;

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

beforeEach(async () => {
  await resetDatabase(pool);
  tenant = await seedTenant(pool, {
    name: 'Invariant Test',
    permissions: [
      Permission.PRODUCT_VIEW, Permission.PRODUCT_CREATE, Permission.PRODUCT_EDIT,
      Permission.UNIT_MANAGE, Permission.COST_VIEW, Permission.INVENTORY_LOT_VIEW,
    ],
  });
  token = signToken(tenant, TEST_JWT_SECRET);
  const catalog = await request(app.getHttpServer())
    .post('/api/v1/catalog/units').set('Authorization', `Bearer ${token}`).send({ name: 'Piece' });
  const unitId = catalog.body.data.units[0].id as string;
  riceId = await createProduct(unitId, 'Rice', 10_000);
  // ৳33.33 is deliberate: seven of them value at ৳233.31, so INV-05 is checked
  // against a number that only comes out right if the rounding is right.
  teaId = await createProduct(unitId, 'Tea', 3_333);
});

async function createProduct(unitId: string, name: string, purchasePriceMinor: number): Promise<string> {
  const created = await request(app.getHttpServer())
    .post('/api/v1/products').set('Authorization', `Bearer ${token}`).set('Idempotency-Key', Ulid.generate(clock))
    .send({
      name, baseUnitId: unitId, purchasePriceMinor, sellingPriceMinor: purchasePriceMinor + 2_000, minStockQty: 2_000,
      brandId: null, categoryId: null, sku: null, barcode: null, description: null,
      defaultDiscountType: null, defaultDiscountValue: null, offerEnabled: false, offerPriceMinor: null,
      offerStartDate: null, offerEndDate: null, tracksExpiry: false, tracksSerial: false,
      conversionUnitId: null, conversionFactorQty: null,
    });
  expect(created.status).toBe(201);
  return created.body.data.id as string;
}

function open(productId: string, qty: number) {
  return request(app.getHttpServer())
    .post('/api/v1/inventory/openings').set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', Ulid.generate(clock))
    .send({ productId, qty, businessDate: todayIn(tenant.timezone) });
}

function adjust(productId: string, qtyDelta: number, reason: string) {
  return request(app.getHttpServer())
    .post('/api/v1/inventory/adjustments').set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', Ulid.generate(clock))
    .send({ productId, qtyDelta, reason, note: null, businessDate: todayIn(tenant.timezone) });
}

async function costOn(method: 'FIFO' | 'AVERAGE'): Promise<void> {
  if (method === 'FIFO') return; // the shipped default; an absent row is the answer
  await asTenant(pool, tenant.tenantId, (db) => db.query(
    `INSERT INTO settings (id, tenant_id, setting_key, value, created_at, updated_at, created_by, updated_by, version)
     VALUES ($1, $2, 'sale_costing_method', 'AVERAGE', now(), now(), $3, $3, 1)`,
    [Ulid.generate(clock), tenant.tenantId, tenant.userId],
  ));
}

describe.each(METHODS)('golden invariants under %s (§3.11)', (method) => {
  it('hold after every posting from opening stock through a decrease that crosses two lots', async () => {
    await costOn(method);

    // Nothing posted yet: zero stock and a zero INVENTORY account still have to
    // agree, or the invariants are only true once money exists.
    await assertGoldenInvariants(pool, tenant.tenantId);

    expect((await open(riceId, 10_000)).status).toBe(201);
    await assertGoldenInvariants(pool, tenant.tenantId);

    expect((await open(teaId, 7_000)).status).toBe(201);
    await assertGoldenInvariants(pool, tenant.tenantId);

    expect((await adjust(riceId, 5_000, 'RECOUNT')).status).toBe(201);
    await assertGoldenInvariants(pool, tenant.tenantId);

    // 12 out of 15 held across two lots: the opening lot of 10 empties and
    // closes, and the found-stock lot of 5 gives up 2 of its own.
    const removed = await adjust(riceId, -12_000, 'DAMAGE');
    expect(removed.status).toBe(201);
    expect(removed.body.data).toMatchObject({ direction: 'OUT', qty: 12_000, valueMinor: 120_000, qtyOnHandAfter: 3_000 });
    await assertGoldenInvariants(pool, tenant.tenantId);

    await asTenant(pool, tenant.tenantId, async (db) => {
      const lots = await db.query(
        `SELECT qty_received, qty_remaining, status FROM inventory_lots
          WHERE product_id = $1 ORDER BY business_date, created_at, id`,
        [riceId],
      );
      expect(lots.rows).toEqual([
        { qty_received: 10_000, qty_remaining: 0, status: 'CLOSED' },
        { qty_received: 5_000, qty_remaining: 3_000, status: 'OPEN' },
      ]);
    });

    // The same numbers the report shows the owner: ৳300.00 of rice and the
    // ৳233.31 of tea that proves the rounding.
    const valuation = await request(app.getHttpServer())
      .get('/api/v1/inventory/valuation').set('Authorization', `Bearer ${token}`);
    expect(valuation.body.data).toMatchObject({
      method,
      totalValueMinor: 53_331,
      inventoryAccountMinor: 53_331,
      differenceMinor: 0,
      reconciled: true,
    });
  });
});

/**
 * An invariant harness that has never failed proves nothing — the same reason
 * §6.1 makes Phase 0 demonstrate that the boundary checker catches a violation.
 * Each of these corrupts the database directly, behind the services' backs, in
 * the shape a real bug would leave.
 */
describe('the harness itself', () => {
  it('catches lots that stop adding up to the stock on hand (INV-04)', async () => {
    await open(riceId, 10_000);
    await asTenant(pool, tenant.tenantId, (db) => db.query(
      'UPDATE inventory_lots SET qty_remaining = qty_remaining - 1000 WHERE product_id = $1', [riceId],
    ));

    await expect(assertGoldenInvariants(pool, tenant.tenantId)).rejects.toThrow(/INV-04/);
  });

  it('catches stock on hand that stops matching its movements (INV-02)', async () => {
    await open(riceId, 10_000);
    await asTenant(pool, tenant.tenantId, (db) => db.query(
      'UPDATE stock_movements SET qty = qty + 500 WHERE product_id = $1', [riceId],
    ));

    await expect(assertGoldenInvariants(pool, tenant.tenantId)).rejects.toThrow(/INV-02/);
  });

  it('catches a journal that stops balancing, and the valuation drift with it (INV-01, INV-05)', async () => {
    await open(riceId, 10_000);
    await asTenant(pool, tenant.tenantId, (db) => db.query(
      `INSERT INTO journal_lines (id, tenant_id, created_at, created_by, journal_entry_id, account_code, amount_minor)
       SELECT $1, $2, now(), $3, id, 'INVENTORY', 5000 FROM journal_entries LIMIT 1`,
      [Ulid.generate(clock), tenant.tenantId, tenant.userId],
    ));

    const failure = await assertGoldenInvariants(pool, tenant.tenantId).catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/INV-01/);
    expect((failure as Error).message).toMatch(/INV-05/);
  });
});
