/*
 * MOD-002 T02A/P6c: opt-in atomic English+Bengali full catalog edit.
 * Real Nest + disposable PostgreSQL16 with unprivileged tenant RLS.
 * NEVER run against a retained, development or production database.
 * @covers endpoint:PATCH /api/v1/catalog/metadata-v1/units/:id/full-edit
 * @covers endpoint:PATCH /api/v1/catalog/metadata-v1/brands/:id/full-edit
 * @covers endpoint:PATCH /api/v1/catalog/metadata-v1/categories/:id/full-edit
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
type Entity = 'unit' | 'brand' | 'category';
interface Row {
  id: string; name: string; nameBn: string | null; version: number;
  symbol?: string | null; parentId?: string | null;
}
const kindInfo = [
  { kind: 'units', entity: 'unit', permission: Permission.UNIT_MANAGE, original: 'Gauge' },
  { kind: 'brands', entity: 'brand', permission: Permission.BRAND_MANAGE, original: 'Local' },
  { kind: 'categories', entity: 'category', permission: Permission.CATEGORY_MANAGE, original: 'Electrical' },
] as const;
const perms = [Permission.PRODUCT_VIEW, Permission.UNIT_MANAGE, Permission.BRAND_MANAGE, Permission.CATEGORY_MANAGE];
let app: INestApplication;
let pool: pg.Pool;
let tenantA: SeededTenant;
let tenantB: SeededTenant;
let tokenA: string;
let tokenB: string;
let ids: Record<Kind, string>;

function get(token = tokenA, instance = app): request.Test {
  return request(instance.getHttpServer()).get('/api/v1/catalog/metadata-v1')
    .set('Authorization', 'Bearer ' + token);
}
function full(kind: Kind, id: string, body: unknown, token = tokenA, instance = app): request.Test {
  return request(instance.getHttpServer())
    .patch('/api/v1/catalog/metadata-v1/' + kind + '/' + id + '/full-edit')
    .set('Authorization', 'Bearer ' + token).send(body as object);
}
function legacyCreate(kind: Kind, name: string, parentId?: string | null): request.Test {
  return request(app.getHttpServer()).post('/api/v1/catalog/' + kind)
    .set('Authorization', 'Bearer ' + tokenA)
    .send(kind === 'categories' ? { name, parentId: parentId ?? null } : { name });
}
function row(body: { data: Record<Kind, Row[]> }, kind: Kind, id: string): Row {
  const found = body.data[kind].find(x => x.id === id);
  if (!found) throw new Error('Missing expected ' + kind + ' row');
  return found;
}
async function countEffects(kind: Entity, id: string, tenant = tenantA): Promise<{ audits: number; outbox: number }> {
  return asTenant(pool, tenant.tenantId, async client => {
    const a = await client.query<{ n: number }>(
      'SELECT count(*)::integer AS n FROM audit_events WHERE entity_type = $1 AND entity_id = $2 AND action = $3',
      [kind, id, 'UPDATE']);
    const o = await client.query<{ n: number }>(
      'SELECT count(*)::integer AS n FROM outbox WHERE aggregate_type = $1 AND aggregate_id = $2 AND event_type = $3',
      [kind, id, kind + '.updated']);
    return { audits: a.rows[0]?.n ?? 0, outbox: o.rows[0]?.n ?? 0 };
  });
}
async function noFinanceOrStock(): Promise<{ journal: number; stock: number }> {
  return asTenant(pool, tenantA.tenantId, async client => {
    const journal = await client.query<{ n: number }>('SELECT count(*)::integer AS n FROM journal_entries');
    const stock = await client.query<{ n: number }>('SELECT count(*)::integer AS n FROM stock_movements');
    return { journal: journal.rows[0]?.n ?? 0, stock: stock.rows[0]?.n ?? 0 };
  });
}
beforeAll(async () => {
  pool = testPool();
  await prepareTestDatabase();
  const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = module.createNestApplication();
  app.useGlobalFilters(new AppErrorFilter());
  await app.init();
});
afterAll(async () => { await app?.close(); await pool?.end(); });
beforeEach(async () => {
  await resetDatabase(pool);
  tenantA = await seedTenant(pool, { name: 'Unit Test Hardware', permissions: perms });
  tenantB = await seedTenant(pool, { name: 'Second Shop', permissions: perms });
  tokenA = signToken(tenantA, TEST_JWT_SECRET);
  tokenB = signToken(tenantB, TEST_JWT_SECRET);
  ids = { units: '', brands: '', categories: '' };
  for (const item of kindInfo) {
    const response = await legacyCreate(item.kind, item.original);
    expect(response.status).toBe(201);
    const match = (response.body.data[item.kind] as Row[]).find(x => x.name === item.original);
    expect(match?.id).toHaveLength(26);
    ids[item.kind] = match!.id;
  }
});
describe('MOD-002 P6c: real HTTP+PG16 atomic catalog full-edit', () => {
  it.each(kindInfo)('$kind updates canonical English and Bangla once, writes exactly one audit and outbox', async item => {
    const oldId = ids[item.kind];
    const result = await full(item.kind, oldId, {
      expectedVersion: 1, name: ' New   Name ', nameBn: ' নতুন  নাম ',
      ...(item.kind === 'units' ? { symbol: ' Gg ' } : {}),
    });
    expect(result.status).toBe(200);
    expect(row(result.body, item.kind, oldId)).toMatchObject({
      id: oldId, name: 'New Name', nameBn: 'নতুন নাম', version: 2,
      ...(item.kind === 'units' ? { symbol: 'Gg' } : {}),
      ...(item.kind === 'categories' ? { parentId: null } : {}),
    });
    const stored = await asTenant(pool, tenantA.tenantId, client =>
      client.query<{ name: string; name_bn: string; version: number }>(
        'SELECT name, name_bn, version FROM ' + item.kind + ' WHERE id = $1', [oldId]));
    expect(stored.rows[0]).toMatchObject({ name: 'New Name', name_bn: 'নতুন নাম', version: 2 });
    expect(await countEffects(item.entity, oldId)).toEqual({ audits: 1, outbox: 1 });
    expect(await noFinanceOrStock()).toEqual({ journal: 0, stock: 0 });
  });

  it('unit omission preserves Bengali and symbol; explicit null clears both, with NFC symbol', async () => {
    const id = ids.units;
    const first = await full('units', id, { expectedVersion: 1, name: 'Cable', nameBn: 'তার', symbol: ' e\u0301 ' });
    expect(first.status).toBe(200);
    expect(row(first.body, 'units', id)).toMatchObject({ nameBn: 'তার', symbol: 'é', version: 2 });
    const preserve = await full('units', id, { expectedVersion: 2, name: 'Cable 2' });
    expect(preserve.status).toBe(200);
    expect(row(preserve.body, 'units', id)).toMatchObject({ nameBn: 'তার', symbol: 'é', version: 3 });
    const clear = await full('units', id, { expectedVersion: 3, name: 'Cable 3', nameBn: null, symbol: null });
    expect(clear.status).toBe(200);
    expect(row(clear.body, 'units', id)).toMatchObject({ nameBn: null, symbol: null, version: 4 });
    expect(await countEffects('unit', id)).toEqual({ audits: 3, outbox: 3 });
  });

  it('both legacy name-only endpoints and Bengali-only metadata PATCH remain compatible', async () => {
    const id = ids.brands;
    const metadataOnly = await request(app.getHttpServer())
      .patch('/api/v1/catalog/metadata-v1/brands/' + id)
      .set('Authorization', 'Bearer ' + tokenA)
      .send({ expectedVersion: 1, nameBn: 'স্থানীয়' });
    expect(metadataOnly.status).toBe(200);
    const fullResult = await full('brands', id, { expectedVersion: 2, name: 'Domestic' });
    expect(fullResult.status).toBe(200);
    expect(row(fullResult.body, 'brands', id)).toMatchObject({ name: 'Domestic', nameBn: 'স্থানীয়', version: 3 });
    const legacy = await request(app.getHttpServer())
      .get('/api/v1/catalog').set('Authorization', 'Bearer ' + tokenA);
    expect(legacy.status).toBe(200);
    expect((legacy.body.data.brands as Row[]).find(x => x.id === id)).toEqual({ id, name: 'Domestic' });
  });

  it.each(kindInfo)('$kind enforces live role permission after JWT issuance, with zero write', async item => {
    const id = ids[item.kind];
    await asTenant(pool, tenantA.tenantId, client => client.query(
      'DELETE FROM role_permissions WHERE tenant_id = $1 AND role_id = $2 AND permission_code = $3',
      [tenantA.tenantId, tenantA.roleId, item.permission]));
    const denied = await full(item.kind, id, { expectedVersion: 1, name: 'Denied' });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('PERMISSION_DENIED');
    expect(row((await get()).body, item.kind, id).version).toBe(1);
    expect(await countEffects(item.entity, id)).toEqual({ audits: 0, outbox: 0 });
  });

  it.each(kindInfo)('$kind hides other-tenant and archived masters as 404', async item => {
    const id = ids[item.kind];
    const foreign = await full(item.kind, id, { expectedVersion: 1, name: 'Foreign' }, tokenB);
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe('NOT_FOUND');
    await asTenant(pool, tenantA.tenantId, client => client.query(
      'UPDATE ' + item.kind + ' SET deleted_at = now() WHERE id = $1', [id]));
    const archived = await full(item.kind, id, { expectedVersion: 1, name: 'Archived' });
    expect(archived.status).toBe(404);
    expect(archived.body.error.code).toBe('NOT_FOUND');
    expect(await countEffects(item.entity, id)).toEqual({ audits: 0, outbox: 0 });
  });

  it.each(kindInfo)('$kind stale version is 409 and replays do not write again', async item => {
    const id = ids[item.kind];
    expect((await full(item.kind, id, { expectedVersion: 1, name: 'New' })).status).toBe(200);
    const repeated = await full(item.kind, id, { expectedVersion: 1, name: 'New' });
    expect(repeated.status).toBe(409);
    expect(repeated.body.error.code).toBe('CONFLICT_STALE_VERSION');
    expect(await countEffects(item.entity, id)).toEqual({ audits: 1, outbox: 1 });
  });

  it.each(kindInfo)('$kind concurrent same-row CAS has exactly one successful writer', async item => {
    const id = ids[item.kind];
    const [a, b] = await Promise.all([
      full(item.kind, id, { expectedVersion: 1, name: 'First' }),
      full(item.kind, id, { expectedVersion: 1, name: 'Second' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(row((await get()).body, item.kind, id).version).toBe(2);
    expect(await countEffects(item.entity, id)).toEqual({ audits: 1, outbox: 1 });
  });

  it('parallel rename to identical unit name: one 200, one safe duplicate 400', async () => {
    const second = await legacyCreate('units', 'Box');
    expect(second.status).toBe(201);
    const otherId = (second.body.data.units as Row[]).find(x => x.name === 'Box')!.id;
    const [a, b] = await Promise.all([
      full('units', ids.units, { expectedVersion: 1, name: ' Cable ' }),
      full('units', otherId, { expectedVersion: 1, name: 'cable' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 400]);
    const rows = (await get()).body.data.units as Row[];
    expect(rows.filter(r => r.name.toLowerCase() === 'cable')).toHaveLength(1);
    expect(await noFinanceOrStock()).toEqual({ journal: 0, stock: 0 });
  });

  it('category duplicate sibling rejected but same child name across parents permitted', async () => {
    const root = ids.categories;
    const alt = await legacyCreate('categories', 'Plumbing');
    expect(alt.status).toBe(201);
    const root2 = (alt.body.data.categories as Row[]).find(x => x.name === 'Plumbing')!.id;
    const makeChild = async (parentId: string, name: string): Promise<string> => {
      const result = await legacyCreate('categories', name, parentId);
      expect(result.status).toBe(201);
      return (result.body.data.categories as Row[]).find(r => r.parentId === parentId && r.name === name)!.id;
    };
    const ownChild = await makeChild(root, 'Cable');
    const otherChild = await makeChild(root2, 'Switch');
    const cross = await full('categories', otherChild, { expectedVersion: 1, name: 'Cable' });
    expect(cross.status).toBe(200);
    expect(row(cross.body, 'categories', otherChild)).toMatchObject({ name: 'Cable', parentId: root2, version: 2 });
    const sibling = await makeChild(root, 'Fuse');
    const duplicate = await full('categories', sibling, { expectedVersion: 1, name: ' CABLE ' });
    expect(duplicate.status).toBe(400);
    expect(row((await get()).body, 'categories', ownChild).name).toBe('Cable');
  });

  it.each(kindInfo)('$kind invalid full-edit payloads reject without writes, no legacy PATCH confusion', async item => {
    const id = ids[item.kind];
    for (const body of [
      { expectedVersion: 0, name: 'No' },
      { expectedVersion: 1, name: '' },
      { expectedVersion: 1, name: 'X', tenantId: tenantB.tenantId },
      { expectedVersion: 1, name: 'X', active: false },
      { expectedVersion: 1, name: 'X', parentId: ids.categories },
      { expectedVersion: 1, name: 'X'.repeat(121) },
    ]) {
      const result = await full(item.kind, id, body);
      expect(result.status).toBe(400);
    }
    expect(row((await get()).body, item.kind, id).version).toBe(1);
    expect(await countEffects(item.entity, id)).toEqual({ audits: 0, outbox: 0 });
  });

  it('all three full-edit routes require authenticated tenant context', async () => {
    for (const item of kindInfo) {
      const unsigned = await request(app.getHttpServer())
        .patch('/api/v1/catalog/metadata-v1/' + item.kind + '/' + ids[item.kind] + '/full-edit')
        .send({ expectedVersion: 1, name: 'No token' });
      expect(unsigned.status).toBe(401);
    }
  });

  it.each(kindInfo)('$kind SQL edit and audit roll back if outbox append fails', async item => {
    const initial = await countEffects(item.entity, ids[item.kind]);
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(OUTBOX)
      .useValue({ append: async (): Promise<void> => { throw new Error('synthetic full edit outbox failure'); } })
      .compile();
    const broken = module.createNestApplication();
    broken.useGlobalFilters(new AppErrorFilter());
    await broken.init();
    try {
      const response = await full(item.kind, ids[item.kind], {
        expectedVersion: 1, name: 'Must rollback', nameBn: 'ব্যর্থ',
      }, tokenA, broken);
      expect(response.status).toBe(500);
    } finally { await broken.close(); }
    expect(row((await get()).body, item.kind, ids[item.kind])).toMatchObject({
      name: item.original, nameBn: null, version: 1,
    });
    expect(await countEffects(item.entity, ids[item.kind])).toEqual(initial);
    expect(await noFinanceOrStock()).toEqual({ journal: 0, stock: 0 });
  });
});
