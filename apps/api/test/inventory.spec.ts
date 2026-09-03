/*
 * Coverage claims, read by `pnpm test:inventory` (owner request 2026-09-03).
 *
 * These are what this file is answerable for in the test matrix. A claim naming
 * something the inventory no longer contains fails the scan, so a screen renamed
 * out from under a test cannot leave the coverage report quietly overstating itself.
 *
 * @covers endpoint:DELETE /api/v1/products/:id
 * @covers endpoint:GET /api/v1/catalog
 * @covers endpoint:GET /api/v1/inventory
 * @covers endpoint:GET /api/v1/inventory/adjustments
 * @covers endpoint:GET /api/v1/inventory/cost-adjustments
 * @covers endpoint:GET /api/v1/inventory/lots
 * @covers endpoint:GET /api/v1/inventory/openings/:id
 * @covers endpoint:GET /api/v1/inventory/valuation
 * @covers endpoint:GET /api/v1/products/:id
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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { AppErrorFilter } from '../src/common/app-error.filter';
import { signToken, TEST_JWT_SECRET } from './support/auth';
import type { SeededTenant } from './support/database';
import { asTenant, prepareTestDatabase, resetDatabase, seedTenant, testPool, todayIn } from './support/database';
import { assertGoldenInvariants } from './support/invariants';

const clock = new SystemClock();
let app: INestApplication; let pool: pg.Pool; let tenant: SeededTenant; let token: string; let productId: string;

beforeAll(async () => {
  pool = testPool(); await prepareTestDatabase();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication(); app.useGlobalFilters(new AppErrorFilter()); await app.init();
});
afterAll(async () => { await app.close(); await pool.end(); });

/**
 * §3.11: whatever each test set out to prove, the five golden invariants also
 * have to be true when it finishes. Asserting them here rather than inside each
 * test is what makes them cost nothing to keep — a stock path added later is
 * covered the moment its test is written.
 */
afterEach(async () => { await assertGoldenInvariants(pool, tenant.tenantId); });

beforeEach(async () => {
  await resetDatabase(pool);
  tenant = await seedTenant(pool, { name: 'Inventory Test', permissions: [Permission.PRODUCT_VIEW, Permission.PRODUCT_CREATE, Permission.PRODUCT_EDIT, Permission.UNIT_MANAGE, Permission.COST_VIEW, Permission.INVENTORY_LOT_VIEW] });
  token = signToken(tenant, TEST_JWT_SECRET);
  const catalog = await request(app.getHttpServer()).post('/api/v1/catalog/units').set('Authorization', `Bearer ${token}`).send({ name: 'Piece' });
  const unitId = catalog.body.data.units[0].id as string;
  const product = await request(app.getHttpServer()).post('/api/v1/products').set('Authorization', `Bearer ${token}`).set('Idempotency-Key', Ulid.generate(clock)).send({
    name: 'Rice', baseUnitId: unitId, purchasePriceMinor: 10_000, sellingPriceMinor: 12_000, minStockQty: 2_000,
    brandId: null, categoryId: null, sku: null, barcode: null, description: null,
    defaultDiscountType: null, defaultDiscountValue: null, offerEnabled: false, offerPriceMinor: null,
    offerStartDate: null, offerEndDate: null, tracksExpiry: false, tracksSerial: false,
    conversionUnitId: null, conversionFactorQty: null,
  });
  productId = product.body.data.id as string;
});

describe('opening stock vertical path', () => {
  it('shows a newly created active product as zero stock before any movement exists', async () => {
    const overview = await request(app.getHttpServer()).get('/api/v1/inventory').set('Authorization', `Bearer ${token}`);
    expect(overview.status).toBe(200);
    expect(overview.body.data.stock).toEqual([expect.objectContaining({
      productId,
      productStatus: 'ACTIVE',
      stockStatus: 'ZERO_STOCK',
      qtyOnHand: 0,
      locationId: null,
      locationName: null,
      valueMinor: 0,
    })]);
    expect(overview.body.data.movements).toEqual([]);
  });

  it('requires and stores the opening lot expiry for an expiry-tracked product', async () => {
    await asTenant(pool, tenant.tenantId, (db) => db.query(
      `INSERT INTO settings (id, tenant_id, setting_key, value, created_at, updated_at, created_by, updated_by, version)
       VALUES ($1, $2, 'expiry_tracking_enabled', 'on', now(), now(), $3, $3, 1)`,
      [Ulid.generate(clock), tenant.tenantId, tenant.userId],
    ));
    const unit = await request(app.getHttpServer()).get('/api/v1/catalog').set('Authorization', `Bearer ${token}`);
    const expiryProduct = await request(app.getHttpServer()).post('/api/v1/products')
      .set('Authorization', `Bearer ${token}`).set('Idempotency-Key', Ulid.generate(clock)).send({
        name: 'Yogurt', baseUnitId: unit.body.data.units[0].id, purchasePriceMinor: 5_000, sellingPriceMinor: 6_000, minStockQty: 1_000,
        brandId: null, categoryId: null, sku: null, barcode: null, description: null,
        defaultDiscountType: null, defaultDiscountValue: null, offerEnabled: false, offerPriceMinor: null,
        offerStartDate: null, offerEndDate: null, tracksExpiry: true, tracksSerial: false,
        conversionUnitId: null, conversionFactorQty: null,
      });
    const missing = await request(app.getHttpServer()).post('/api/v1/inventory/openings')
      .set('Authorization', `Bearer ${token}`).set('Idempotency-Key', Ulid.generate(clock))
      .send({ productId: expiryProduct.body.data.id, qty: 2_000 });
    expect(missing.status).toBe(400);
    const saved = await request(app.getHttpServer()).post('/api/v1/inventory/openings')
      .set('Authorization', `Bearer ${token}`).set('Idempotency-Key', Ulid.generate(clock))
      .send({ productId: expiryProduct.body.data.id, qty: 2_000, expiryDate: '2026-12-31' });
    expect(saved.status).toBe(201);
    expect(saved.body.data.expiryDate).toBe('2026-12-31');
  });

  it('posts movement, lot, cost state, and a balanced ৳1,000 journal atomically', async () => {
    const opened = await request(app.getHttpServer()).post('/api/v1/inventory/openings')
      .set('Authorization', `Bearer ${token}`).set('Idempotency-Key', Ulid.generate(clock))
      .send({ productId, qty: 10_000, businessDate: todayIn(tenant.timezone) });
    expect(opened.status).toBe(201);
    expect(opened.body.data).toMatchObject({ productId, qty: 10_000, unitCost: 1_000_000, valueMinor: 100_000, locationName: 'Main Shop' });

    await asTenant(pool, tenant.tenantId, async (db) => {
      const [movement, lot, state, journal] = await Promise.all([
        db.query('SELECT qty, direction, unit_cost FROM stock_movements'),
        db.query('SELECT qty_received, qty_remaining, actual_unit_cost, owner_type FROM inventory_lots'),
        db.query('SELECT qty_on_hand, avg_unit_cost FROM product_cost_state'),
        db.query("SELECT account_code, amount_minor FROM journal_lines ORDER BY amount_minor DESC"),
      ]);
      expect(movement.rows).toEqual([{ qty: 10_000, direction: 'IN', unit_cost: 1_000_000 }]);
      expect(lot.rows).toEqual([{ qty_received: 10_000, qty_remaining: 10_000, actual_unit_cost: 1_000_000, owner_type: 'OWNED' }]);
      expect(state.rows).toEqual([{ qty_on_hand: 10_000, avg_unit_cost: 1_000_000 }]);
      expect(journal.rows).toEqual([{ account_code: 'INVENTORY', amount_minor: 100_000 }, { account_code: 'OPENING_EQUITY', amount_minor: -100_000 }]);
    });
    const valuation = await request(app.getHttpServer()).get('/api/v1/inventory/valuation').set('Authorization', `Bearer ${token}`);
    expect(valuation.status).toBe(200);
    expect(valuation.body.data).toEqual({
      method: 'FIFO',
      rows: [expect.objectContaining({ productId, qtyOnHand: 10_000, valueMinor: 100_000 })],
      totalValueMinor: 100_000,
      inventoryAccountMinor: 100_000,
      differenceMinor: 0,
      reconciled: true,
    });
    await asTenant(pool, tenant.tenantId, (db) => db.query(
      `INSERT INTO settings (id, tenant_id, setting_key, value, created_at, updated_at, created_by, updated_by, version)
       VALUES ($1, $2, 'sale_costing_method', 'AVERAGE', now(), now(), $3, $3, 1)`,
      [Ulid.generate(clock), tenant.tenantId, tenant.userId],
    ));
    const average = await request(app.getHttpServer()).get('/api/v1/inventory/valuation').set('Authorization', `Bearer ${token}`);
    expect(average.body.data).toMatchObject({
      method: 'AVERAGE',
      totalValueMinor: 100_000,
      inventoryAccountMinor: 100_000,
      differenceMinor: 0,
      reconciled: true,
    });
  });

  it('replays one opening and overview reports the same quantity and valuation', async () => {
    const operationId = Ulid.generate(clock); const body = { productId, qty: 10_000, businessDate: todayIn(tenant.timezone) };
    const first = await request(app.getHttpServer()).post('/api/v1/inventory/openings').set('Authorization', `Bearer ${token}`).set('Idempotency-Key', operationId).send(body);
    const second = await request(app.getHttpServer()).post('/api/v1/inventory/openings').set('Authorization', `Bearer ${token}`).set('Idempotency-Key', operationId).send(body);
    expect(second.body.data.id).toBe(first.body.data.id);
    const overview = await request(app.getHttpServer()).get('/api/v1/inventory').set('Authorization', `Bearer ${token}`);
    expect(overview.body.data.stock).toEqual([expect.objectContaining({ productId, qtyOnHand: 10_000, stockStatus: 'IN_STOCK', valueMinor: 100_000 })]);
    expect(overview.body.data.movements).toHaveLength(1);
  });

  it('opens the product lot from Inventory with its source and exact remaining value', async () => {
    const opened = await request(app.getHttpServer()).post('/api/v1/inventory/openings')
      .set('Authorization', `Bearer ${token}`).set('Idempotency-Key', Ulid.generate(clock))
      .send({ productId, qty: 10_000, businessDate: todayIn(tenant.timezone) });
    const lots = await request(app.getHttpServer()).get(`/api/v1/inventory/lots?productId=${productId}&sort=qtyRemaining&direction=DESC`)
      .set('Authorization', `Bearer ${token}`);
    expect(lots.status).toBe(200);
    expect(lots.body.data).toMatchObject({ valuationMethod: 'FIFO', page: { hasMore: false, nextCursor: null } });
    expect(lots.body.data.data).toEqual([expect.objectContaining({
      productId,
      sourceType: 'OPENING_STOCK',
      sourceNumber: opened.body.data.number,
      qtyReceived: 10_000,
      qtyRemaining: 10_000,
      actualUnitCost: 1_000_000,
      valueMinor: 100_000,
      status: 'OPEN',
    })]);
    const source = await request(app.getHttpServer()).get(`/api/v1/inventory/openings/${opened.body.data.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(source.status).toBe(200);
    expect(source.body.data).toMatchObject({
      id: opened.body.data.id,
      number: opened.body.data.number,
      productId,
      qty: 10_000,
      valueMinor: 100_000,
    });
  });

  it('returns 404 when another tenant tries to open this product’s lots', async () => {
    await request(app.getHttpServer()).post('/api/v1/inventory/openings')
      .set('Authorization', `Bearer ${token}`).set('Idempotency-Key', Ulid.generate(clock))
      .send({ productId, qty: 10_000, businessDate: todayIn(tenant.timezone) });
    const other = await seedTenant(pool, { name: 'Other Shop', permissions: [Permission.PRODUCT_VIEW, Permission.INVENTORY_LOT_VIEW] });
    const denied = await request(app.getHttpServer()).get(`/api/v1/inventory/lots?productId=${productId}`)
      .set('Authorization', `Bearer ${signToken(other, TEST_JWT_SECRET)}`);
    expect(denied.status).toBe(404);
    expect(denied.body.error.code).toBe('NOT_FOUND');
    const opening = await asTenant(pool, tenant.tenantId, (db) => db.query('SELECT id FROM stock_openings LIMIT 1'));
    const deniedSource = await request(app.getHttpServer()).get(`/api/v1/inventory/openings/${opening.rows[0].id as string}`)
      .set('Authorization', `Bearer ${signToken(other, TEST_JWT_SECRET)}`);
    expect(deniedSource.status).toBe(404);
  });

  it('omits every cost field without inventory.cost.view', async () => {
    await request(app.getHttpServer()).post('/api/v1/inventory/openings').set('Authorization', `Bearer ${token}`).set('Idempotency-Key', Ulid.generate(clock)).send({ productId, qty: 10_000, businessDate: todayIn(tenant.timezone) });
    await asTenant(pool, tenant.tenantId, (db) => db.query("DELETE FROM role_permissions WHERE permission_code = 'inventory.cost.view'"));
    const overview = await request(app.getHttpServer()).get('/api/v1/inventory').set('Authorization', `Bearer ${token}`);
    expect(overview.body.data.stock).toHaveLength(1);
    expect(overview.body.data.movements).toHaveLength(1);
    expect(JSON.stringify(overview.body)).not.toContain('unitCost');
    expect(JSON.stringify(overview.body)).not.toContain('valueMinor');
    const lots = await request(app.getHttpServer()).get(`/api/v1/inventory/lots?productId=${productId}`).set('Authorization', `Bearer ${token}`);
    expect(lots.status).toBe(200);
    expect(lots.body.data.data).toHaveLength(1);
    expect(JSON.stringify(lots.body)).not.toContain('UnitCost');
    expect(JSON.stringify(lots.body)).not.toContain('valueMinor');
    expect(JSON.stringify(lots.body)).not.toContain('landedCostTotal');
    const valuation = await request(app.getHttpServer()).get('/api/v1/inventory/valuation').set('Authorization', `Bearer ${token}`);
    expect(valuation.status).toBe(403);
  });
});

/**
 * Stock adjustment (§5.10, §5.13) — the routine correction path.
 *
 * Every number asserted here was written before the code (Gate 3): opening 10
 * at ৳100.00 is ৳1,000.00 of stock; removing 3 leaves 7 and takes ৳300.00 out
 * of `INVENTORY` and into `STOCK_ADJUSTMENT`; adding 5 back at the same cost
 * puts ৳500.00 the other way.
 */
describe('stock adjustment vertical path', () => {
  const today = () => todayIn(tenant.timezone);

  async function openTen(): Promise<void> {
    const opened = await request(app.getHttpServer())
      .post('/api/v1/inventory/openings')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', Ulid.generate(clock))
      .send({ productId, qty: 10_000, businessDate: today() });
    expect(opened.status).toBe(201);
  }

  function adjust(body: Record<string, unknown>, operationId = Ulid.generate(clock)) {
    return request(app.getHttpServer())
      .post('/api/v1/inventory/adjustments')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', operationId)
      .send(body);
  }

  it('removes damaged stock: 10 − 3 = 7, and ৳300.00 moves to STOCK_ADJUSTMENT', async () => {
    await openTen();

    const removed = await adjust({
      productId,
      qtyDelta: -3_000,
      reason: 'DAMAGE',
      note: 'Sack torn in the rain',
      businessDate: today(),
    });

    expect(removed.status).toBe(201);
    expect(removed.body.data).toMatchObject({
      productId,
      qtyDelta: -3_000,
      direction: 'OUT',
      qty: 3_000,
      reason: 'DAMAGE',
      valueMinor: 30_000,
      qtyOnHandAfter: 7_000,
    });

    await asTenant(pool, tenant.tenantId, async (db) => {
      const [movement, lot, state, lines, consumption] = await Promise.all([
        db.query("SELECT qty, direction FROM stock_movements WHERE source_document_type = 'STOCK_ADJUSTMENT'"),
        db.query('SELECT qty_received, qty_remaining, status FROM inventory_lots'),
        db.query('SELECT qty_on_hand, avg_unit_cost FROM product_cost_state'),
        db.query(`SELECT account_code, amount_minor FROM journal_lines
                    WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE source_document_type = 'STOCK_ADJUSTMENT')
                    ORDER BY amount_minor DESC`),
        db.query('SELECT qty, unit_cost_used FROM lot_consumptions'),
      ]);

      expect(movement.rows).toEqual([{ qty: 3_000, direction: 'OUT' }]);
      // DR13.11/INV-03: the lot is drawn down, never driven negative.
      expect(lot.rows).toEqual([{ qty_received: 10_000, qty_remaining: 7_000, status: 'OPEN' }]);
      expect(state.rows).toEqual([{ qty_on_hand: 7_000, avg_unit_cost: 1_000_000 }]);
      expect(lines.rows).toEqual([
        { account_code: 'STOCK_ADJUSTMENT', amount_minor: 30_000 },
        { account_code: 'INVENTORY', amount_minor: -30_000 },
      ]);
      expect(consumption.rows).toEqual([{ qty: 3_000, unit_cost_used: 1_000_000 }]);
    });

    // INV-05: after the write-off, valuation still equals the INVENTORY account.
    const valuation = await request(app.getHttpServer())
      .get('/api/v1/inventory/valuation')
      .set('Authorization', `Bearer ${token}`);
    expect(valuation.body.data).toMatchObject({
      totalValueMinor: 70_000,
      inventoryAccountMinor: 70_000,
      differenceMinor: 0,
      reconciled: true,
    });
  });

  it('adds found stock as its own lot, crediting STOCK_ADJUSTMENT ৳500.00', async () => {
    await openTen();

    const added = await adjust({ productId, qtyDelta: 5_000, reason: 'RECOUNT', businessDate: today() });

    expect(added.status).toBe(201);
    expect(added.body.data).toMatchObject({ direction: 'IN', qty: 5_000, valueMinor: 50_000, qtyOnHandAfter: 15_000 });

    await asTenant(pool, tenant.tenantId, async (db) => {
      const [lots, lines] = await Promise.all([
        db.query("SELECT qty_received, actual_unit_cost FROM inventory_lots WHERE source_document_type = 'STOCK_ADJUSTMENT'"),
        db.query(`SELECT account_code, amount_minor FROM journal_lines
                    WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE source_document_type = 'STOCK_ADJUSTMENT')
                    ORDER BY amount_minor DESC`),
      ]);
      expect(lots.rows).toEqual([{ qty_received: 5_000, actual_unit_cost: 1_000_000 }]);
      expect(lines.rows).toEqual([
        { account_code: 'INVENTORY', amount_minor: 50_000 },
        { account_code: 'STOCK_ADJUSTMENT', amount_minor: -50_000 },
      ]);
    });

    const valuation = await request(app.getHttpServer())
      .get('/api/v1/inventory/valuation')
      .set('Authorization', `Bearer ${token}`);
    expect(valuation.body.data).toMatchObject({
      totalValueMinor: 150_000,
      inventoryAccountMinor: 150_000,
      reconciled: true,
    });
  });

  // R-D3/R-E6: the same operation id twice is one document, not two write-offs.
  it('replays one adjustment rather than writing the damage off twice', async () => {
    await openTen();
    const operationId = Ulid.generate(clock);
    const body = { productId, qtyDelta: -3_000, reason: 'DAMAGE', note: null, businessDate: today() };

    const first = await adjust(body, operationId);
    const second = await adjust(body, operationId);

    expect(first.status).toBe(201);
    expect(second.body.data.id).toBe(first.body.data.id);

    const rows = await asTenant(pool, tenant.tenantId, (db) =>
      db.query('SELECT qty_on_hand FROM product_cost_state'),
    );
    expect(rows.rows).toEqual([{ qty_on_hand: 7_000 }]);
  });

  it('refuses to remove more than is in stock, naming what is there', async () => {
    await openTen();

    const refused = await adjust({ productId, qtyDelta: -12_000, reason: 'DAMAGE', businessDate: today() });

    expect(refused.status).toBe(400);
    // Phase 8.2's owner rule: quantities read `10`, not `10.000`.
    expect(refused.body.error.message).toContain('Only 10 in stock');

    const rows = await asTenant(pool, tenant.tenantId, (db) =>
      db.query('SELECT qty_on_hand FROM product_cost_state'),
    );
    expect(rows.rows).toEqual([{ qty_on_hand: 10_000 }]);
  });

  it('refuses a zero adjustment and an unexplained "Other"', async () => {
    await openTen();

    expect((await adjust({ productId, qtyDelta: 0, reason: 'DAMAGE' })).status).toBe(400);
    expect((await adjust({ productId, qtyDelta: -1_000, reason: 'OTHER', note: null })).status).toBe(400);
    expect((await adjust({ productId, qtyDelta: -1_000, reason: 'OTHER', note: 'Given as a sample' })).status).toBe(201);
  });

  it('omits the adjustment value without inventory.cost.view', async () => {
    await openTen();
    await adjust({ productId, qtyDelta: -3_000, reason: 'DAMAGE', businessDate: today() });
    await asTenant(pool, tenant.tenantId, (db) =>
      db.query("DELETE FROM role_permissions WHERE permission_code = 'inventory.cost.view'"),
    );

    const listed = await request(app.getHttpServer())
      .get('/api/v1/inventory/adjustments')
      .set('Authorization', `Bearer ${token}`);

    expect(listed.status).toBe(200);
    expect(listed.body.data).toHaveLength(1);
    expect(JSON.stringify(listed.body)).not.toContain('valueMinor');

    const costs = await request(app.getHttpServer())
      .get('/api/v1/inventory/cost-adjustments')
      .set('Authorization', `Bearer ${token}`);
    expect(costs.status).toBe(403);
  });

  it('returns 404 when another tenant adjusts this product', async () => {
    await openTen();
    const other = await seedTenant(pool, {
      name: 'Other Shop',
      permissions: [Permission.PRODUCT_VIEW, Permission.PRODUCT_EDIT],
    });

    const denied = await request(app.getHttpServer())
      .post('/api/v1/inventory/adjustments')
      .set('Authorization', `Bearer ${signToken(other, TEST_JWT_SECRET)}`)
      .set('Idempotency-Key', Ulid.generate(clock))
      .send({ productId, qtyDelta: -1_000, reason: 'DAMAGE' });

    expect(denied.status).toBe(404);
    expect(denied.body.error.code).toBe('NOT_FOUND');
  });
});

/**
 * §3.6: a product nothing refers to is removable; one with stock history is
 * archived instead. The check is made server-side inside the transaction, not
 * by the dialog reading a quantity it happens to be showing.
 */
describe('deleting a product once stock exists', () => {
  it('refuses the delete and says to deactivate instead', async () => {
    await asTenant(pool, tenant.tenantId, (db) =>
      db.query(
        `INSERT INTO role_permissions (id, tenant_id, role_id, permission_code, created_at, updated_at, created_by, updated_by, version)
         VALUES ($1, $2, (SELECT id FROM roles WHERE tenant_id = $2 LIMIT 1), 'catalog.product.delete', now(), now(), $3, $3, 1)
         ON CONFLICT DO NOTHING`,
        [Ulid.generate(clock), tenant.tenantId, tenant.userId],
      ),
    );

    await request(app.getHttpServer())
      .post('/api/v1/inventory/openings')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', Ulid.generate(clock))
      .send({ productId, qty: 10_000, businessDate: todayIn(tenant.timezone) });

    const refused = await request(app.getHttpServer())
      .delete(`/api/v1/products/${productId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toContain('Deactivate it instead');

    const rows = await asTenant(pool, tenant.tenantId, (db) =>
      db.query('SELECT deleted_at FROM products WHERE id = $1', [productId]),
    );
    expect(rows.rows).toEqual([{ deleted_at: null }]);
  });

  it('reports the product as having stock history so the row menu hides Delete', async () => {
    const before = await request(app.getHttpServer())
      .get(`/api/v1/products/${productId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(before.body.data).toMatchObject({ hasStockHistory: false, stockQty: 0, stockStatus: 'ZERO_STOCK' });

    await request(app.getHttpServer())
      .post('/api/v1/inventory/openings')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', Ulid.generate(clock))
      .send({ productId, qty: 10_000, businessDate: todayIn(tenant.timezone) });

    const after = await request(app.getHttpServer())
      .get(`/api/v1/products/${productId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(after.body.data).toMatchObject({
      hasStockHistory: true,
      stockQty: 10_000,
      stockValueMinor: 100_000,
      stockStatus: 'IN_STOCK',
    });
  });
});
