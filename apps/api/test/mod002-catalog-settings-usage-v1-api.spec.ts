/*
 * MOD-002 P7b2: opt-in signed product-settings usage GET.
 * REAL Nest HTTP + isolated PostgreSQL16, unprivileged FORCE RLS.
 * No retained/production databases or Product Settings activation.
 * @covers endpoint:GET /api/v1/catalog/settings-usage-v1
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

const clock = new SystemClock();
const id = () => Ulid.generate(clock);
const PATH = '/api/v1/catalog/settings-usage-v1';
let app: INestApplication;
let pool: pg.Pool;
let a: SeededTenant;
let b: SeededTenant;
let tokenA: string;
let tokenB: string;

function get(token?: string): request.Test {
  const result = request(app.getHttpServer()).get(PATH);
  return token ? result.set('Authorization', 'Bearer ' + token) : result;
}
async function unit(t: SeededTenant, name: string): Promise<string> {
  const key = id();
  await asTenant(pool, t.tenantId, client => client.query(
    'INSERT INTO units (id,tenant_id,name,created_at,updated_at,created_by,updated_by,version) VALUES ($1,$2,$3,$4,$4,$5,$5,1)',
    [key, t.tenantId, name, clock.now(), t.userId],
  ).then(() => undefined));
  return key;
}
async function brand(t: SeededTenant, name: string): Promise<string> {
  const key = id();
  await asTenant(pool, t.tenantId, client => client.query(
    'INSERT INTO brands (id,tenant_id,name,created_at,updated_at,created_by,updated_by,version) VALUES ($1,$2,$3,$4,$4,$5,$5,1)',
    [key, t.tenantId, name, clock.now(), t.userId],
  ).then(() => undefined));
  return key;
}
async function category(t: SeededTenant, name: string, parent: string | null = null): Promise<string> {
  const key = id();
  await asTenant(pool, t.tenantId, client => client.query(
    'INSERT INTO categories (id,tenant_id,name,parent_id,created_at,updated_at,created_by,updated_by,version) VALUES ($1,$2,$3,$6,$4,$4,$5,$5,1)',
    [key, t.tenantId, name, clock.now(), t.userId, parent],
  ).then(() => undefined));
  return key;
}
async function product(t: SeededTenant, p: {
  base: string; conversion?: string | null; brand?: string | null;
  category?: string | null; inactive?: boolean; deleted?: boolean;
}): Promise<string> {
  const key = id();
  await asTenant(pool, t.tenantId, async client => {
    await client.query(
      'INSERT INTO products (id,tenant_id,name,base_unit_id,conversion_unit_id,conversion_factor_qty,brand_id,category_id,status,purchase_price_minor,selling_price_minor,created_at,updated_at,created_by,updated_by,version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,100,200,$10,$10,$11,$11,1)',
      [key, t.tenantId, 'Fixture ' + key, p.base, p.conversion ?? null,
        p.conversion ? 20000 : null, p.brand ?? null, p.category ?? null,
        p.inactive ? 'INACTIVE' : 'ACTIVE', clock.now(), t.userId],
    );
    if (p.deleted) await client.query('UPDATE products SET deleted_at = now() WHERE id = $1', [key]);
  });
  return key;
}
async function conversion(t: SeededTenant, productId: string, unitId: string): Promise<void> {
  await asTenant(pool, t.tenantId, client => client.query(
    'INSERT INTO product_unit_conversions (id,tenant_id,product_id,unit_id,factor_qty,created_at,updated_at,created_by,updated_by,version) VALUES ($1,$2,$3,$4,24000,$5,$5,$6,$6,1)',
    [id(), t.tenantId, productId, unitId, clock.now(), t.userId],
  ).then(() => undefined));
}
async function effects(t: SeededTenant) {
  return asTenant(pool, t.tenantId, async client => {
    const r = await client.query<{ audit: number; journal: number; stock: number; outbox: number }>(
      'SELECT (SELECT count(*)::integer FROM audit_events) audit, (SELECT count(*)::integer FROM journal_entries) journal, (SELECT count(*)::integer FROM stock_movements) stock, (SELECT count(*)::integer FROM outbox) outbox',
    );
    return r.rows[0];
  });
}

beforeAll(async () => {
  pool = testPool();
  await prepareTestDatabase();
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication();
  app.useGlobalFilters(new AppErrorFilter());
  await app.init();
});
afterAll(async () => { await app?.close(); await pool?.end(); });
beforeEach(async () => {
  await resetDatabase(pool);
  a = await seedTenant(pool, { name: 'Hardware A', permissions: [Permission.PRODUCT_VIEW] });
  b = await seedTenant(pool, { name: 'Hardware B', permissions: [Permission.PRODUCT_VIEW] });
  tokenA = signToken(a, TEST_JWT_SECRET);
  tokenB = signToken(b, TEST_JWT_SECRET);
});

describe('MOD-002 P7b2: signed catalog usage API under FORCE RLS', () => {
  it('rejects missing bearer token before disclosing tenant data', async () => {
    const response = await get();
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('returns authoritative empty array snapshot without echoing tenant/user and never mutates accounting', async () => {
    const u = await unit(a, 'Feet');
    const v = await brand(a, 'Vision');
    const root = await category(a, 'Electrical');
    const before = await effects(a);
    const response = await get(tokenA);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: {
        units: [{ id: u, productCount: 0 }],
        brands: [{ id: v, productCount: 0 }],
        categories: [{
          id: root, directProductCount: 0, subtreeProductCount: 0, parentState: 'root',
        }],
        unresolved: { unitIds: [], brandIds: [], categoryIds: [], parentIds: [] },
      },
    });
    expect(await effects(a)).toEqual(before);
    expect(response.text).not.toContain(a.userId);
    expect(response.text).not.toContain(a.tenantId);
  });

  it('counts unit base, legacy and multi-unit references once, including inactive; categories direct/subtree', async () => {
    const feet = await unit(a, 'Feet');
    const pipe = await unit(a, 'Pipe');
    const carton = await unit(a, 'Carton');
    const vendor = await brand(a, 'Local');
    const root = await category(a, 'Electrical');
    const child = await category(a, 'Cable', root);
    const first = await product(a, { base: feet, conversion: pipe, brand: vendor, category: child });
    await conversion(a, first, pipe);
    await conversion(a, first, feet);
    await conversion(a, first, carton);
    await product(a, { base: pipe, inactive: true, brand: vendor, category: root });
    await product(a, { base: carton, deleted: true, brand: vendor, category: root });
    const response = await get(tokenA);
    expect(response.status).toBe(200);
    expect(Object.fromEntries(response.body.data.units.map((x: { id: string; productCount: number }) => [x.id, x.productCount]))).toEqual({
      [feet]: 1, [pipe]: 2, [carton]: 1,
    });
    expect(response.body.data.brands).toEqual([{ id: vendor, productCount: 2 }]);
    expect(Object.fromEntries(response.body.data.categories.map((x: { id: string }) => [x.id, x]))).toEqual({
      [root]: { id: root, directProductCount: 1, subtreeProductCount: 2, parentState: 'root' },
      [child]: { id: child, directProductCount: 1, subtreeProductCount: 1, parentState: 'present' },
    });
    expect(response.body.data.unresolved).toEqual({
      unitIds: [], brandIds: [], categoryIds: [], parentIds: [],
    });
  });

  it('keeps tenant A and tenant B counts disjoint with live role and RLS', async () => {
    const ua = await unit(a, 'Feet');
    const ub = await unit(b, 'Feet');
    await product(a, { base: ua });
    await product(b, { base: ub });
    const ra = await get(tokenA);
    const rb = await get(tokenB);
    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
    expect(ra.body.data.units).toEqual([{ id: ua, productCount: 1 }]);
    expect(rb.body.data.units).toEqual([{ id: ub, productCount: 1 }]);
    expect(ra.text).not.toContain(ub);
    expect(rb.text).not.toContain(ua);
  });

  it('revoked current PRODUCT_VIEW denies stale-but-signed JWT before repository read', async () => {
    const u = await unit(a, 'Feet');
    await product(a, { base: u });
    await asTenant(pool, a.tenantId, client => client.query(
      'DELETE FROM role_permissions WHERE tenant_id = $1 AND role_id = $2 AND permission_code = $3',
      [a.tenantId, a.roleId, Permission.PRODUCT_VIEW],
    ).then(() => undefined));
    const response = await get(tokenA);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('PERMISSION_DENIED');
    expect(response.text).not.toContain(u);
  });

  it('preserves existing metadata-v1 GET and legacy catalog endpoints unchanged', async () => {
    await unit(a, 'Gauge');
    const oldMeta = await request(app.getHttpServer()).get('/api/v1/catalog/metadata-v1')
      .set('Authorization', 'Bearer ' + tokenA);
    expect(oldMeta.status).toBe(200);
    expect(oldMeta.body.data.units.map((u: { name: string }) => u.name)).toContain('Gauge');
    const old = await request(app.getHttpServer()).get('/api/v1/catalog')
      .set('Authorization', 'Bearer ' + tokenA);
    expect(old.status).toBe(200);
    expect(old.body.data.units.map((u: { name: string }) => u.name)).toContain('Gauge');
  });
});
