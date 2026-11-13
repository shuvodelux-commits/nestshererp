/*
 * MOD-002 T02A/P4b: atomic Bengali/English CREATE acceptance on disposable
 * PostgreSQL16 ONLY (sher_test). Never run against retained/live data:
 * the existing resetDatabase helper truncates all test tenant tables.
 *
 * @covers endpoint:POST /api/v1/catalog/metadata-v1/units
 * @covers endpoint:POST /api/v1/catalog/metadata-v1/brands
 * @covers endpoint:POST /api/v1/catalog/metadata-v1/categories
 */
import 'reflect-metadata';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Permission } from '@sher/core-contracts';
import type pg from 'pg';
import request from 'supertest';
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { AppErrorFilter } from '../src/common/app-error.filter';
import { OUTBOX } from '../src/infrastructure/tokens';
import { signToken, TEST_JWT_SECRET } from './support/auth';
import type { SeededTenant } from './support/database';
import { asTenant, prepareTestDatabase, resetDatabase, seedTenant, testPool } from './support/database';

type Kind = 'units' | 'brands' | 'categories';
type Row = { id: string; name: string; nameBn: string | null; symbol?: string | null; parentId?: string | null; version: number };

const RIGHTS = [
  Permission.PRODUCT_VIEW,
  Permission.UNIT_MANAGE,
  Permission.BRAND_MANAGE,
  Permission.CATEGORY_MANAGE,
];

let app: INestApplication;
let pool: pg.Pool;
let a: SeededTenant;
let b: SeededTenant;
let tokenA: string;
let tokenB: string;

function create(
  kind: Kind,
  body: unknown,
  token = tokenA,
  server = app,
): request.Test {
  return request(server.getHttpServer())
    .post(`/api/v1/catalog/metadata-v1/${kind}`)
    .set('Authorization', `Bearer ${token}`)
    .send(body as object);
}

function rowByName(data: { data: Record<Kind, Row[]> }, kind: Kind, name: string): Row {
  const result = data.data[kind].find((item) => item.name === name);
  if (!result) throw new Error(`Missing ${kind} master ${name}`);
  return result;
}

async function effects(tenant: SeededTenant, entity: string, id: string): Promise<{ audit: number; outbox: number }> {
  return asTenant(pool, tenant.tenantId, async (client) => {
    const audit = await client.query<{ total: number }>(
      `SELECT count(*)::integer AS total FROM audit_events
       WHERE entity_type = $1 AND entity_id = $2 AND action = 'CREATE'`,
      [entity, id],
    );
    const outbox = await client.query<{ total: number }>(
      `SELECT count(*)::integer AS total FROM outbox
       WHERE event_type = $1 AND aggregate_id = $2`,
      [`${entity}.created`, id],
    );
    return { audit: audit.rows[0]?.total ?? 0, outbox: outbox.rows[0]?.total ?? 0 };
  });
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
  a = await seedTenant(pool, { name: 'Rahim Hardware', permissions: RIGHTS });
  b = await seedTenant(pool, { name: 'Karim Electrical', permissions: RIGHTS });
  tokenA = signToken(a, TEST_JWT_SECRET);
  tokenB = signToken(b, TEST_JWT_SECRET);
});

describe('metadata-v1 POST: atomic bilingual tenant master creation', () => {
  it('creates all three kinds in one request each, preserving canonical IDs and legacy response', async () => {
    const unit = await create('units', {
      name: ' Gauge ', nameBn: '  গেজ   একক ', symbol: ' Gg ',
    });
    expect(unit.status).toBe(201);
    const createdUnit = rowByName(unit.body, 'units', 'Gauge');
    expect(createdUnit).toMatchObject({
      name: 'Gauge', nameBn: 'গেজ একক', symbol: 'Gg', version: 1,
    });
    expect(createdUnit.id).toHaveLength(26);

    const brand = await create('brands', {
      name: ' Local ', nameBn: ' লোকাল ',
    });
    expect(brand.status).toBe(201);
    const createdBrand = rowByName(brand.body, 'brands', 'Local');
    expect(createdBrand).toMatchObject({ nameBn: 'লোকাল', version: 1 });

    const category = await create('categories', {
      name: 'Electrical', nameBn: ' বিদ্যুৎ ', parentId: null,
    });
    expect(category.status).toBe(201);
    const createdCategory = rowByName(category.body, 'categories', 'Electrical');
    expect(createdCategory).toMatchObject({ nameBn: 'বিদ্যুৎ', parentId: null, version: 1 });

    expect(await effects(a, 'unit', createdUnit.id)).toEqual({ audit: 1, outbox: 1 });
    expect(await effects(a, 'brand', createdBrand.id)).toEqual({ audit: 1, outbox: 1 });
    expect(await effects(a, 'category', createdCategory.id)).toEqual({ audit: 1, outbox: 1 });

    const db = await asTenant(pool, a.tenantId, (client) =>
      client.query<{ name_bn: string | null; symbol: string | null; version: number }>(
        'SELECT name_bn, symbol, version FROM units WHERE id = $1', [createdUnit.id],
      ),
    );
    expect(db.rows[0]).toEqual({ name_bn: 'গেজ একক', symbol: 'Gg', version: 1 });

    const legacy = await request(app.getHttpServer())
      .get('/api/v1/catalog').set('Authorization', `Bearer ${tokenA}`);
    expect(legacy.status).toBe(200);
    expect(legacy.body.data.units).toEqual([{ id: createdUnit.id, name: 'Gauge' }]);
    expect(legacy.body.data.brands).toEqual([{ id: createdBrand.id, name: 'Local' }]);
    expect(legacy.body.data.categories).toEqual([
      { id: createdCategory.id, name: 'Electrical', parentId: null },
    ]);
  });

  it('allows omitted metadata as SQL NULL; never invents a translation or unit symbol', async () => {
    const unit = await create('units', { name: 'Piece' });
    expect(unit.status).toBe(201);
    expect(rowByName(unit.body, 'units', 'Piece')).toMatchObject({
      nameBn: null, symbol: null, version: 1,
    });
    const brand = await create('brands', { name: 'Generic' });
    expect(brand.status).toBe(201);
    expect(rowByName(brand.body, 'brands', 'Generic')).toMatchObject({
      nameBn: null, version: 1,
    });
    const cat = await create('categories', { name: 'Others', parentId: null });
    expect(cat.status).toBe(201);
    expect(rowByName(cat.body, 'categories', 'Others')).toMatchObject({
      nameBn: null, parentId: null, version: 1,
    });
  });

  it('enforces sibling uniqueness and max two category levels', async () => {
    const first = await create('categories', { name: 'Electrical', parentId: null });
    expect(first.status).toBe(201);
    const parentId = rowByName(first.body, 'categories', 'Electrical').id;
    const child = await create('categories', { name: 'Cables', parentId });
    expect(child.status).toBe(201);
    const childId = rowByName(child.body, 'categories', 'Cables').id;

    const duplicate = await create('categories', { name: 'cables', parentId });
    expect(duplicate.status).toBe(400);
    const tooDeep = await create('categories', { name: 'Third Level', parentId: childId });
    expect(tooDeep.status).toBe(400);
    const brand = await create('brands', { name: 'RFL' });
    expect(brand.status).toBe(201);
    expect((await create('brands', { name: 'rfl' })).status).toBe(400);
    const unit = await create('units', { name: 'Piece' });
    expect(unit.status).toBe(201);
    expect((await create('units', { name: 'piece' })).status).toBe(400);

    const after = await request(app.getHttpServer())
      .get('/api/v1/catalog/metadata-v1').set('Authorization', `Bearer ${tokenA}`);
    expect(after.body.data.categories).toHaveLength(2);
    expect(after.body.data.brands).toHaveLength(1);
    expect(after.body.data.units).toHaveLength(1);
  });

  it('isolates tenants, rejects foreign parents and does not leak foreign master rows', async () => {
    const other = await create('categories', { name: 'Foreign Parent', parentId: null }, tokenB);
    expect(other.status).toBe(201);
    const foreignId = rowByName(other.body, 'categories', 'Foreign Parent').id;

    const invalid = await create('categories', {
      name: 'Child', parentId: foreignId,
    });
    expect(invalid.status).toBe(404);
    expect(invalid.body.error.code).toBe('NOT_FOUND');

    const own = await create('categories', { name: 'Foreign Parent', parentId: null });
    expect(own.status).toBe(201);
    expect(rowByName(own.body, 'categories', 'Foreign Parent').id).not.toBe(foreignId);
    const invisible = await asTenant(pool, a.tenantId, client =>
      client.query('SELECT id FROM categories WHERE id = $1', [foreignId]),
    );
    expect(invisible.rows).toEqual([]);
  });

  it('rejects missing authorization, no create permission and malformed payloads', async () => {
    expect((await request(app.getHttpServer())
      .post('/api/v1/catalog/metadata-v1/units')
      .send({ name: 'Piece' })).status).toBe(401);

    await asTenant(pool, a.tenantId, async client => {
      await client.query(
        'DELETE FROM role_permissions WHERE tenant_id = $1 AND role_id = $2 AND permission_code = $3',
        [a.tenantId, a.roleId, Permission.UNIT_MANAGE],
      );
    });
    const denied = await create('units', { name: 'Piece', nameBn: 'পিস' });
    expect(denied.status).toBe(403);

    const invalid = [
      { name: 'Empty Symbol', symbol: '' },
      { name: 'Too Long', symbol: 'ABCDE' },
      { name: 'Whitespace', symbol: 'A B' },
      { name: 'Wrong Version', version: 1 },
      { name: 'Blank Bengali', nameBn: '' },
      { name: 'Bad ID', id: '01ARZ3NDEKTSV4RRFFQ69G5FAV' },
    ];
    for (const value of invalid) {
      const result = await create('units', value, tokenB);
      expect(result.status).toBe(400);
      expect(result.body.error.code).toBe('VALIDATION_FAILED');
    }

    const check = await request(app.getHttpServer())
      .get('/api/v1/catalog/metadata-v1').set('Authorization', `Bearer ${tokenB}`);
    expect(check.body.data.units).toEqual([]);
  });

  it('rolls back the INSERT and CREATE audit when the outbox append fails', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(OUTBOX)
      .useValue({
        append: async (): Promise<void> => {
          throw new Error('synthetic outbox failure in disposable PG16 fixture');
        },
      })
      .compile();
    const failedApp = moduleRef.createNestApplication();
    failedApp.useGlobalFilters(new AppErrorFilter());
    await failedApp.init();
    try {
      const failure = await create('units', {
        name: 'Never Committed', nameBn: 'কমিট হয়নি', symbol: 'Nc',
      }, tokenA, failedApp);
      expect(failure.status).toBe(500);
      expect(failure.body.error.code).toBe('INTERNAL_ERROR');
    } finally {
      await failedApp.close();
    }

    const row = await asTenant(pool, a.tenantId, client =>
      client.query('SELECT id FROM units WHERE name = $1', ['Never Committed']),
    );
    expect(row.rows).toEqual([]);
    const sideEffects = await asTenant(pool, a.tenantId, async client => {
      const audit = await client.query<{ total: number }>(
        "SELECT count(*)::integer AS total FROM audit_events WHERE entity_type = 'unit' AND action = 'CREATE'",
      );
      const outbox = await client.query<{ total: number }>(
        "SELECT count(*)::integer AS total FROM outbox WHERE event_type = 'unit.created'",
      );
      return { audit: audit.rows[0]?.total ?? 0, outbox: outbox.rows[0]?.total ?? 0 };
    });
    expect(sideEffects).toEqual({ audit: 0, outbox: 0 });
  });
});
