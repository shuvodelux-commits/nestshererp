/*
 * MOD-002 P7b1: real disposable PostgreSQL16, non-owner FORCE RLS.
 * No HTTP route, retained DB, application data or accounting writes.
 * The adapter has no public endpoint or test-inventory @covers target yet.
 */
import { createDatabase, PostgresUnitOfWork } from '@sher/adapter-postgres';
import { SystemClock, Ulid } from '@sher/shared-utils';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgresCatalogSettingsUsageV1Reader } from '../../../packages/adapter-postgres/src/catalog-settings-usage-v1-reader';
import type { SeededTenant } from './support/database';
import { asTenant, prepareTestDatabase, resetDatabase, seedTenant, testPool } from './support/database';

const clock = new SystemClock();
const id = () => Ulid.generate(clock);
let pool: pg.Pool;
let uow: PostgresUnitOfWork;
let reader: PostgresCatalogSettingsUsageV1Reader;
let a: SeededTenant;
let b: SeededTenant;
const ctx = (t: SeededTenant) => ({ tenantId: t.tenantId, userId: t.userId, timezone: t.timezone });
async function read(t: SeededTenant) { return uow.run(ctx(t), tx => reader.read(tx, ctx(t))); }
async function master(t: SeededTenant, kind: 'units' | 'brands' | 'categories',
  name: string, parentId: string | null = null): Promise<string> {
  const key = id();
  const sql = kind === 'categories'
    ? 'INSERT INTO categories (id,tenant_id,name,parent_id,created_at,updated_at,created_by,updated_by,version) VALUES ($1,$2,$3,$6,$4,$4,$5,$5,1)'
    : 'INSERT INTO ' + kind + ' (id,tenant_id,name,created_at,updated_at,created_by,updated_by,version) VALUES ($1,$2,$3,$4,$4,$5,$5,1)';
  const params = kind === 'categories'
    ? [key, t.tenantId, name, clock.now(), t.userId, parentId]
    : [key, t.tenantId, name, clock.now(), t.userId];
  await asTenant(pool, t.tenantId, async client => { await client.query(sql, params); });
  return key;
}
async function product(t: SeededTenant, props: {
  base: string; conversion?: string | null; brand?: string | null;
  category?: string | null; inactive?: boolean; deleted?: boolean;
}): Promise<string> {
  const key = id();
  const columns = 'id,tenant_id,name,base_unit_id,conversion_unit_id,conversion_factor_qty,brand_id,category_id,status,purchase_price_minor,selling_price_minor,created_at,updated_at,created_by,updated_by,version';
  const statement = 'INSERT INTO products (' + columns + ') VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,100,200,$10,$10,$11,$11,1)';
  await asTenant(pool, t.tenantId, async client => {
    await client.query(statement, [
      key, t.tenantId, 'Test ' + key, props.base, props.conversion ?? null,
      props.conversion ? 20000 : null, props.brand ?? null, props.category ?? null,
      props.inactive ? 'INACTIVE' : 'ACTIVE', clock.now(), t.userId,
    ]);
    if (props.deleted) await client.query('UPDATE products SET deleted_at = now() WHERE id = $1', [key]);
  });
  return key;
}
async function conversion(t: SeededTenant, productId: string, unitId: string, deleted = false) {
  await asTenant(pool, t.tenantId, async client => {
    const key = id();
    await client.query(
      'INSERT INTO product_unit_conversions (id,tenant_id,product_id,unit_id,factor_qty,created_at,updated_at,created_by,updated_by,version) VALUES ($1,$2,$3,$4,24000,$5,$5,$6,$6,1)',
      [key, t.tenantId, productId, unitId, clock.now(), t.userId],
    );
    if (deleted) await client.query(
      'UPDATE product_unit_conversions SET deleted_at = now() WHERE id = $1', [key]);
  });
}
beforeAll(async () => {
  pool = testPool();
  await prepareTestDatabase();
  uow = new PostgresUnitOfWork(createDatabase(pool));
  reader = new PostgresCatalogSettingsUsageV1Reader();
});
afterAll(async () => { await pool?.end(); });
beforeEach(async () => {
  await resetDatabase(pool);
  a = await seedTenant(pool, { name: 'Shop A', permissions: [] });
  b = await seedTenant(pool, { name: 'Shop B', permissions: [] });
});
describe('MOD-002 P7b1: unmounted real PG16 reference reader', () => {
  it('known unused rows have real zero counts; no stock, journal, or audit writes', async () => {
    const unit = await master(a, 'units', 'Feet');
    const brand = await master(a, 'brands', 'Vision');
    const root = await master(a, 'categories', 'Electrical');
    const result = await read(a);
    expect(result.units).toEqual([{ id: unit, productCount: 0 }]);
    expect(result.brands).toEqual([{ id: brand, productCount: 0 }]);
    expect(result.categories).toEqual([{
      id: root, directProductCount: 0, subtreeProductCount: 0, parentState: 'root',
    }]);
    expect(result.unresolved).toEqual({
      unitIds: [], brandIds: [], categoryIds: [], parentIds: [],
    });
    const counts = await asTenant(pool, a.tenantId, client => client.query<{
      journal: number; stock: number; audit: number;
    }>('SELECT (SELECT count(*)::integer FROM journal_entries) journal, (SELECT count(*)::integer FROM stock_movements) stock, (SELECT count(*)::integer FROM audit_events) audit'));
    expect(counts.rows[0]).toEqual({ journal: 0, stock: 0, audit: 0 });
  });

  it('deduplicates base, legacy and multi-unit refs; includes inactive but excludes deleted products/edges', async () => {
    const feet = await master(a, 'units', 'Feet');
    const pipe = await master(a, 'units', 'Pipe');
    const box = await master(a, 'units', 'Box');
    const brand = await master(a, 'brands', 'Vision');
    const root = await master(a, 'categories', 'Electrical');
    const child = await master(a, 'categories', 'Cable', root);
    const p1 = await product(a, { base: feet, conversion: pipe, brand, category: child });
    await conversion(a, p1, box);
    await conversion(a, p1, pipe);
    await conversion(a, p1, feet);
    const p2 = await product(a, { base: pipe, brand, category: root, inactive: true });
    await conversion(a, p2, box, true);
    await product(a, { base: feet, brand, category: child, deleted: true });
    const actual = await read(a);
    expect(Object.fromEntries(actual.units.map(x => [x.id, x.productCount]))).toEqual({
      [feet]: 1, [pipe]: 2, [box]: 1,
    });
    expect(actual.brands).toEqual([{ id: brand, productCount: 2 }]);
    expect(Object.fromEntries(actual.categories.map(x => [x.id, x]))).toEqual({
      [root]: { id: root, directProductCount: 1, subtreeProductCount: 2, parentState: 'root' },
      [child]: { id: child, directProductCount: 1, subtreeProductCount: 1, parentState: 'present' },
    });
    expect(actual.unresolved).toEqual({
      unitIds: [], brandIds: [], categoryIds: [], parentIds: [],
    });
  });

  it('retains archived master usage and does not invent an active status for masters', async () => {
    const unit = await master(a, 'units', 'Feet');
    await product(a, { base: unit });
    await asTenant(pool, a.tenantId, client => client.query(
      'UPDATE units SET deleted_at = now() WHERE id = $1', [unit]).then(() => undefined));
    expect((await read(a)).units).toEqual([{ id: unit, productCount: 1 }]);
  });

  it('isolates two tenants under non-owner FORCE RLS, including identical master names', async () => {
    const own = await master(a, 'units', 'Feet');
    const foreign = await master(b, 'units', 'Feet');
    await product(a, { base: own });
    await product(b, { base: foreign });
    expect((await read(a)).units).toEqual([{ id: own, productCount: 1 }]);
    expect((await read(b)).units).toEqual([{ id: foreign, productCount: 1 }]);
    const check = await asTenant(pool, a.tenantId, client => client.query<{
      enabled: boolean; forced: boolean;
    }>("SELECT relrowsecurity enabled, relforcerowsecurity forced FROM pg_class WHERE oid = 'products'::regclass"));
    expect(check.rows[0]).toEqual({ enabled: true, forced: true });
  });

  it('reports an unresolved parent without constructing a foreign master row', async () => {
    const unit = await master(a, 'units', 'Feet');
    const foreignParent = await master(b, 'categories', 'Foreign');
    const child = await master(a, 'categories', 'Orphan');
    await asTenant(pool, a.tenantId, client => client.query(
      'UPDATE categories SET parent_id = $1 WHERE id = $2', [foreignParent, child]).then(() => undefined));
    await product(a, { base: unit, category: child });
    const result = await read(a);
    expect(result.categories).toEqual([{
      id: child, directProductCount: 1, subtreeProductCount: 1, parentState: 'unresolved',
    }]);
    expect(result.unresolved.parentIds).toEqual([foreignParent]);
  });

  it('rejects third-level hierarchy rather than silently undercounting descendants', async () => {
    const root = await master(a, 'categories', 'Root');
    const child = await master(a, 'categories', 'Child', root);
    await master(a, 'categories', 'Third', child);
    await expect(read(a)).rejects.toThrow(/hierarchy/i);
  });
});
