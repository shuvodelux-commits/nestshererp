/*
 * Coverage claims, read by `pnpm test:inventory` (owner request 2026-09-03).
 *
 * These are what this file is answerable for in the test matrix. A claim naming
 * something the inventory no longer contains fails the scan, so a screen renamed
 * out from under a test cannot leave the coverage report quietly overstating itself.
 *
 * @covers endpoint:GET /api/v1/catalog
 * @covers endpoint:POST /api/v1/auth/registration
 * @covers endpoint:POST /api/v1/auth/registration/otp
 */
import 'reflect-metadata';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Permission, SEED_UNITS } from '@sher/core-contracts';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { AppErrorFilter } from '../src/common/app-error.filter';
import { signToken, TEST_JWT_SECRET } from './support/auth';
import type { SeededTenant } from './support/database';
import { asTenant, prepareTestDatabase, resetDatabase, seedTenant, testPool } from './support/database';

/**
 * Phase 2, path 2.1 — units, brands and categories (§5.5). Expected values
 * written before the code.
 *
 * The rules worth a test here are the ones a shopkeeper cannot see going wrong:
 *
 *   Names are unique **case-insensitively**. `Pran` and `pran` as two brands
 *   would split one supplier's products across two filters, and nobody would
 *   notice until a stock report came out short.
 *
 *   Categories go **two levels**, not three. A third level would give one
 *   product two competing group filters (§5.7's Category and Product
 *   Group/Subcategory), and no screen could say which one it belongs to.
 *
 *   Removing something in use must not silently take it out of records that
 *   already carry it (§3.6).
 */
const CATALOG_PERMISSIONS = [
  Permission.PRODUCT_VIEW,
  Permission.UNIT_MANAGE,
  Permission.BRAND_MANAGE,
  Permission.CATEGORY_MANAGE,
];

let app: INestApplication;
let pool: pg.Pool;
let tenantA: SeededTenant;
let tenantB: SeededTenant;
let tokenA: string;
let tokenB: string;

function getCatalog(token: string): request.Test {
  return request(app.getHttpServer())
    .get('/api/v1/catalog')
    .set('Authorization', `Bearer ${token}`);
}

function post(token: string, path: string, body: unknown = {}): request.Test {
  return request(app.getHttpServer())
    .post(`/api/v1/catalog${path}`)
    .set('Authorization', `Bearer ${token}`)
    .send(body as object);
}

function patch(token: string, path: string, body: unknown): request.Test {
  return request(app.getHttpServer())
    .patch(`/api/v1/catalog${path}`)
    .set('Authorization', `Bearer ${token}`)
    .send(body as object);
}

interface CategoryRow {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
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

beforeEach(async () => {
  await resetDatabase(pool);
  tenantA = await seedTenant(pool, { name: 'Karim Traders', permissions: CATALOG_PERMISSIONS });
  tenantB = await seedTenant(pool, { name: 'Rahim Stores', permissions: CATALOG_PERMISSIONS });
  tokenA = signToken(tenantA, TEST_JWT_SECRET);
  tokenB = signToken(tenantB, TEST_JWT_SECRET);
});

describe('units, brands and categories', () => {
  it('starts a business with the seven D-10 units and nothing else', async () => {
    const otp = await request(app.getHttpServer())
      .post('/api/v1/auth/registration/otp')
      .send({ identifier: '01712345678' });

    const created = await request(app.getHttpServer())
      .post('/api/v1/auth/registration')
      .send({
        identifier: '01712345678',
        otpCode: otp.body.data.devCode as string,
        businessName: 'Nabin Enterprise',
        username: 'nabin',
        password: 'Passw0rd23',
        pin: '4821',
      });
    expect(created.status).toBe(201);

    const catalog = await getCatalog(created.body.data.accessToken as string);

    expect(catalog.status).toBe(200);
    // Sorted by name, which is what the dropdown shows.
    expect(catalog.body.data.units.map((unit: { name: string }) => unit.name)).toEqual([
      'Box',
      'Carton',
      'Feet',
      'Kg',
      'Litre',
      'Piece',
      'Pipe',
    ]);
    expect(SEED_UNITS).toHaveLength(7);
    expect(catalog.body.data.brands).toEqual([]);
    expect(catalog.body.data.categories).toEqual([]);
  });

  it('normalises the stored name and refuses a duplicate whatever its case', async () => {
    const created = await post(tokenA, '/brands', { name: '  Coca   Cola  ' });

    expect(created.status).toBe(201);
    expect(created.body.data.brands).toEqual([
      { id: expect.any(String), name: 'Coca Cola' },
    ]);

    const clash = await post(tokenA, '/brands', { name: 'coca cola' });

    expect(clash.status).toBe(400);
    expect(clash.body.error.code).toBe('VALIDATION_FAILED');
    expect(clash.body.error.message).toBe('Coca Cola already exists as a brand');
  });

  it('lets two businesses each hold the same brand name', async () => {
    expect((await post(tokenA, '/brands', { name: 'Pran' })).status).toBe(201);
    expect((await post(tokenB, '/brands', { name: 'Pran' })).status).toBe(201);

    const inA = await getCatalog(tokenA);
    expect(inA.body.data.brands.map((brand: { name: string }) => brand.name)).toEqual(['Pran']);
  });

  it('renames a brand and audits what it was before', async () => {
    const created = await post(tokenA, '/brands', { name: 'Prann' });
    const brandId = created.body.data.brands[0].id as string;

    const renamed = await patch(tokenA, `/brands/${brandId}`, { name: 'Pran' });

    expect(renamed.status).toBe(200);
    expect(renamed.body.data.brands).toEqual([{ id: brandId, name: 'Pran' }]);

    const events = await asTenant(pool, tenantA.tenantId, (client) =>
      client.query<{ action: string; before_json: unknown; after_json: unknown }>(
        `SELECT action, before_json, after_json FROM audit_events
          WHERE entity_type = 'brand' AND entity_id = $1 ORDER BY id`,
        [brandId],
      ),
    );

    expect(events.rows.map((row) => row.action)).toEqual(['CREATE', 'UPDATE']);
    expect(events.rows[1]?.before_json).toEqual({ name: 'Prann' });
    expect(events.rows[1]?.after_json).toEqual({ name: 'Pran' });
  });

  it('accepts a subcategory but refuses a third level', async () => {
    const drinks = await post(tokenA, '/categories', { name: 'Drinks', parentId: null });
    const drinksId = drinks.body.data.categories[0].id as string;

    const juice = await post(tokenA, '/categories', { name: 'Juice', parentId: drinksId });
    expect(juice.status).toBe(201);
    const juiceId = (juice.body.data.categories as CategoryRow[]).find(
      (row) => row.name === 'Juice',
    )?.id;

    const tooDeep = await post(tokenA, '/categories', { name: 'Mango', parentId: juiceId });

    expect(tooDeep.status).toBe(400);
    expect(tooDeep.body.error.message).toBe(
      'Juice is already a subcategory. Categories go two levels deep, not three.',
    );
  });

  it('keeps sibling names unique but allows the same name under two parents', async () => {
    const shirts = await post(tokenA, '/categories', { name: 'Shirts', parentId: null });
    const shirtsId = shirts.body.data.categories[0].id as string;
    const pants = await post(tokenA, '/categories', { name: 'Pants', parentId: null });
    const pantsId = (pants.body.data.categories as CategoryRow[]).find(
      (row) => row.name === 'Pants',
    )?.id;

    expect((await post(tokenA, '/categories', { name: 'Small', parentId: shirtsId })).status).toBe(
      201,
    );
    expect((await post(tokenA, '/categories', { name: 'Small', parentId: pantsId })).status).toBe(
      201,
    );

    const clash = await post(tokenA, '/categories', { name: 'small', parentId: shirtsId });
    expect(clash.status).toBe(400);
    expect(clash.body.error.message).toBe('Small already exists as a category');
  });

  it('deletes an unused entry outright and refuses a category that still has children', async () => {
    const drinks = await post(tokenA, '/categories', { name: 'Drinks', parentId: null });
    const drinksId = drinks.body.data.categories[0].id as string;
    const juice = await post(tokenA, '/categories', { name: 'Juice', parentId: drinksId });
    const juiceId = (juice.body.data.categories as CategoryRow[]).find(
      (row) => row.name === 'Juice',
    )?.id as string;

    const refused = await post(tokenA, `/categories/${drinksId}/remove`);
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toBe(
      'This category still has subcategories. Remove them first, or remove one of them instead.',
    );

    const child = await post(tokenA, `/categories/${juiceId}/remove`);
    expect(child.status).toBe(200);
    expect(child.body.data.outcome).toBe('DELETED');

    const parent = await post(tokenA, `/categories/${drinksId}/remove`);
    expect(parent.status).toBe(200);
    expect(parent.body.data.outcome).toBe('DELETED');

    const remaining = await getCatalog(tokenA);
    expect(remaining.body.data.categories).toEqual([]);
  });

  it('lets a removed name be created again', async () => {
    const created = await post(tokenA, '/units', { name: 'Bosta' });
    const unitId = (created.body.data.units as { id: string; name: string }[]).find(
      (row) => row.name === 'Bosta',
    )?.id as string;

    expect((await post(tokenA, `/units/${unitId}/remove`)).status).toBe(200);
    expect((await post(tokenA, '/units', { name: 'Bosta' })).status).toBe(201);
  });
});

describe('who may change the catalog', () => {
  it('lets a product viewer read all three lists without managing any of them', async () => {
    const viewer = await seedTenant(pool, {
      name: 'Viewer only',
      permissions: [Permission.PRODUCT_VIEW],
    });
    const viewerToken = signToken(viewer, TEST_JWT_SECRET);

    expect((await getCatalog(viewerToken)).status).toBe(200);

    const refused = await post(viewerToken, '/brands', { name: 'Pran' });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('PERMISSION_DENIED');
  });

  it('keeps the three manage permissions separate', async () => {
    const brandsOnly = await seedTenant(pool, {
      name: 'Brands only',
      permissions: [Permission.PRODUCT_VIEW, Permission.BRAND_MANAGE],
    });
    const token = signToken(brandsOnly, TEST_JWT_SECRET);

    expect((await post(token, '/brands', { name: 'Pran' })).status).toBe(201);
    expect((await post(token, '/units', { name: 'Bosta' })).status).toBe(403);
    expect((await post(token, '/categories', { name: 'Drinks', parentId: null })).status).toBe(403);
  });

  it('cannot touch another tenant’s row, and is told 404 rather than 403', async () => {
    const created = await post(tokenA, '/brands', { name: 'Pran' });
    const brandId = created.body.data.brands[0].id as string;

    const renamed = await patch(tokenB, `/brands/${brandId}`, { name: 'Stolen' });
    expect(renamed.status).toBe(404);
    expect(renamed.body.error.code).toBe('NOT_FOUND');

    const removed = await post(tokenB, `/brands/${brandId}/remove`);
    expect(removed.status).toBe(404);

    // And nothing happened to it.
    const stillThere = await getCatalog(tokenA);
    expect(stillThere.body.data.brands).toEqual([{ id: brandId, name: 'Pran' }]);
  });
});
