/**
 * MOD-002 P8b2b2 — unmounted unit/brand lifecycle CAS, REAL PostgreSQL16.
 * Uses a separately owned, disposable sher_test DB; no endpoints or UI.
 */
import type pg from 'pg';
import { createDatabase, PostgresCatalogMetadataV1FullEditRepository, PostgresUnitOfWork } from '@sher/adapter-postgres';
import { SystemClock, Ulid } from '@sher/shared-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresCatalogLifecycleV1StatusWriter } from '../../../packages/adapter-postgres/src/catalog-lifecycle-v1-status-writer';
import { asTenant, prepareTestDatabase, seedTenant, testPool, type SeededTenant } from './support/database';

type Kind = 'units' | 'brands';
const kinds: Kind[] = ['units', 'brands'];
const clock = new SystemClock();
let pool: pg.Pool;
let first: SeededTenant;
let second: SeededTenant;
let uow: PostgresUnitOfWork;
const writer = new PostgresCatalogLifecycleV1StatusWriter(clock);

function safeDatabase(): void {
  const url = process.env['DATABASE_URL'];
  const admin = process.env['ADMIN_DATABASE_URL'];
  if (!url || !admin) throw new Error('Explicit PG16 disposable test URLs are mandatory');
  for (const value of [url, admin]) {
    const parsed = new URL(value);
    if (!['localhost', '127.0.0.1'].includes(parsed.hostname) || parsed.pathname !== '/sher_test')
      throw new Error('Lifecycle CAS test refuses nonlocal/non-test databases');
  }
  if (new URL(url).username !== 'sher_app' || new URL(admin).username !== 'postgres' ||
      (new URL(url).port || '5432') !== (new URL(admin).port || '5432')) {
    throw new Error('Lifecycle CAS test role/port mismatch');
  }
}
function ctx(t: SeededTenant) {
  return { tenantId: t.tenantId, userId: t.userId, timezone: t.timezone };
}
async function insert(kind: Kind, tenant: SeededTenant, state: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED' = 'ACTIVE') {
  const id = Ulid.generate(clock);
  const name = 'CAS-' + Ulid.generate(clock);
  const archived = state === 'ARCHIVED' ? clock.now() : null;
  const columns = 'id,tenant_id,name,name_bn,' + (kind === 'units' ? 'symbol,' : '') +
    'is_active,deleted_at,created_at,updated_at,created_by,updated_by,version';
  const placeholders = kind === 'units' ? '$1,$2,$3,$4,$9,$5,$6,$7,$7,$8,$8,1' :
    '$1,$2,$3,$4,$5,$6,$7,$7,$8,$8,1';
  await asTenant(pool, tenant.tenantId, client => client.query(
    'INSERT INTO ' + kind + ' (' + columns + ') VALUES (' + placeholders + ')',
    kind === 'units'
      ? [id, tenant.tenantId, name, 'বাংলা', state !== 'INACTIVE', archived, clock.now(), tenant.userId, 'pc']
      : [id, tenant.tenantId, name, 'বাংলা', state !== 'INACTIVE', archived, clock.now(), tenant.userId],
  ).then(() => undefined));
  return id;
}
function apply(kind: Kind, t: SeededTenant, id: string, version: number, desired: 'ACTIVE' | 'INACTIVE') {
  return uow.run(ctx(t), tx => kind === 'units'
    ? writer.transitionUnit(tx, ctx(t), id, version, desired)
    : writer.transitionBrand(tx, ctx(t), id, version, desired));
}
async function snapshot(kind: Kind, tenant: SeededTenant, id: string) {
  return asTenant(pool, tenant.tenantId, client =>
    client.query<{ version: number; name: string; name_bn: string | null;
      is_active: boolean; deleted_at: Date | null; updated_by: string }>(
      'SELECT version,name,name_bn,is_active,deleted_at,updated_by FROM ' + kind + ' WHERE id=$1', [id])
  ).then(rows => rows.rows[0] ?? null);
}
async function untouchedBusinessTables() {
  return asTenant(pool, first.tenantId, async client => {
    const tables = ['audit_events', 'outbox', 'journal_entries', 'stock_movements'];
    const counts = await Promise.all(tables.map(table =>
      client.query<{ n: number }>('SELECT COUNT(*)::integer n FROM ' + table)));
    return counts.map(x => x.rows[0]?.n ?? -1);
  });
}

beforeAll(async () => {
  safeDatabase();
  pool = testPool();
  await prepareTestDatabase();
  uow = new PostgresUnitOfWork(createDatabase(pool));
  first = await seedTenant(pool, { name: 'MOD002 CAS A', permissions: [] });
  second = await seedTenant(pool, { name: 'MOD002 CAS B', permissions: [] });
});
afterAll(async () => { await pool?.end(); });

describe('MOD-002 P8b2b2 unit/brand row-lock + SQL CAS (FORCE RLS)', () => {
  it.each(kinds)('%s changes Active to Inactive once; preserves name/Bangla and actor stamp', async kind => {
    const id = await insert(kind, first);
    const before = await snapshot(kind, first, id);
    const result = await apply(kind, first, id, 1, 'INACTIVE');
    expect(result).toMatchObject({ outcome: 'CHANGED', state: 'INACTIVE', version: 2 });
    expect(await snapshot(kind, first, id)).toMatchObject({
      name: before?.name, name_bn: 'বাংলা', is_active: false, version: 2, updated_by: first.userId,
    });
    expect(await untouchedBusinessTables()).toEqual([0, 0, 0, 0]);
    expect(await apply(kind, first, id, 2, 'ACTIVE')).toMatchObject({
      outcome: 'CHANGED', state: 'ACTIVE', version: 3,
    });
  });

  it.each(kinds)('%s has true no-op (no version, actor or effects) and stale same-state refusal', async kind => {
    const id = await insert(kind, first, 'INACTIVE');
    const before = await snapshot(kind, first, id);
    expect(await apply(kind, first, id, 1, 'INACTIVE')).toMatchObject({
      outcome: 'UNCHANGED', state: 'INACTIVE', version: 1,
    });
    expect(await snapshot(kind, first, id)).toEqual(before);
    expect(await apply(kind, first, id, 2, 'INACTIVE')).toEqual({ outcome: 'STALE_VERSION' });
    expect(await untouchedBusinessTables()).toEqual([0, 0, 0, 0]);
  });

  it.each(kinds)('%s refuses archived, missing and foreign without side effects', async kind => {
    const archived = await insert(kind, first, 'ARCHIVED');
    const active = await insert(kind, first);
    expect(await apply(kind, first, archived, 1, 'INACTIVE')).toEqual({ outcome: 'ARCHIVED' });
    expect(await apply(kind, first, archived, 5, 'ACTIVE')).toEqual({ outcome: 'STALE_VERSION' });
    expect(await apply(kind, second, active, 1, 'INACTIVE')).toEqual({ outcome: 'NOT_FOUND' });
    expect(await apply(kind, first, Ulid.generate(clock), 1, 'INACTIVE')).toEqual({ outcome: 'NOT_FOUND' });
    expect((await snapshot(kind, first, active))?.version).toBe(1);
    expect(await untouchedBusinessTables()).toEqual([0, 0, 0, 0]);
  });

  it.each(kinds)('%s serializes two independent transaction attempts: one winner, one stale', async kind => {
    const id = await insert(kind, first);
    const results = await Promise.all([
      apply(kind, first, id, 1, 'INACTIVE'),
      apply(kind, first, id, 1, 'INACTIVE'),
    ]);
    expect(results.map(x => x.outcome).sort()).toEqual(['CHANGED', 'STALE_VERSION']);
    expect(await snapshot(kind, first, id)).toMatchObject({ version: 2, is_active: false });
  });

  it.each(kinds)('%s rejects changing int4 max version but permits same-state no-op', async kind => {
    const id = await insert(kind, first);
    await asTenant(pool, first.tenantId, client => client.query(
      'UPDATE ' + kind + ' SET version=2147483647 WHERE id=$1', [id]));
    expect(await apply(kind, first, id, 2147483647, 'ACTIVE')).toMatchObject({
      outcome: 'UNCHANGED', version: 2147483647,
    });
    expect(await apply(kind, first, id, 2147483647, 'INACTIVE')).toEqual({
      outcome: 'VERSION_OVERFLOW',
    });
    expect(await snapshot(kind, first, id)).toMatchObject({ version: 2147483647, is_active: true });
  });

  it('serializes live full-edit rename against unit status using the same version', async () => {
    const id = await insert('units', first);
    const metadata = new PostgresCatalogMetadataV1FullEditRepository(clock);
    const [status, edit] = await Promise.all([
      apply('units', first, id, 1, 'INACTIVE'),
      uow.run(ctx(first), tx => metadata.compareAndSetUnit(tx, ctx(first), id, 1,
        { name: 'CAS-NewName', nameBn: 'নতুন', symbol: 'm' })),
    ]);
    expect(Number(status.outcome === 'CHANGED') + Number(edit !== null)).toBe(1);
    expect((await snapshot('units', first, id))?.version).toBe(2);
  });

  it('rolls back changed brand status when the containing UoW aborts', async () => {
    const id = await insert('brands', first);
    await expect(uow.run(ctx(first), async tx => {
      expect((await writer.transitionBrand(tx, ctx(first), id, 1, 'INACTIVE')).outcome)
        .toBe('CHANGED');
      throw new Error('simulate downstream application failure');
    })).rejects.toThrow('simulate downstream application failure');
    expect(await snapshot('brands', first, id)).toMatchObject({ is_active: true, version: 1 });
  });

  it('refuses invalid/out-of-safe-range versions before touching a row', async () => {
    const id = await insert('units', first);
    for (const version of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(apply('units', first, id, version, 'INACTIVE')).rejects.toThrow(RangeError);
    }
    expect(await snapshot('units', first, id)).toMatchObject({ version: 1, is_active: true });
  });
});
