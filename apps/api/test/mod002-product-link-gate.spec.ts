/*
 * MOD-002 interoperability: catalog metadata never changes Product identity,
 * inventory quantities, pricing, or historical references.
 * Disposable sher_test PostgreSQL16 only (resetDatabase TRUNCATES).
 *
 * @covers endpoint:POST /api/v1/products
 * @covers endpoint:GET /api/v1/products/:id
 * @covers endpoint:GET /api/v1/products
 * @covers endpoint:POST /api/v1/catalog/metadata-v1/units
 * @covers endpoint:POST /api/v1/catalog/metadata-v1/brands
 * @covers endpoint:POST /api/v1/catalog/metadata-v1/categories
 * @covers endpoint:PATCH /api/v1/catalog/metadata-v1/brands/:id
 * @covers endpoint:POST /api/v1/catalog/brands/:id/remove
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
import { asTenant, prepareTestDatabase, resetDatabase, seedTenant, testPool } from './support/database';

type Kind = 'units' | 'brands' | 'categories';
type Master = { id: string; name: string; nameBn: string | null; version: number };
const clock = new SystemClock();
const rights = [
  Permission.PRODUCT_VIEW, Permission.PRODUCT_CREATE, Permission.PRODUCT_EDIT,
  Permission.PRODUCT_DELETE, Permission.PRODUCT_DEACTIVATE, Permission.COST_VIEW,
  Permission.UNIT_MANAGE, Permission.BRAND_MANAGE, Permission.CATEGORY_MANAGE,
];

let app: INestApplication;
let pool: pg.Pool;
let tenantA: SeededTenant;
let tenantB: SeededTenant;
let tokenA: string;
let tokenB: string;
let unitId: string;
let brandId: string;
let rootId: string;
let childId: string;

function createMaster(kind: Kind, body: unknown, token = tokenA): request.Test {
  return request(app.getHttpServer())
    .post(`/api/v1/catalog/metadata-v1/${kind}`)
    .set('Authorization', `Bearer ${token}`)
    .send(body as object);
}
async function master(kind: Kind, body: { name: string; [key: string]: unknown }, token = tokenA): Promise<Master> {
  const response = await createMaster(kind, body, token);
  expect(response.status).toBe(201);
  const found = (response.body.data[kind] as Master[]).find(item => item.name === body.name);
  if (!found) throw new Error('Catalog master did not return a stable server ID');
  return found;
}
function product(overrides: Record<string, unknown> = {}, token = tokenA, operationId = Ulid.generate(clock)): request.Test {
  return request(app.getHttpServer()).post('/api/v1/products')
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', operationId)
    .send({
      name: 'Copper Wire',
      baseUnitId: unitId,
      purchasePriceMinor: 9750,
      sellingPriceMinor: 15500,
      minStockQty: 2000,
      brandId,
      categoryId: childId,
      sku: 'CW-1',
      barcode: '1234500000123',
      description: null,
      defaultDiscountType: null,
      defaultDiscountValue: null,
      offerEnabled: false,
      offerPriceMinor: null,
      offerStartDate: null,
      offerEndDate: null,
      tracksExpiry: false,
      tracksSerial: false,
      conversionUnitId: null,
      conversionFactorQty: null,
      ...overrides,
    });
}
function getProduct(id: string, token = tokenA): request.Test {
  return request(app.getHttpServer()).get(`/api/v1/products/${id}`)
    .set('Authorization', `Bearer ${token}`);
}
async function productCount(token = tokenA): Promise<number> {
  const result = await request(app.getHttpServer()).get('/api/v1/products')
    .set('Authorization', `Bearer ${token}`);
  expect(result.status).toBe(200);
  return result.body.summary.total as number;
}

beforeAll(async () => {
  pool = testPool();
  await prepareTestDatabase();
  const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = module.createNestApplication();
  app.useGlobalFilters(new AppErrorFilter());
  await app.init();
});
afterAll(async () => {
  await app.close();
  await pool.end();
});
beforeEach(async () => {
  await resetDatabase(pool);
  tenantA = await seedTenant(pool, { name: 'Copper A', permissions: rights });
  tenantB = await seedTenant(pool, { name: 'Copper B', permissions: rights });
  tokenA = signToken(tenantA, TEST_JWT_SECRET);
  tokenB = signToken(tenantB, TEST_JWT_SECRET);
  unitId = (await master('units', { name: 'Piece', nameBn: 'পিস', symbol: 'Pcs' })).id;
  brandId = (await master('brands', { name: 'RFL', nameBn: 'আরএফএল' })).id;
  rootId = (await master('categories', { name: 'Electrical', nameBn: 'ইলেকট্রিক', parentId: null })).id;
  childId = (await master('categories', { name: 'Cables', nameBn: 'কেবল', parentId: rootId })).id;
});

describe('MOD-002 real Product linkage and metadata compatibility', () => {
  it('uses stable bilingual-master IDs while preserving canonical Product fields and exact prices', async () => {
    const created = await product();
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      name: 'Copper Wire', displayName: 'RFL Copper Wire',
      brandId, categoryId: childId,
      brandName: 'RFL', categoryName: 'Cables', parentCategoryName: 'Electrical',
      baseUnitId: unitId, baseUnitName: 'Piece',
      purchasePriceMinor: 9750, sellingPriceMinor: 15500,
      minStockQty: 2000, stockQty: 0, version: 1,
    });
    const detail = await getProduct(created.body.data.id);
    expect(detail.status).toBe(200);
    expect(detail.body.data).toMatchObject({
      id: created.body.data.id,
      brandId, categoryId: childId, baseUnitId: unitId,
      stockQty: 0, purchasePriceMinor: 9750,
    });
    expect(await productCount()).toBe(1);
  });

  it('does not rewrite historical Product identity, price, stock or product version on metadata PATCH', async () => {
    const created = await product();
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;

    const changed = await request(app.getHttpServer())
      .patch(`/api/v1/catalog/metadata-v1/brands/${brandId}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ expectedVersion: 1, nameBn: 'আরএফএল নতুন' });
    expect(changed.status).toBe(200);
    const detail = await getProduct(id);
    expect(detail.status).toBe(200);
    expect(detail.body.data).toMatchObject({
      id, brandId, brandName: 'RFL', displayName: 'RFL Copper Wire',
      purchasePriceMinor: 9750, sellingPriceMinor: 15500,
      stockQty: 0, version: 1,
    });
    const db = await asTenant(pool, tenantA.tenantId, async client => {
      const journal = await client.query<{ count: number }>(
        'SELECT count(*)::integer AS count FROM journal_entries',
      );
      const movement = await client.query<{ count: number }>(
        'SELECT count(*)::integer AS count FROM stock_movements',
      );
      return { journal: journal.rows[0]?.count, movement: movement.rows[0]?.count };
    });
    expect(db).toEqual({ journal: 0, movement: 0 });
  });

  it('leaves product references intact when a used brand is archived and excludes it from fresh selection', async () => {
    const created = await product();
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;

    const remove = await request(app.getHttpServer())
      .post(`/api/v1/catalog/brands/${brandId}/remove`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(remove.status).toBe(200);
    expect(remove.body.data.outcome).toBe('ARCHIVED');

    const existing = await getProduct(id);
    expect(existing.status).toBe(200);
    expect(existing.body.data).toMatchObject({
      brandId, brandName: 'RFL', displayName: 'RFL Copper Wire',
    });
    const metadata = await request(app.getHttpServer())
      .get('/api/v1/catalog/metadata-v1')
      .set('Authorization', `Bearer ${tokenA}`);
    expect(metadata.body.data.brands).toEqual([]);
    const fresh = await product({ name: 'New Cable', sku: 'CW-2', barcode: '1234500000999' });
    expect(fresh.status).toBe(400);
    expect(await productCount()).toBe(1);
  });

  it('refuses cross-tenant unit, brand and category references without mutating Product records', async () => {
    const foreignUnit = (await master('units', { name: 'Foreign Unit' }, tokenB)).id;
    const foreignBrand = (await master('brands', { name: 'Foreign Brand' }, tokenB)).id;
    const foreignCategory = (await master('categories', {
      name: 'Foreign Category', parentId: null,
    }, tokenB)).id;

    for (const overrides of [
      { baseUnitId: foreignUnit },
      { brandId: foreignBrand },
      { categoryId: foreignCategory },
    ]) {
      const refused = await product(overrides);
      expect(refused.status).toBe(400);
      expect(refused.body.error.code).toBe('VALIDATION_FAILED');
    }
    expect(await productCount()).toBe(0);
    expect(await productCount(tokenB)).toBe(0);
  });

  it('refuses a deleted/archived unit or category for a new Product', async () => {
    // These two are not in use, so they can be removed outright.
    const orphanUnit = await master('units', { name: 'Orphan Unit', nameBn: 'এতিম' });
    const orphanCategory = await master('categories', {
      name: 'Orphan Category', parentId: null,
    });
    for (const [kind, id] of [
      ['units', orphanUnit.id], ['categories', orphanCategory.id],
    ] as const) {
      const removed = await request(app.getHttpServer())
        .post(`/api/v1/catalog/${kind}/${id}/remove`)
        .set('Authorization', `Bearer ${tokenA}`);
      expect(removed.status).toBe(200);
      expect(removed.body.data.outcome).toBe('DELETED');
    }

    expect((await product({ baseUnitId: orphanUnit.id })).status).toBe(400);
    expect((await product({ categoryId: orphanCategory.id })).status).toBe(400);
    expect(await productCount()).toBe(0);
  });

  it('never ships purchase cost or stock value when COST_VIEW is revoked after Product create', async () => {
    const created = await product();
    expect(created.status).toBe(201);
    expect(created.body.data).toHaveProperty('purchasePriceMinor');
    await asTenant(pool, tenantA.tenantId, async client => {
      await client.query(
        'DELETE FROM role_permissions WHERE tenant_id = $1 AND role_id = $2 AND permission_code = $3',
        [tenantA.tenantId, tenantA.roleId, Permission.COST_VIEW],
      );
    });
    const detail = await getProduct(created.body.data.id as string);
    expect(detail.status).toBe(200);
    expect(detail.body.data).not.toHaveProperty('purchasePriceMinor');
    expect(detail.body.data).not.toHaveProperty('stockValueMinor');
    const list = await request(app.getHttpServer()).get('/api/v1/products')
      .set('Authorization', `Bearer ${tokenA}`);
    expect(list.status).toBe(200);
    expect(list.body.data[0]).not.toHaveProperty('purchasePriceMinor');
    expect(list.body.data[0]).not.toHaveProperty('stockValueMinor');
  });

  it('keeps true Product idempotency separate from metadata master creation', async () => {
    const key = Ulid.generate(clock);
    const first = await product({}, tokenA, key);
    const replay = await product({}, tokenA, key);
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(first.body.data.id).toBe(replay.body.data.id);
    expect(await productCount()).toBe(1);

    const different = await product({ name: 'Another Cable' }, tokenA, key);
    expect(different.status).toBe(409);
    expect(different.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await productCount()).toBe(1);
  });

  it('preserves Product references when the canonical brand is renamed through the legacy contract', async () => {
    const created = await product();
    const id = created.body.data.id as string;
    const renamed = await request(app.getHttpServer())
      .patch(`/api/v1/catalog/brands/${brandId}`)
      .set('Authorization', `Bearer ${tokenA}`).send({ name: 'RFL Hardware' });
    expect(renamed.status).toBe(200);
    const detail = await getProduct(id);
    expect(detail.status).toBe(200);
    expect(detail.body.data).toMatchObject({
      id, brandId, brandName: 'RFL Hardware', displayName: 'RFL Hardware Copper Wire',
      version: 1, purchasePriceMinor: 9750, stockQty: 0,
    });
  });
});
