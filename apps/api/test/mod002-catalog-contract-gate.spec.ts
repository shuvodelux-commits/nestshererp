/*
 * MOD-002 complete implemented-catalog contract regression.
 * Real PG16 + Nest/Supertest, isolated sher_test only; resetDatabase TRUNCATES.
 *
 * @covers endpoint:GET /api/v1/catalog
 * @covers endpoint:GET /api/v1/catalog/metadata-v1
 * @covers endpoint:POST /api/v1/catalog/metadata-v1/units
 * @covers endpoint:POST /api/v1/catalog/metadata-v1/brands
 * @covers endpoint:POST /api/v1/catalog/metadata-v1/categories
 * @covers endpoint:PATCH /api/v1/catalog/metadata-v1/units/:id
 * @covers endpoint:PATCH /api/v1/catalog/metadata-v1/brands/:id
 * @covers endpoint:PATCH /api/v1/catalog/metadata-v1/categories/:id
 * @covers endpoint:POST /api/v1/catalog/brands/:id/remove
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
import { signToken, TEST_JWT_SECRET } from './support/auth';
import type { SeededTenant } from './support/database';
import { asTenant, prepareTestDatabase, resetDatabase, seedTenant, testPool } from './support/database';

type Kind = 'units' | 'brands' | 'categories';
type Row = {
  id: string; name: string; nameBn: string | null;
  symbol?: string | null; parentId?: string | null; version: number;
};
type Envelope = { data: Record<Kind, Row[]> };

const ALL = [
  Permission.PRODUCT_VIEW,
  Permission.UNIT_MANAGE,
  Permission.BRAND_MANAGE,
  Permission.CATEGORY_MANAGE,
];

let app: INestApplication;
let pool: pg.Pool;
let tenantA: SeededTenant;
let tenantB: SeededTenant;
let aToken: string;
let bToken: string;

function post(kind: Kind, body: unknown, token = aToken): request.Test {
  return request(app.getHttpServer())
    .post(`/api/v1/catalog/metadata-v1/${kind}`)
    .set('Authorization', `Bearer ${token}`)
    .send(body as object);
}
function patch(kind: Kind, id: string, body: unknown, token = aToken): request.Test {
  return request(app.getHttpServer())
    .patch(`/api/v1/catalog/metadata-v1/${kind}/${id}`)
    .set('Authorization', `Bearer ${token}`)
    .send(body as object);
}
function read(token = aToken): request.Test {
  return request(app.getHttpServer())
    .get('/api/v1/catalog/metadata-v1')
    .set('Authorization', `Bearer ${token}`);
}
function legacy(token = aToken): request.Test {
  return request(app.getHttpServer()).get('/api/v1/catalog')
    .set('Authorization', `Bearer ${token}`);
}
function find(result: Envelope, kind: Kind, name: string): Row {
  const row = result.data[kind].find(item => item.name === name);
  if (!row) throw new Error(`Expected ${kind} record ${name}`);
  return row;
}
async function only(kind: Kind, body: unknown): Promise<Row> {
  const response = await post(kind, body);
  expect(response.status).toBe(201);
  return find(response.body, kind, (body as { name: string }).name.trim());
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
  tenantA = await seedTenant(pool, { name: 'A Tools', permissions: ALL });
  tenantB = await seedTenant(pool, { name: 'B Tools', permissions: ALL });
  aToken = signToken(tenantA, TEST_JWT_SECRET);
  bToken = signToken(tenantB, TEST_JWT_SECRET);
});

describe('MOD-002 metadata catalog: transport and strict contract', () => {
  it('rejects anonymous reads, creates and patches; no default public catalog', async () => {
    expect((await request(app.getHttpServer()).get('/api/v1/catalog')).status).toBe(401);
    expect((await request(app.getHttpServer()).get('/api/v1/catalog/metadata-v1')).status).toBe(401);
    for (const kind of ['units', 'brands', 'categories'] as const) {
      const raw = request(app.getHttpServer());
      const body = kind === 'categories' ? { name: 'Anonymous', parentId: null } : { name: 'Anonymous' };
      expect((await raw.post(`/api/v1/catalog/metadata-v1/${kind}`).send(body)).status).toBe(401);
      expect((await request(app.getHttpServer())
        .patch(`/api/v1/catalog/metadata-v1/${kind}/01ARZ3NDEKTSV4RRFFQ69G5FAV`)
        .send({ expectedVersion: 1, nameBn: 'গোপন' })).status).toBe(401);
    }
    expect((await read()).body.data.units).toEqual([]);
  });

  it('returns same stable master IDs, strict legacy shape and no tenant-B rows', async () => {
    const unit = await only('units', { name: 'Gauge', nameBn: 'গেজ', symbol: 'Gg' });
    const brand = await only('brands', { name: 'RFL', nameBn: 'আরএফএল' });
    const category = await only('categories', { name: 'Hardware', nameBn: 'হার্ডওয়্যার', parentId: null });
    const versioned = await read();
    expect(versioned.status).toBe(200);
    expect(find(versioned.body, 'units', 'Gauge')).toMatchObject(unit);
    expect(find(versioned.body, 'brands', 'RFL')).toMatchObject(brand);
    expect(find(versioned.body, 'categories', 'Hardware')).toMatchObject(category);
    expect(unit.version).toBe(1);
    expect(brand.version).toBe(1);
    expect(category.version).toBe(1);
    expect(Object.keys(versioned.body.data).sort()).toEqual(['brands', 'categories', 'features', 'units']);
    expect(Object.keys(versioned.body.data.features).sort()).toEqual([
      'customerGroups', 'expiryTracking', 'productOffers', 'serialTracking', 'vendors', 'warranty',
    ]);
    expect((await legacy()).body.data).toMatchObject({
      units: [{ id: unit.id, name: 'Gauge' }],
      brands: [{ id: brand.id, name: 'RFL' }],
      categories: [{ id: category.id, name: 'Hardware', parentId: null }],
    });
    expect(Object.keys((await legacy()).body.data.units[0])).toEqual(['id', 'name']);
    expect((await read(bToken)).body.data.units).toEqual([]);
    expect((await read(bToken)).body.data.brands).toEqual([]);
    expect((await read(bToken)).body.data.categories).toEqual([]);
  });

  it('rejects malformed create commands on all three kinds with no partial writes', async () => {
    const cases: Array<{ kind: Kind; body: unknown }> = [
      { kind: 'units', body: {} },
      { kind: 'units', body: { name: '' } },
      { kind: 'units', body: { name: '   ' } },
      { kind: 'units', body: { name: 'A'.repeat(121) } },
      { kind: 'units', body: { name: 42 } },
      { kind: 'units', body: { name: 'Piece', nameBn: '' } },
      { kind: 'units', body: { name: 'Piece', nameBn: '   ' } },
      { kind: 'units', body: { name: 'Piece', nameBn: 'ক'.repeat(121) } },
      { kind: 'units', body: { name: 'Piece', symbol: '' } },
      { kind: 'units', body: { name: 'Piece', symbol: 'ABCDE' } },
      { kind: 'units', body: { name: 'Piece', symbol: 'G g' } },
      { kind: 'units', body: { name: 'Piece', symbol: 2 } },
      { kind: 'units', body: { name: 'Piece', tenantId: tenantB.tenantId } },
      { kind: 'units', body: { name: 'Piece', conversionFactorQty: 12000 } },
      { kind: 'brands', body: { name: 'RFL', symbol: 'R' } },
      { kind: 'brands', body: { name: 'RFL', actorId: tenantB.userId } },
      { kind: 'brands', body: { name: 'RFL', nameBn: ['আরএফএল'] } },
      { kind: 'categories', body: { name: 'Root' } },
      { kind: 'categories', body: { name: 'Root', parentId: 'not-an-id' } },
      { kind: 'categories', body: { name: 'Root', parentId: null, active: true } },
      { kind: 'categories', body: { name: 'Root', parentId: null, version: 1 } },
    ];
    for (const { kind, body } of cases) {
      const result = await post(kind, body);
      expect(result.status, `${kind} ${JSON.stringify(body)}`).toBe(400);
      expect(result.body.error.code).toBe('VALIDATION_FAILED');
    }
    const data = (await read()).body.data as Envelope['data'];
    expect(data.units).toEqual([]);
    expect(data.brands).toEqual([]);
    expect(data.categories).toEqual([]);
  });

  it('normalizes NFC and whitespace while allowing optional explicit null values', async () => {
    const unit = await only('units', {
      name: 'Wire', nameBn: '  কা\u09be   তার ', symbol: '  গে ',
    });
    expect(unit.nameBn).toBe('কা তার');
    expect(unit.symbol).toBe('গে');
    const brand = await only('brands', { name: 'Local', nameBn: null });
    expect(brand.nameBn).toBeNull();
    const category = await only('categories', { name: 'Others', nameBn: null, parentId: null });
    expect(category.nameBn).toBeNull();
  });

  it('rejects unknown / malformed metadata PATCH without incrementing version', async () => {
    const unit = await only('units', { name: 'Gauge', nameBn: 'গেজ', symbol: 'Gg' });
    const brand = await only('brands', { name: 'Local', nameBn: 'লোকাল' });
    const category = await only('categories', { name: 'Electrical', nameBn: 'ইলেকট্রিক', parentId: null });

    const cases: Array<{ kind: Kind; id: string; body: unknown }> = [
      { kind: 'units', id: unit.id, body: { expectedVersion: 1 } },
      { kind: 'units', id: unit.id, body: { expectedVersion: 0, nameBn: 'গেজ' } },
      { kind: 'units', id: unit.id, body: { expectedVersion: 1, symbol: '' } },
      { kind: 'units', id: unit.id, body: { expectedVersion: 1, symbol: 'Five5' } },
      { kind: 'units', id: unit.id, body: { expectedVersion: 1, nameBn: '' } },
      { kind: 'units', id: unit.id, body: { expectedVersion: 1, name: 'Renamed' } },
      { kind: 'units', id: unit.id, body: { expectedVersion: 1, tenantId: tenantB.tenantId } },
      { kind: 'brands', id: brand.id, body: { expectedVersion: 1 } },
      { kind: 'brands', id: brand.id, body: { expectedVersion: 1, symbol: 'L' } },
      { kind: 'brands', id: brand.id, body: { expectedVersion: 1, nameBn: '  ' } },
      { kind: 'categories', id: category.id, body: { expectedVersion: 1, parentId: null } },
      { kind: 'categories', id: category.id, body: { expectedVersion: 1, nameBn: 'ই', active: false } },
    ];
    for (const { kind, id, body } of cases) {
      const result = await patch(kind, id, body);
      expect(result.status, `${kind} ${JSON.stringify(body)}`).toBe(400);
    }
    const after = (await read()).body as Envelope;
    expect(find(after, 'units', 'Gauge')).toMatchObject(unit);
    expect(find(after, 'brands', 'Local')).toMatchObject(brand);
    expect(find(after, 'categories', 'Electrical')).toMatchObject(category);
  });

  it('retains Bengali metadata across legacy rename and supports optimistic follow-up edit', async () => {
    const unit = await only('units', { name: 'Gauge', nameBn: 'গেজ', symbol: 'Gg' });
    const renamed = await request(app.getHttpServer())
      .patch(`/api/v1/catalog/units/${unit.id}`)
      .set('Authorization', `Bearer ${aToken}`)
      .send({ name: 'Gauge Wire' });
    expect(renamed.status).toBe(200);
    const renamedVersion = find((await read()).body, 'units', 'Gauge Wire');
    expect(renamedVersion).toMatchObject({ id: unit.id, nameBn: 'গেজ', symbol: 'Gg', version: 2 });

    const stale = await patch('units', unit.id, { expectedVersion: 1, nameBn: 'পুরোনো' });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('CONFLICT_STALE_VERSION');

    const edited = await patch('units', unit.id, { expectedVersion: 2, nameBn: null, symbol: 'GW' });
    expect(edited.status).toBe(200);
    expect(find(edited.body, 'units', 'Gauge Wire')).toMatchObject({
      id: unit.id, nameBn: null, symbol: 'GW', version: 3,
    });
    const legacyRow = (await legacy()).body.data.units[0];
    expect(legacyRow).toEqual({ id: unit.id, name: 'Gauge Wire' });
  });

  it('keeps valid sibling duplicates but rejects third-level and other-tenant parents', async () => {
    const p1 = await only('categories', { name: 'Electrical', parentId: null });
    const p2 = await only('categories', { name: 'Plumbing', parentId: null });
    expect((await post('categories', { name: 'Tools', parentId: p1.id })).status).toBe(201);
    const child = find((await read()).body, 'categories', 'Tools');
    expect((await post('categories', { name: 'Tools', parentId: p2.id })).status).toBe(201);
    expect((await post('categories', { name: 'tools', parentId: p1.id })).status).toBe(400);
    expect((await post('categories', { name: 'Third', parentId: child.id })).status).toBe(400);
    const foreign = await post('categories', { name: 'External', parentId: null }, bToken);
    expect(foreign.status).toBe(201);
    const foreignParent = find(foreign.body, 'categories', 'External');
    expect((await post('categories', { name: 'Hijack', parentId: foreignParent.id })).status).toBe(404);
    const missing = await post('categories', { name: 'Ghost', parentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' });
    expect(missing.status).toBe(404);
  });

  it('hides removed masters and refuses metadata edits on deleted IDs', async () => {
    const brand = await only('brands', { name: 'Discardable', nameBn: 'বাদ' });
    const removal = await request(app.getHttpServer())
      .post(`/api/v1/catalog/brands/${brand.id}/remove`)
      .set('Authorization', `Bearer ${aToken}`);
    expect(removal.status).toBe(200);
    expect(removal.body.data.outcome).toBe('DELETED');
    expect((await read()).body.data.brands).toEqual([]);
    expect((await patch('brands', brand.id, { expectedVersion: 1, nameBn: null })).status).toBe(404);
    expect((await post('brands', { name: 'Discardable', nameBn: 'নতুন' })).status).toBe(201);
  });

  it('does not create financial or stock records from metadata-only catalog operations', async () => {
    const created = await only('brands', { name: 'Acme', nameBn: 'অ্যাকমি' });
    const changed = await patch('brands', created.id, { expectedVersion: 1, nameBn: 'অ্যাকমি নতুন' });
    expect(changed.status).toBe(200);
    const counts = await asTenant(pool, tenantA.tenantId, async client => {
      const tables = ['journal_entries', 'journal_lines', 'stock_movements', 'inventory_lots', 'cash_movements'];
      const values: number[] = [];
      for (const table of tables) {
        const rows = await client.query<{ count: number }>(`SELECT count(*)::integer AS count FROM ${table}`);
        values.push(rows.rows[0]?.count ?? -1);
      }
      return values;
    });
    expect(counts).toEqual([0, 0, 0, 0, 0]);
  });
});
