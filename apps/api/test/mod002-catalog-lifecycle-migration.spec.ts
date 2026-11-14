/**
 * MOD-002 P8b2a: REAL PG16 additive lifecycle storage acceptance.
 * RED until catalog is_active columns exist. No API or UI change.
 * Only run with disposable PostgreSQL test DB; never use retained data.
 */
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SystemClock, Ulid } from '@sher/shared-utils';
import {
  asTenant, prepareTestDatabase, seedTenant, testPool,
  type SeededTenant,
} from './support/database';

type Kind = 'units' | 'brands' | 'categories';
const kinds: readonly Kind[] = ['units', 'brands', 'categories'];
const clock = new SystemClock();
const created = new Date('2026-10-01T08:00:00.000Z');
let pool: pg.Pool;
let a: SeededTenant;
let b: SeededTenant;

function assertDisposable(): void {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('No database configured');
  const database = new URL(url).pathname.replace(/^\//u, '');
  if (database !== 'sher_test' && !/^mod002_p8b2a_[a-z0-9_]+$/u.test(database)) {
    throw new Error('P8b2a PG16 acceptance refuses non-test DATABASE_URL');
  }
  const admin = process.env['ADMIN_DATABASE_URL'];
  if (admin && new URL(admin).pathname !== new URL(url).pathname) {
    throw new Error('Test and admin database URLs must name the same disposable DB');
  }
}

async function insert(kind: Kind, tenant: SeededTenant, name: string): Promise<string> {
  const id = Ulid.generate(clock);
  await asTenant(pool, tenant.tenantId, client => client.query(
    'INSERT INTO ' + kind + ' (id, tenant_id, name, name_bn, created_at, updated_at, ' +
    'created_by, updated_by, version) VALUES ($1,$2,$3,$4,$5,$5,$6,$6,1)',
    [id, tenant.tenantId, name, 'নাম', created, tenant.userId],
  ).then(() => undefined));
  return id;
}

async function read(kind: Kind, tenant: SeededTenant, id: string) {
  return asTenant(pool, tenant.tenantId, client => client.query<{
    id: string; name: string; name_bn: string | null; version: number;
    is_active: boolean; deleted_at: Date | null;
    created_at: Date; updated_at: Date;
  }>('SELECT id,name,name_bn,version,is_active,deleted_at,created_at,updated_at ' +
     'FROM ' + kind + ' WHERE id = $1', [id]));
}

function unique(prefix: string): string {
  return prefix + Ulid.generate(clock).slice(-8);
}

beforeAll(async () => {
  assertDisposable();
  pool = testPool();
  await prepareTestDatabase();
  // Distinct tenant + row identities avoid all shared TRUNCATE/reset operations.
  a = await seedTenant(pool, { name: 'P8b2a Tenant A', permissions: [] });
  b = await seedTenant(pool, { name: 'P8b2a Tenant B', permissions: [] });
});
afterAll(async () => { await pool?.end(); });

describe('MOD-002 P8b2a additive catalog lifecycle persistence (PG16 FORCE RLS)', () => {
  it.each(kinds)('%s old INSERT defaults Active and preserves metadata and version', async kind => {
    const id = await insert(kind, a, unique('Default-' + kind));
    const row = (await read(kind, a, id)).rows[0]!;
    expect(row).toMatchObject({
      id, is_active: true, version: 1, name_bn: 'নাম', deleted_at: null,
    });
    expect(row.created_at.toISOString()).toBe(created.toISOString());
    expect(row.updated_at.toISOString()).toBe(created.toISOString());
  });

  it.each(kinds)('%s Inactive is independent of name, history and legacy reads', async kind => {
    const id = await insert(kind, a, unique('Inactive-' + kind));
    await asTenant(pool, a.tenantId, client =>
      client.query('UPDATE ' + kind + ' SET is_active = FALSE WHERE id = $1', [id]));
    const row = (await read(kind, a, id)).rows[0]!;
    expect(row).toMatchObject({ is_active: false, version: 1, name_bn: 'নাম', deleted_at: null });
    expect(row.updated_at.toISOString()).toBe(created.toISOString());
    const legacy = await asTenant(pool, a.tenantId, client =>
      client.query('SELECT id FROM ' + kind + ' WHERE deleted_at IS NULL AND id = $1', [id]));
    expect(legacy.rowCount).toBe(1); // No legacy API cutover in a storage-only migration.
  });

  it.each(kinds)('%s archives keep independent Active/Inactive values', async kind => {
    const inactive = await insert(kind, a, unique('ArchivedInactive-' + kind));
    const active = await insert(kind, a, unique('ArchivedActive-' + kind));
    await asTenant(pool, a.tenantId, async client => {
      await client.query(
        'UPDATE ' + kind + ' SET is_active = FALSE, deleted_at = now() WHERE id = $1', [inactive],
      );
      await client.query('UPDATE ' + kind + ' SET deleted_at = now() WHERE id = $1', [active]);
    });
    const oldInactive = (await read(kind, a, inactive)).rows[0]!;
    const oldActive = (await read(kind, a, active)).rows[0]!;
    expect(oldInactive.is_active).toBe(false);
    expect(oldActive.is_active).toBe(true);
    expect(oldInactive.deleted_at).not.toBeNull();
    expect(oldActive.deleted_at).not.toBeNull();
    expect([oldInactive.version, oldActive.version]).toEqual([1, 1]);
  });

  it.each(kinds)('%s enforces tenant isolation for status SELECT/UPDATE', async kind => {
    const name = unique('RLS-' + kind);
    const id = await insert(kind, a, name);
    expect((await read(kind, b, id)).rowCount).toBe(0);
    const changed = await asTenant(pool, b.tenantId, client =>
      client.query('UPDATE ' + kind + ' SET is_active = FALSE WHERE id = $1', [id]));
    expect(changed.rowCount).toBe(0);
    expect((await read(kind, a, id)).rows[0]?.is_active).toBe(true);
    const own = await insert(kind, b, name); // Same English name across tenants is valid.
    expect((await read(kind, b, own)).rows[0]?.is_active).toBe(true);
  });

  it.each(kinds)('%s keeps Active+Inactive uniqueness; archive alone frees name', async kind => {
    const name = unique('Unique-' + kind);
    const id = await insert(kind, a, name);
    await asTenant(pool, a.tenantId, client =>
      client.query('UPDATE ' + kind + ' SET is_active = FALSE WHERE id = $1', [id]));
    await expect(insert(kind, a, name)).rejects.toMatchObject({ code: '23505' });
    await asTenant(pool, a.tenantId, client =>
      client.query('UPDATE ' + kind + ' SET deleted_at = now() WHERE id = $1', [id]));
    const replacement = await insert(kind, a, name);
    expect(replacement).not.toBe(id);
    expect((await read(kind, a, replacement)).rows[0]?.is_active).toBe(true);
  });

  it('keeps row security ENABLED and FORCED for all three catalogs', async () => {
    const rows = await asTenant(pool, a.tenantId, client => client.query<{
      relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean;
    }>('SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class ' +
       'WHERE relname = ANY($1::text[]) AND relkind = $2 ORDER BY relname',
    [kinds, 'r']));
    expect(rows.rows.map(x => x.relname)).toEqual(['brands', 'categories', 'units']);
    expect(rows.rows.every(x => x.relrowsecurity && x.relforcerowsecurity)).toBe(true);
  });

  it('storage-only mutation cannot generate cash, journal, stock or outbox', async () => {
    const rows = await asTenant(pool, a.tenantId, client => client.query<{
      journals: number; stock: number; outbox: number;
    }>('SELECT (SELECT count(*)::integer FROM journal_entries) journals, ' +
      '(SELECT count(*)::integer FROM stock_movements) stock, ' +
      '(SELECT count(*)::integer FROM outbox) outbox'));
    expect(rows.rows[0]).toEqual({ journals: 0, stock: 0, outbox: 0 });
  });
});
