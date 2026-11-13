/*
 * MOD-007 M7-01b2-P0B-I: owner-authorized real unprivileged PostgreSQL16 API
 * negative tests. Use ONLY a fresh disposable TEST_DATABASE_URL / ADMIN_DATABASE_URL.
 *
 * @covers endpoint:GET /api/v1/sales/pos-products
 * @covers permission:sale.invoice.create
 */
import 'reflect-metadata';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Permission, SettingKey } from '@sher/core-contracts';
import { SystemClock, Ulid } from '@sher/shared-utils';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { AppErrorFilter } from '../src/common/app-error.filter';
import { signToken, TEST_JWT_SECRET } from './support/auth';
import type { SeededTenant } from './support/database';
import {
  asTenant, prepareTestDatabase, resetDatabase, seedTenant,
  seedWalkInCustomer, testPool,
} from './support/database';

const clock = new SystemClock();
let app: INestApplication;
let pool: pg.Pool;
let tenant: SeededTenant;
let token: string;
let unitId: string;

const rights = [
  Permission.SALE_CREATE, Permission.PRODUCT_VIEW, Permission.PRODUCT_CREATE,
  Permission.UNIT_MANAGE, Permission.COST_VIEW, Permission.INVENTORY_LOT_VIEW,
  Permission.SETTING_VIEW, Permission.SETTING_EDIT,
];

interface PosItem {
  id: string;
  name: string;
  stockStatus: 'IN_STOCK' | 'LOW_STOCK' | 'ZERO_STOCK' | 'NEGATIVE_STOCK';
  qtyOnHand: number;
  purchasePriceMinor?: number;
}
interface PosResult {
  items: PosItem[];
  nextCursor: string | null;
  negativeStockPolicy: string;
}

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

const api = (): ReturnType<typeof request> => request(app.getHttpServer());
const authorized = (req: request.Test, as = token): request.Test =>
  req.set('Authorization', 'Bearer ' + as);

function assertGood(response: request.Response, action: string): void {
  expect(response.status, action + ': ' + JSON.stringify(response.body)).toBeLessThan(400);
}

beforeEach(async () => {
  await resetDatabase(pool);
  tenant = await seedTenant(pool, { name: 'POS V2 Paging QA', permissions: rights });
  token = signToken(tenant, TEST_JWT_SECRET);
  await seedWalkInCustomer(pool, tenant);
  const unit = await authorized(api().post('/api/v1/catalog/units')).send({ name: 'Piece' });
  assertGood(unit, 'Create unit');
  unitId = unit.body.data.units[0].id as string;
});

async function createProduct(name: string, opts: {
  sku?: string; barcode?: string; minStockQty?: number;
} = {}): Promise<string> {
  const created = await authorized(api().post('/api/v1/products'))
    .set('Idempotency-Key', Ulid.generate(clock))
    .send({
      name, baseUnitId: unitId, purchasePriceMinor: 1000,
      sellingPriceMinor: 2000, minStockQty: opts.minStockQty ?? 1000,
      brandId: null, categoryId: null,
      sku: opts.sku ?? null, barcode: opts.barcode ?? null,
      description: null, defaultDiscountType: null, defaultDiscountValue: null,
      offerEnabled: false, offerPriceMinor: null,
      offerStartDate: null, offerEndDate: null, tracksExpiry: false,
      tracksSerial: false, conversionUnitId: null, conversionFactorQty: null,
    });
  assertGood(created, 'Create product ' + name);
  return created.body.data.id as string;
}

async function stockOpening(productId: string, qty: number): Promise<void> {
  const result = await authorized(api().post('/api/v1/inventory/openings'))
    .set('Idempotency-Key', Ulid.generate(clock))
    .send({ productId, qty });
  assertGood(result, 'Open stock ' + productId);
}

async function search(
  args: Record<string, string | number> = {},
  as = token,
): Promise<request.Response> {
  return authorized(api().get('/api/v1/sales/pos-products').query(args), as);
}

describe('GLOBAL_V2 SQL-wide product order / cursor', () => {
  it('orders exact barcode, SKU, name and name prefix before weak earlier IDs', async () => {
    const filler = await createProduct('Electric wire collection');
    const prefix = await createProduct('Wire coil');
    const exact = await createProduct('Wire');
    const sku = await createProduct('Fuse', { sku: 'wire' });
    const barcode = await createProduct('Cable', { barcode: 'wire' });

    const expected = [barcode, sku, exact, prefix, filler];
    const found: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const args: Record<string, string | number> = {
        rankingMode: 'GLOBAL_V2', search: 'wire', limit: 2,
      };
      if (cursor !== null) args.cursor = cursor;
      const response = await search(args);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const body = response.body as PosResult;
      expect(body.items.length).toBeLessThanOrEqual(2);
      found.push(...body.items.map((item) => item.id));
      if (body.nextCursor === null) break;
      expect(body.nextCursor.startsWith('v2.')).toBe(true);
      cursor = body.nextCursor;
    }
    expect(found).toEqual(expected);
    expect(new Set(found).size).toBe(5);
  });

  it('keeps legacy ID-based clients and bare response format unchanged', async () => {
    await createProduct('Wire B');
    await createProduct('Wire A');
    await createProduct('Wire C');
    const response = await search({ search: 'wire', limit: 1 });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const result = response.body as PosResult;
    expect(result.items).toHaveLength(1);
    expect(result.nextCursor).not.toBeNull();
    expect(result.nextCursor?.startsWith('v2.')).toBe(false);
    expect(Object.keys(result).sort()).toEqual(['items', 'negativeStockPolicy', 'nextCursor']);
  });

  it('filters stock state before LIMIT even when earlier IDs are ZERO_STOCK', async () => {
    await createProduct('Wire no stock A');
    await createProduct('Wire no stock B');
    const low = await createProduct('Wire low stock', { minStockQty: 2000 });
    await stockOpening(low, 1000);
    const answer = await search({
      rankingMode: 'GLOBAL_V2', search: 'wire', stockStatus: 'LOW_STOCK', limit: 1,
    });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    const result = answer.body as PosResult;
    expect(result.items.map((x) => x.id)).toEqual([low]);
    expect(result.items[0]?.stockStatus).toBe('LOW_STOCK');
    expect(result.nextCursor).toBeNull();
  });

  it('preserves BLOCK expiry stock semantics and WARN/ALLOW live-stock semantics', async () => {
    const expiring = await createProduct('Expiring wire', { minStockQty: 1000 });
    await stockOpening(expiring, 2000);
    await asTenant(pool, tenant.tenantId, async (db) => {
      await db.query("UPDATE inventory_lots SET expiry_date = '2000-01-01' WHERE product_id = $1", [expiring]);
    });
    const blocked = await search({
      rankingMode: 'GLOBAL_V2', search: 'expiring',
      stockStatus: 'ZERO_STOCK', limit: 1,
    });
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(200);
    expect((blocked.body as PosResult).items.map((x) => x.id)).toEqual([expiring]);
    const policy = await authorized(api().post('/api/v1/settings/value'))
      .send({ key: SettingKey.EXPIRED_STOCK_SALE_POLICY, value: 'WARN' });
    assertGood(policy, 'Set expiry WARN');
    const warning = await search({
      rankingMode: 'GLOBAL_V2', search: 'expiring',
      stockStatus: 'IN_STOCK', limit: 1,
    });
    expect(warning.status, JSON.stringify(warning.body)).toBe(200);
    expect((warning.body as PosResult).items.map((x) => x.id)).toEqual([expiring]);
  });

  it('rejects cursor reuse after query changes, malformed v2 tokens, and v2 tokens in legacy mode', async () => {
    await createProduct('Wire one');
    await createProduct('Wire two');
    const first = await search({ rankingMode: 'GLOBAL_V2', search: 'wire', limit: 1 });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const cursor = (first.body as PosResult).nextCursor;
    expect(cursor).not.toBeNull();

    for (const query of [
      { rankingMode: 'GLOBAL_V2', search: 'changed', limit: 1, cursor },
      { rankingMode: 'GLOBAL_V2', search: 'wire', stockStatus: 'ZERO_STOCK', limit: 1, cursor },
      { rankingMode: 'GLOBAL_V2', search: 'wire', limit: 1, cursor: 'v2.invalid' },
      { search: 'wire', limit: 1, cursor },
    ]) {
      const bad = await search(query as Record<string, string | number>);
      expect(bad.status, JSON.stringify(bad.body)).toBe(400);
    }
  });

  it('keeps tenant/permission separation and omits cost without COST_VIEW', async () => {
    await createProduct('Private wire tenant A');
    const first = await search({ rankingMode: 'GLOBAL_V2', search: 'wire', limit: 1 });
    expect(first.status).toBe(200);
    expect((first.body as PosResult).items).toHaveLength(1);
    expect('purchasePriceMinor' in (first.body as PosResult).items[0]!).toBe(true);

    const secondTenant = await seedTenant(pool, {
      name: 'POS other tenant',
      permissions: [Permission.SALE_CREATE, Permission.PRODUCT_CREATE, Permission.UNIT_MANAGE],
    });
    const secondToken = signToken(secondTenant, TEST_JWT_SECRET);
    const other = await search({ rankingMode: 'GLOBAL_V2', search: 'wire' }, secondToken);
    expect(other.status).toBe(200);
    expect((other.body as PosResult).items).toHaveLength(0);

    const noCostProduct = await authorized(api().post('/api/v1/catalog/units'), secondToken)
      .send({ name: 'Piece' });
    assertGood(noCostProduct, 'Other tenant unit');
    const otherUnit = noCostProduct.body.data.units[0].id as string;
    const own = await authorized(api().post('/api/v1/products'), secondToken)
      .set('Idempotency-Key', Ulid.generate(clock))
      .send({
        name: 'Wire other', baseUnitId: otherUnit, purchasePriceMinor: 1000,
        sellingPriceMinor: 2000, minStockQty: 0, brandId: null, categoryId: null,
        sku: null, barcode: null, description: null,
        defaultDiscountType: null, defaultDiscountValue: null,
        offerEnabled: false, offerPriceMinor: null, offerStartDate: null, offerEndDate: null,
        tracksExpiry: false, tracksSerial: false, conversionUnitId: null, conversionFactorQty: null,
      });
    assertGood(own, 'Other tenant product');
    const visible = await search({ rankingMode: 'GLOBAL_V2', search: 'wire' }, secondToken);
    expect(visible.status, JSON.stringify(visible.body)).toBe(200);
    expect((visible.body as PosResult).items).toHaveLength(1);
    expect('purchasePriceMinor' in (visible.body as PosResult).items[0]!).toBe(false);
    expect((visible.body as PosResult).items[0]?.id).not.toBe(
      (first.body as PosResult).items[0]?.id,
    );

    const deniedTenant = await seedTenant(pool, { name: 'No-sale viewer', permissions: [Permission.PRODUCT_VIEW] });
    const denied = await search({ rankingMode: 'GLOBAL_V2', search: 'wire' }, signToken(deniedTenant, TEST_JWT_SECRET));
    expect(denied.status).toBe(403);
  });
  it('normalizes Bangla numerals and searches word fragments in either order', async () => {
    const bengali = await createProduct('মরিচ ২০০');
    await createProduct('মরিচ ১০০');
    const answer = await search({
      rankingMode: 'GLOBAL_V2', search: 'মরিচ 200', limit: 1,
    });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect((answer.body as PosResult).items.map((x) => x.id)).toEqual([bengali]);

    const phone = await createProduct('Samsung A15');
    const reversed = await search({
      rankingMode: 'GLOBAL_V2', search: 'a15 sam', limit: 1,
    });
    expect(reversed.status, JSON.stringify(reversed.body)).toBe(200);
    expect((reversed.body as PosResult).items.map((x) => x.id)).toEqual([phone]);
  });

  it('distinguishes NEGATIVE_STOCK from ZERO_STOCK in SQL using effective quantity', async () => {
    const negative = await createProduct('Wire negative balance');
    await stockOpening(negative, 1000);
    await asTenant(pool, tenant.tenantId, async (db) => {
      await db.query('UPDATE product_cost_state SET qty_on_hand = -1000 WHERE product_id = $1', [negative]);
    });
    const policy = await authorized(api().post('/api/v1/settings/value'))
      .send({ key: SettingKey.EXPIRED_STOCK_SALE_POLICY, value: 'WARN' });
    assertGood(policy, 'Expiry policy');
    const neg = await search({
      rankingMode: 'GLOBAL_V2', search: 'negative',
      stockStatus: 'NEGATIVE_STOCK', limit: 1,
    });
    expect(neg.status, JSON.stringify(neg.body)).toBe(200);
    expect((neg.body as PosResult).items.map((x) => x.id)).toEqual([negative]);
    expect((neg.body as PosResult).items[0]?.qtyOnHand).toBe(-1000);
    const zero = await search({
      rankingMode: 'GLOBAL_V2', search: 'negative',
      stockStatus: 'ZERO_STOCK', limit: 1,
    });
    expect(zero.status, JSON.stringify(zero.body)).toBe(200);
    expect((zero.body as PosResult).items).toHaveLength(0);
  });

  it('rejects a syntactically valid but altered continuation rank', async () => {
    await createProduct('Wire first');
    await createProduct('Wire second');
    const first = await search({ rankingMode: 'GLOBAL_V2', search: 'wire', limit: 1 });
    expect(first.status).toBe(200);
    const original = (first.body as PosResult).nextCursor;
    expect(original).not.toBeNull();
    const parts = (original as string).split('.');
    const rank = Number(parts[1]);
    const altered = ['v2', String(rank === 1010 ? 1000 : rank + 1), parts[2], parts[3]].join('.');
    const response = await search({
      rankingMode: 'GLOBAL_V2', search: 'wire', limit: 1, cursor: altered,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(400);
  });

});
