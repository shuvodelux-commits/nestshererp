/*
 * MOD-002 T02A / P3 — real PostgreSQL16 + Nest metadata acceptance.
 *
 * These tests run exclusively against the disposable sher_test database with
 * the existing unprivileged sher_app role and FORCE RLS. Never run them against
 * a retained, development or production database: resetDatabase truncates.
 *
 * @covers endpoint:GET /api/v1/catalog/metadata-v1
 * @covers endpoint:PATCH /api/v1/catalog/metadata-v1/units/:id
 * @covers endpoint:PATCH /api/v1/catalog/metadata-v1/brands/:id
 * @covers endpoint:PATCH /api/v1/catalog/metadata-v1/categories/:id
 */
import 'reflect-metadata';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Permission } from '@sher/core-contracts';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { AppErrorFilter } from '../src/common/app-error.filter';
import { OUTBOX } from '../src/infrastructure/tokens';
import { signToken, TEST_JWT_SECRET } from './support/auth';
import type { SeededTenant } from './support/database';
import { asTenant, prepareTestDatabase, resetDatabase, seedTenant, testPool } from './support/database';

type Kind = 'units' | 'brands' | 'categories';

interface MetadataRow {
  id: string;
  name: string;
  nameBn: string | null;
  symbol?: string | null;
  parentId?: string | null;
  version: number;
}

const ALL_PERMISSIONS = [
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
let unitId: string;
let brandId: string;
let categoryId: string;

function legacyGet(as = tokenA): request.Test {
  return request(app.getHttpServer())
    .get('/api/v1/catalog')
    .set('Authorization', `Bearer ${as}`);
}

function metadataGet(as = tokenA): request.Test {
  return request(app.getHttpServer())
    .get('/api/v1/catalog/metadata-v1')
    .set('Authorization', `Bearer ${as}`);
}

function patch(
  kind: Kind,
  id: string,
  body: unknown,
  as = tokenA,
  server = app,
): request.Test {
  return request(server.getHttpServer())
    .patch(`/api/v1/catalog/metadata-v1/${kind}/${id}`)
    .set('Authorization', `Bearer ${as}`)
    .send(body as object);
}

function createLegacy(kind: Kind, body: unknown, as = tokenA): request.Test {
  return request(app.getHttpServer())
    .post(`/api/v1/catalog/${kind}`)
    .set('Authorization', `Bearer ${as}`)
    .send(body as object);
}

function oneRow(body: { data: Record<Kind, MetadataRow[]> }, kind: Kind, id: string): MetadataRow {
  const row = body.data[kind].find((candidate) => candidate.id === id);
  if (row === undefined) throw new Error(`Missing master ${kind}/${id}`);
  return row;
}

async function countEffects(
  tenant: SeededTenant,
  entity: 'unit' | 'brand' | 'category',
  id: string,
): Promise<{ audits: number; events: number }> {
  return asTenant(pool, tenant.tenantId, async (client) => {
    const audits = await client.query<{ total: number }>(
      `SELECT count(*)::integer AS total
       FROM audit_events
       WHERE entity_type = $1 AND entity_id = $2 AND action = 'UPDATE'`,
      [entity, id],
    );
    const events = await client.query<{ total: number }>(
      `SELECT count(*)::integer AS total
       FROM outbox
       WHERE event_type = $1 AND aggregate_id = $2`,
      [`${entity}.updated`, id],
    );
    return { audits: audits.rows[0]?.total ?? 0, events: events.rows[0]?.total ?? 0 };
  });
}

beforeAll(async () => {
  pool = testPool();
  await prepareTestDatabase(); // migration 0055, isolated PostgreSQL16 only

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
  tenantA = await seedTenant(pool, { name: 'Karim Traders', permissions: ALL_PERMISSIONS });
  tenantB = await seedTenant(pool, { name: 'Rahim Stores', permissions: ALL_PERMISSIONS });
  tokenA = signToken(tenantA, TEST_JWT_SECRET);
  tokenB = signToken(tenantB, TEST_JWT_SECRET);

  const unit = await createLegacy('units', { name: 'Gauge' });
  expect(unit.status).toBe(201);
  unitId = (unit.body.data.units as { id: string; name: string }[])
    .find((row) => row.name === 'Gauge')?.id as string;
  expect(unitId).toHaveLength(26);

  const brand = await createLegacy('brands', { name: 'Local' });
  expect(brand.status).toBe(201);
  brandId = (brand.body.data.brands as { id: string; name: string }[])
    .find((row) => row.name === 'Local')?.id as string;
  expect(brandId).toHaveLength(26);

  const category = await createLegacy('categories', { name: 'Electrical', parentId: null });
  expect(category.status).toBe(201);
  categoryId = (category.body.data.categories as { id: string; name: string }[])
    .find((row) => row.name === 'Electrical')?.id as string;
  expect(categoryId).toHaveLength(26);
});

describe('metadata-v1: real tenant-scoped PostgreSQL acceptance', () => {
  it('returns explicit null metadata and row versions without changing the strict legacy read', async () => {
    const metadata = await metadataGet();
    expect(metadata.status).toBe(200);
    expect(oneRow(metadata.body, 'units', unitId)).toEqual({
      id: unitId, name: 'Gauge', nameBn: null, symbol: null, version: 1,
    });
    expect(oneRow(metadata.body, 'brands', brandId)).toEqual({
      id: brandId, name: 'Local', nameBn: null, version: 1,
    });
    expect(oneRow(metadata.body, 'categories', categoryId)).toEqual({
      id: categoryId, name: 'Electrical', nameBn: null, parentId: null, version: 1,
    });
    expect(Object.keys(metadata.body.data.features).sort()).toEqual([
      'customerGroups', 'expiryTracking', 'productOffers', 'serialTracking', 'vendors', 'warranty',
    ].sort());

    const legacy = await legacyGet();
    expect(legacy.status).toBe(200);
    expect(legacy.body.data.units).toEqual([{ id: unitId, name: 'Gauge' }]);
    expect(legacy.body.data.brands).toEqual([{ id: brandId, name: 'Local' }]);
    expect(legacy.body.data.categories).toEqual([
      { id: categoryId, name: 'Electrical', parentId: null },
    ]);

    const signedOut = await request(app.getHttpServer())
      .get('/api/v1/catalog/metadata-v1');
    expect(signedOut.status).toBe(401);
  });

  it('normalizes unit Bengali name and symbol; omitted preserves while null clears', async () => {
    const set = await patch('units', unitId, {
      expectedVersion: 1, nameBn: '  গেজ   তার  ', symbol: ' Gg ',
    });
    expect(set.status).toBe(200);
    expect(oneRow(set.body, 'units', unitId)).toMatchObject({
      id: unitId, name: 'Gauge', nameBn: 'গেজ তার', symbol: 'Gg', version: 2,
    });
    expect(await countEffects(tenantA, 'unit', unitId)).toEqual({ audits: 1, events: 1 });

    const omitBn = await patch('units', unitId, { expectedVersion: 2, symbol: null });
    expect(omitBn.status).toBe(200);
    expect(oneRow(omitBn.body, 'units', unitId)).toMatchObject({
      nameBn: 'গেজ তার', symbol: null, version: 3,
    });

    const clearBn = await patch('units', unitId, { expectedVersion: 3, nameBn: null });
    expect(clearBn.status).toBe(200);
    expect(oneRow(clearBn.body, 'units', unitId)).toMatchObject({
      nameBn: null, symbol: null, version: 4,
    });

    const database = await asTenant(pool, tenantA.tenantId, (client) =>
      client.query<{ name_bn: string | null; symbol: string | null; version: number }>(
        'SELECT name_bn, symbol, version FROM units WHERE id = $1', [unitId],
      ),
    );
    expect(database.rows[0]).toMatchObject({ name_bn: null, symbol: null, version: 4 });
    expect(await countEffects(tenantA, 'unit', unitId)).toEqual({ audits: 3, events: 3 });
    expect((await legacyGet()).body.data.units).toEqual([{ id: unitId, name: 'Gauge' }]);
  });

  it('edits brand and category metadata without changing identity, English name or parent', async () => {
    const brand = await patch('brands', brandId, { expectedVersion: 1, nameBn: '  লোকাল  ' });
    expect(brand.status).toBe(200);
    expect(oneRow(brand.body, 'brands', brandId)).toEqual({
      id: brandId, name: 'Local', nameBn: 'লোকাল', version: 2,
    });

    const category = await patch('categories', categoryId, {
      expectedVersion: 1, nameBn: 'বিদ্যুৎ',
    });
    expect(category.status).toBe(200);
    expect(oneRow(category.body, 'categories', categoryId)).toEqual({
      id: categoryId, name: 'Electrical', nameBn: 'বিদ্যুৎ',
      parentId: null, version: 2,
    });
    expect(await countEffects(tenantA, 'brand', brandId)).toEqual({ audits: 1, events: 1 });
    expect(await countEffects(tenantA, 'category', categoryId)).toEqual({ audits: 1, events: 1 });

    const legacyRename = await request(app.getHttpServer())
      .patch(`/api/v1/catalog/brands/${brandId}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Domestic' });
    expect(legacyRename.status).toBe(200);
    const afterRename = await metadataGet();
    expect(oneRow(afterRename.body, 'brands', brandId)).toMatchObject({
      id: brandId, name: 'Domestic', nameBn: 'লোকাল', version: 3,
    });
  });

  it('masks foreign tenant IDs as 404 and keeps tenant data RLS-invisible', async () => {
    const tenantBView = await metadataGet(tokenB);
    expect(tenantBView.status).toBe(200);
    expect(tenantBView.body.data.units).toEqual([]);
    expect(tenantBView.body.data.brands).toEqual([]);
    expect(tenantBView.body.data.categories).toEqual([]);

    const foreign = await patch('units', unitId, {
      expectedVersion: 1, nameBn: 'অন্য দোকান',
    }, tokenB);
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe('NOT_FOUND');

    const invisible = await asTenant(pool, tenantB.tenantId, (client) =>
      client.query('SELECT id FROM units WHERE id = $1', [unitId]),
    );
    expect(invisible.rows).toEqual([]);
    expect(oneRow((await metadataGet()).body, 'units', unitId).version).toBe(1);
    expect(await countEffects(tenantA, 'unit', unitId)).toEqual({ audits: 0, events: 0 });
  });

  it('enforces live permissions after JWT issuance with no metadata write', async () => {
    await asTenant(pool, tenantA.tenantId, async (client) => {
      await client.query(
        'DELETE FROM role_permissions WHERE tenant_id = $1 AND role_id = $2 AND permission_code = $3',
        [tenantA.tenantId, tenantA.roleId, Permission.UNIT_MANAGE],
      );
    });

    expect((await metadataGet()).status).toBe(200);
    const denied = await patch('units', unitId, { expectedVersion: 1, symbol: 'Gg' });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('PERMISSION_DENIED');
    expect(oneRow((await metadataGet()).body, 'units', unitId)).toMatchObject({
      symbol: null, version: 1,
    });
    expect(await countEffects(tenantA, 'unit', unitId)).toEqual({ audits: 0, events: 0 });
  });

  it('refuses stale versions as 409, with no duplicate audit or outbox', async () => {
    expect((await patch('units', unitId, { expectedVersion: 1, symbol: 'Gg' })).status).toBe(200);
    const before = await countEffects(tenantA, 'unit', unitId);
    const stale = await patch('units', unitId, { expectedVersion: 1, symbol: 'X' });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('CONFLICT_STALE_VERSION');
    expect(oneRow((await metadataGet()).body, 'units', unitId)).toMatchObject({
      symbol: 'Gg', version: 2,
    });
    expect(await countEffects(tenantA, 'unit', unitId)).toEqual(before);
  });

  it('rejects malformed bodies without mutating data or logging a metadata update', async () => {
    const refused = [
      { expectedVersion: 0, symbol: 'Gg' },
      { expectedVersion: 1, symbol: '' },
      { expectedVersion: 1, symbol: 'ABCDE' },
      { expectedVersion: 1, symbol: 'A B' },
      { expectedVersion: 1, nameBn: '' },
      { expectedVersion: 1, symbol: null, unknown: 'ignored?' },
      { expectedVersion: 1 },
    ];
    for (const body of refused) {
      const result = await patch('units', unitId, body);
      expect(result.status).toBe(400);
      expect(result.body.error.code).toBe('VALIDATION_FAILED');
    }
    expect(oneRow((await metadataGet()).body, 'units', unitId).version).toBe(1);
    expect(await countEffects(tenantA, 'unit', unitId)).toEqual({ audits: 0, events: 0 });
  });

  it('rolls back metadata and audit when the transaction outbox append fails', async () => {
    // Use the real UoW and database; only the OUTBOX test port is faulted.
    // The injected failure happens AFTER the SQL CAS and audit insert.
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(OUTBOX)
      .useValue({
        append: async (): Promise<void> => {
          throw new Error('synthetic outbox failure in disposable test database');
        },
      })
      .compile();
    const failedApp = moduleRef.createNestApplication();
    failedApp.useGlobalFilters(new AppErrorFilter());
    await failedApp.init();
    try {
      const error = await patch('units', unitId, {
        expectedVersion: 1, nameBn: 'বিফল হওয়া লেখা',
      }, tokenA, failedApp);
      expect(error.status).toBe(500);
      expect(error.body.error.code).toBe('INTERNAL_ERROR');
    } finally {
      await failedApp.close();
    }

    expect(oneRow((await metadataGet()).body, 'units', unitId)).toMatchObject({
      name: 'Gauge', nameBn: null, symbol: null, version: 1,
    });
    expect(await countEffects(tenantA, 'unit', unitId)).toEqual({ audits: 0, events: 0 });
  });
});
