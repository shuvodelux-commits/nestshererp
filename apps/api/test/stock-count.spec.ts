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


/**
 * MOD-003 C003-07: private count valuation must remain correct when COST_VIEW
 * is absent, and count responses/replays must re-evaluate current permissions.
 */
async function setCostView(enabled: boolean): Promise<void> {
  await asTenant(pool, tenant.tenantId, async (db) => {
    await db.query(
      'DELETE FROM role_permissions WHERE role_id = $1 AND permission_code = $2',
      [tenant.roleId, Permission.COST_VIEW],
    );
    if (enabled) {
      await db.query(
        `INSERT INTO role_permissions
          (id, tenant_id, role_id, permission_code, created_at, updated_at, created_by, updated_by, version)
         VALUES ($1, $2, $3, $4, $5, $5, $6, $6, 1)`,
        [Ulid.generate(clock), tenant.tenantId, tenant.roleId, Permission.COST_VIEW,
          clock.now(), tenant.userId],
      );
    }
  });
}

describe('MOD-003 C003-07 stock count valuation and cost permissions', () => {
  it('cost-blind counter posts exact shrinkage and persists true amount without disclosing cost', async () => {
    await setCostView(false);
    const op = Ulid.generate(clock);
    const posted = await api().post('/api/v1/stock-counts')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', op)
      .send({ scopeLabel: 'Blind recount', note: null,
        lines: [{ productId, countedQty: 18_000, systemQty: 20_000 }] });
    expect(posted.status, JSON.stringify(posted.body)).toBeLessThan(300);
    expect(posted.body.data.shortageValueMinor).toBeUndefined();
    expect(posted.body.data.surplusValueMinor).toBeUndefined();
    expect(posted.body.data.lines[0].valueMinor).toBeUndefined();
    expect(posted.body.data.lines[0].qtyDelta).toBe(-2_000);

    const blindList = await auth(api().get('/api/v1/stock-counts'));
    expect(blindList.status).toBe(200);
    expect(blindList.body.data[0].shortageValueMinor).toBeUndefined();
    expect(blindList.body.data[0].surplusValueMinor).toBeUndefined();
    expect(blindList.body.data[0].lines[0].valueMinor).toBeUndefined();

    const stored = await asTenant(pool, tenant.tenantId, async (db) => {
      const result = await db.query<{shortage: string; surplus: string; line: string}>(
        `SELECT sc.shortage_value_minor::text AS shortage,
                sc.surplus_value_minor::text AS surplus,
                cl.value_minor::text AS line
           FROM stock_counts sc
           JOIN stock_count_lines cl ON cl.count_id = sc.id AND cl.tenant_id = sc.tenant_id
          WHERE sc.operation_id = $1`, [op]);
      return result.rows[0];
    });
    expect(stored?.shortage).toBe('20000');
    expect(stored?.surplus).toBe('0');
    expect(stored?.line).toBe('20000');
    expect((await ledger())['INVENTORY']).toBe(1800_00);
    expect((await ledger())['STOCK_ADJUSTMENT']).toBe(200_00);

    await setCostView(true);
    const authorized = await auth(api().get('/api/v1/stock-counts'));
    expect(authorized.status).toBe(200);
    expect(authorized.body.data[0].shortageValueMinor).toBe(200_00);
    expect(authorized.body.data[0].surplusValueMinor).toBe(0);
    expect(authorized.body.data[0].lines[0].valueMinor).toBe(200_00);
  });

  it('cost-blind surplus uses true booked FIFO/average value; no negative/false zero metadata', async () => {
    await setCostView(false);
    const posted = await auth(api().post('/api/v1/stock-counts'))
      .send({ scopeLabel: 'Surplus', note: null,
        lines: [{ productId, countedQty: 23_000, systemQty: 20_000 }] });
    expect(posted.status, JSON.stringify(posted.body)).toBeLessThan(300);
    expect(posted.body.data.surplusValueMinor).toBeUndefined();
    expect(posted.body.data.lines[0].valueMinor).toBeUndefined();
    expect((await ledger())['STOCK_ADJUSTMENT']).toBe(-300_00);
    await setCostView(true);
    const detail = await auth(api().get('/api/v1/stock-counts'));
    expect(detail.body.data[0].surplusValueMinor).toBe(300_00);
    expect(detail.body.data[0].lines[0].valueMinor).toBe(300_00);
    expect(await onHand()).toBe(23_000);
  });

  it('replay does not leak cached cost after permission revocation or book a second stock change', async () => {
    const operationId = Ulid.generate(clock);
    const body = { scopeLabel: 'Recheck', note: null,
      lines: [{ productId, countedQty: 18_000, systemQty: 20_000 }] };
    const send = () => api().post('/api/v1/stock-counts')
      .set('Authorization', `Bearer ${token}`).set('Idempotency-Key', operationId).send(body);
    const privileged = await send();
    expect(privileged.status, JSON.stringify(privileged.body)).toBeLessThan(300);
    expect(privileged.body.data.shortageValueMinor).toBe(200_00);
    const countId = privileged.body.data.id;

    await setCostView(false);
    const blindReplay = await send();
    expect(blindReplay.status, JSON.stringify(blindReplay.body)).toBeLessThan(300);
    expect(blindReplay.body.data.id).toBe(countId);
    expect(blindReplay.body.data.shortageValueMinor).toBeUndefined();
    expect(blindReplay.body.data.surplusValueMinor).toBeUndefined();
    expect(blindReplay.body.data.lines[0].valueMinor).toBeUndefined();

    expect(await onHand()).toBe(18_000);
    expect((await ledger())['STOCK_ADJUSTMENT']).toBe(200_00);
    const mismatched = await api().post('/api/v1/stock-counts')
      .set('Authorization', `Bearer ${token}`).set('Idempotency-Key', operationId)
      .send({ ...body, lines: [{ productId, countedQty: 19_000, systemQty: 20_000 }] });
    expect(mismatched.status).toBeGreaterThanOrEqual(400);

    await setCostView(true);
    const authorizedReplay = await send();
    expect(authorizedReplay.status).toBeLessThan(300);
    expect(authorizedReplay.body.data.id).toBe(countId);
    expect(authorizedReplay.body.data.shortageValueMinor).toBe(200_00);
    expect(await onHand()).toBe(18_000);
  });

  it('zero-delta count distinguishes cost absent from genuinely zero and keeps tenant isolation', async () => {
    await setCostView(false);
    const post = await auth(api().post('/api/v1/stock-counts'))
      .send({ scopeLabel: 'Unchanged', note: null,
        lines: [{ productId, countedQty: 20_000, systemQty: 20_000 }] });
    expect(post.status, JSON.stringify(post.body)).toBeLessThan(300);
    expect(post.body.data.lines[0].valueMinor).toBeUndefined();
    expect(post.body.data.shortageValueMinor).toBeUndefined();
    expect(post.body.data.differenceCount).toBe(0);
    await setCostView(true);
    const authorized = await auth(api().get('/api/v1/stock-counts'));
    expect(authorized.body.data[0].shortageValueMinor).toBe(0);
    expect(authorized.body.data[0].surplusValueMinor).toBe(0);
    expect(authorized.body.data[0].lines[0].valueMinor).toBe(0);

    const other = await seedTenant(pool, { name: 'Other Count Tenant',
      permissions: [Permission.STOCK_COUNT_POST, Permission.PRODUCT_VIEW, Permission.COST_VIEW] });
    const otherToken = signToken(other, TEST_JWT_SECRET);
    const otherList = await auth(api().get('/api/v1/stock-counts'), otherToken);
    expect(otherList.status).toBe(200);
    expect(otherList.body.data).toEqual([]);
    const wrongTenantPost = await auth(api().post('/api/v1/stock-counts'), otherToken)
      .send({ scopeLabel: 'Other', note: null,
        lines: [{ productId, countedQty: 20_000, systemQty: 20_000 }] });
    expect(wrongTenantPost.status).toBeGreaterThanOrEqual(400);
    expect((await ledger())['INVENTORY']).toBe(2000_00);
  });
});
