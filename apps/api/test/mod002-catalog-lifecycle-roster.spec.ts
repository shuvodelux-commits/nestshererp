/** MOD-002 P8b2b1: unmounted read-only lifecycle roster, REAL disposable PG16. */
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, PostgresUnitOfWork } from '@sher/adapter-postgres';
import { SystemClock, Ulid } from '@sher/shared-utils';
import { PostgresCatalogLifecycleV1RosterReader } from '../../../packages/adapter-postgres/src/catalog-lifecycle-v1-roster-reader';
import {
  catalogLifecycleV1UnitRosterEnvelopeSchema,
  catalogLifecycleV1BrandRosterEnvelopeSchema,
  catalogLifecycleV1CategoryRosterEnvelopeSchema,
} from '../../../packages/core-contracts/src/catalog-lifecycle-v1';
import { asTenant, prepareTestDatabase, seedTenant, testPool, type SeededTenant } from './support/database';

type Kind = 'units' | 'brands' | 'categories';
const clock = new SystemClock();
let pool: pg.Pool;
let a: SeededTenant;
let b: SeededTenant;
let uow: PostgresUnitOfWork;
const reader = new PostgresCatalogLifecycleV1RosterReader();

function testDb(): void {
  const raw = process.env['DATABASE_URL'];
  if (!raw) throw new Error('P8b2b1 requires PostgreSQL test URL');
  const adminRaw = process.env['ADMIN_DATABASE_URL'] ??
    'postgres://postgres:dev@localhost:5432/sher_test';
  const runtime = new URL(raw);
  const admin = new URL(adminRaw);
  for (const url of [runtime, admin]) {
    if (!['localhost', '127.0.0.1'].includes(url.hostname) ||
        url.pathname !== '/sher_test') {
      throw new Error('P8b2b1 refuses non-local or non-test databases');
    }
  }
  if (runtime.username !== 'sher_app' || admin.username !== 'postgres' ||
      (runtime.port || '5432') !== (admin.port || '5432')) {
    throw new Error('P8b2b1 requires matching isolated test roles and ports');
  }
}

function ctx(t: SeededTenant) {
  return { tenantId: t.tenantId, userId: t.userId, timezone: t.timezone };
}

async function add(kind: Kind, t: SeededTenant, name: string, state = 'ACTIVE', parentId: string | null = null) {
  const id = Ulid.generate(clock);
  const archived = state === 'ARCHIVED' ? clock.now() : null;
  await asTenant(pool, t.tenantId, client => client.query(
    'INSERT INTO ' + kind + ' (id, tenant_id, name, name_bn, ' +
    (kind === 'units' ? 'symbol, ' : kind === 'categories' ? 'parent_id, ' : '') +
    'is_active, deleted_at, created_at, updated_at, created_by, updated_by, version) ' +
    'VALUES ($1,$2,$3,$4,' + (kind !== 'brands' ? '$9,' : '') +
    '$5,$6,$7,$7,$8,$8,1)',
    kind === 'brands'
      ? [id, t.tenantId, name, 'বাংলা', state !== 'INACTIVE', archived, clock.now(), t.userId]
      : [id, t.tenantId, name, 'বাংলা', state !== 'INACTIVE', archived, clock.now(), t.userId,
        kind === 'units' ? 'pcs' : parentId],
  ).then(() => undefined));
  return id;
}

beforeAll(async () => {
  testDb();
  pool = testPool();
  await prepareTestDatabase();
  uow = new PostgresUnitOfWork(createDatabase(pool));
  a = await seedTenant(pool, { name: 'LifecycleRosterA', permissions: [] });
  b = await seedTenant(pool, { name: 'LifecycleRosterB', permissions: [] });
});
afterAll(async () => { await pool?.end(); });

describe('MOD-002 P8b2b1 lifecycle roster under FORCE RLS', () => {
  it('reads active, inactive, archived units, preserves true zero-inference and bilingual symbols', async () => {
    const active = await add('units', a, 'Piece');
    const inactive = await add('units', a, 'Bundle', 'INACTIVE');
    const archived = await add('units', a, 'Legacy', 'ARCHIVED');
    await add('units', b, 'Foreign');
    const entries = await uow.run(ctx(a), tx => reader.listUnits(tx, ctx(a)));
    expect(entries.map(x => x.id).sort()).toEqual([active, inactive, archived].sort());
    expect(entries.find(x => x.id === active)).toMatchObject({
      name: 'Piece', nameBn: 'বাংলা', symbol: 'pcs', state: 'ACTIVE', archivedAt: null, version: 1,
    });
    expect(entries.find(x => x.id === inactive)).toMatchObject({ state: 'INACTIVE', archivedAt: null });
    const old = entries.find(x => x.id === archived);
    expect(old?.state).toBe('ARCHIVED');
    expect(old?.archivedAt).toBeTruthy();
    expect(catalogLifecycleV1UnitRosterEnvelopeSchema.safeParse({
      data: { kind: 'unit', entries },
    }).success).toBe(true);
  });

  it('lists archived brands regardless of is_active and never leaks another tenant', async () => {
    const brandA = await add('brands', a, 'OwnBrand', 'ARCHIVED');
    const brandB = await add('brands', b, 'OtherBrand', 'INACTIVE');
    const own = await uow.run(ctx(a), tx => reader.listBrands(tx, ctx(a)));
    const other = await uow.run(ctx(b), tx => reader.listBrands(tx, ctx(b)));
    expect(own.find(x => x.id === brandA)?.state).toBe('ARCHIVED');
    expect(own.some(x => x.id === brandB)).toBe(false);
    expect(other.find(x => x.id === brandB)?.state).toBe('INACTIVE');
    expect(catalogLifecycleV1BrandRosterEnvelopeSchema.safeParse({
      data: { kind: 'brand', entries: own },
    }).success).toBe(true);
  });

  it('shows parent IDs and archived descendants without mutating category hierarchy', async () => {
    const root = await add('categories', a, 'Electrical');
    const child = await add('categories', a, 'Switches', 'INACTIVE', root);
    const old = await add('categories', a, 'OldSwitches', 'ARCHIVED', root);
    const rows = await uow.run(ctx(a), tx => reader.listCategories(tx, ctx(a)));
    expect(rows.find(x => x.id === root)?.parentId).toBeNull();
    expect(rows.find(x => x.id === child)).toMatchObject({
      parentId: root, state: 'INACTIVE', nameBn: 'বাংলা',
    });
    expect(rows.find(x => x.id === old)).toMatchObject({ parentId: root, state: 'ARCHIVED' });
    expect(catalogLifecycleV1CategoryRosterEnvelopeSchema.safeParse({
      data: { kind: 'category', entries: rows },
    }).success).toBe(true);
  });

  it('empty tenant returns empty lists without phantom defaults', async () => {
    const empty = await seedTenant(pool, { name: 'LifecycleRosterEmpty', permissions: [] });
    const results = await uow.run(ctx(empty), async tx => Promise.all([
      reader.listUnits(tx, ctx(empty)),
      reader.listBrands(tx, ctx(empty)),
      reader.listCategories(tx, ctx(empty)),
    ]));
    expect(results).toEqual([[], [], []]);
  });
});
