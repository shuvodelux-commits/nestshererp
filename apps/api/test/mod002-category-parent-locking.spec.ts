/**
 * MOD-002 P8b2c1 — existing legacy + bilingual category writers share a
 * parent FOR UPDATE lock, and category removal rechecks children after locking.
 * REAL disposable PostgreSQL16, FORCE RLS, no UI / route / lifecycle status API.
 */
import type pg from 'pg';
import { createDatabase, PostgresUnitOfWork, PostgresCatalogRepository, PostgresCatalogMetadataV1CreationRepository } from '@sher/adapter-postgres';
import { ErrorCode } from '@sher/core-contracts';
import { SystemClock, Ulid } from '@sher/shared-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asTenant, prepareTestDatabase, seedTenant, testPool, type SeededTenant,
} from './support/database';

type Path = 'legacy' | 'bilingual';
const paths: Path[] = ['legacy', 'bilingual'];
const clock = new SystemClock();
const legacy = new PostgresCatalogRepository(clock);
const bilingual = new PostgresCatalogMetadataV1CreationRepository(clock);
let pool: pg.Pool;
let uow: PostgresUnitOfWork;
let tenantA: SeededTenant;
let tenantB: SeededTenant;

function assertIsolatedPg16(): void {
  const url = process.env['DATABASE_URL'];
  const admin = process.env['ADMIN_DATABASE_URL'];
  if (!url || !admin) throw new Error('Explicit test and admin PG16 URLs required');
  const u = new URL(url);
  const a = new URL(admin);
  for (const value of [u, a]) {
    if (!['127.0.0.1', 'localhost'].includes(value.hostname) ||
        value.pathname !== '/sher_test') {
      throw new Error('P8b2c1 refuses non-local or non-test database');
    }
  }
  if (u.username !== 'sher_app' || a.username !== 'postgres' ||
      (u.port || '5432') !== (a.port || '5432')) {
    throw new Error('P8b2c1 refuses mismatched roles/ports');
  }
}
function ctx(t: SeededTenant) {
  return { tenantId: t.tenantId, userId: t.userId, timezone: t.timezone };
}
async function rawCategory(t: SeededTenant, opts: {
  parentId?: string | null;
  active?: boolean;
  archived?: boolean;
} = {}): Promise<string> {
  const id = Ulid.generate(clock);
  const now = clock.now();
  const archived = opts.archived ? now : null;
  await asTenant(pool, t.tenantId, client =>
    client.query(
      'INSERT INTO categories (id, tenant_id, parent_id, name, name_bn, ' +
      'is_active, deleted_at, created_at, updated_at, created_by, updated_by, version) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$9,1)',
      [id, t.tenantId, opts.parentId ?? null, 'Cat-' + id,
        'বাংলা', opts.active ?? true, archived, now, t.userId],
    ).then(() => undefined),
  );
  return id;
}
async function create(path: Path, t: SeededTenant, parentId: string | null) {
  const id = Ulid.generate(clock);
  const name = 'New-' + id;
  await uow.run(ctx(t), async tx => {
    if (path === 'legacy') await legacy.insertCategory(tx, ctx(t), { id, name, parentId });
    else await bilingual.insertCategory(tx, ctx(t), {
      id, name, nameBn: 'নতুন', parentId, version: 1,
    });
  });
  return id;
}
async function read(t: SeededTenant, id: string) {
  return asTenant(pool, t.tenantId, client =>
    client.query<{ id: string; parent_id: string | null; is_active: boolean;
      deleted_at: Date | null; name_bn: string | null }>(
      'SELECT id,parent_id,is_active,deleted_at,name_bn FROM categories WHERE id = $1', [id],
    ),
  ).then(r => r.rows[0] ?? null);
}
async function effects(t: SeededTenant): Promise<readonly number[]> {
  return asTenant(pool, t.tenantId, async client => {
    const tables = ['audit_events', 'outbox', 'journal_entries', 'stock_movements'];
    const results = await Promise.all(tables.map(table =>
      client.query<{ total: number }>('SELECT count(*)::integer AS total FROM ' + table)));
    return results.map(x => x.rows[0]?.total ?? -1);
  });
}

beforeAll(async () => {
  assertIsolatedPg16();
  pool = testPool();
  await prepareTestDatabase();
  uow = new PostgresUnitOfWork(createDatabase(pool));
  tenantA = await seedTenant(pool, { name: 'P8b2c1 A', permissions: [] });
  tenantB = await seedTenant(pool, { name: 'P8b2c1 B', permissions: [] });
});
afterAll(async () => { await pool?.end(); });

describe('MOD-002 P8b2c1 — tenant-RLS category parent lock', () => {
  it.each(paths)('%s accepts a root or an active top-level parent', async path => {
    const root = await create(path, tenantA, null);
    const child = await create(path, tenantA, root);
    expect(await read(tenantA, root)).toMatchObject({ parent_id: null, is_active: true });
    expect(await read(tenantA, child)).toMatchObject({
      parent_id: root, is_active: true, name_bn: path === 'bilingual' ? 'নতুন' : null,
    });
  });

  it.each(paths)('%s refuses inactive parent without creating a child', async path => {
    const parent = await rawCategory(tenantA, { active: false });
    await expect(create(path, tenantA, parent)).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_FAILED,
    });
    expect(await effects(tenantA)).toEqual([0, 0, 0, 0]);
  });

  it.each(paths)('%s refuses archived parent', async path => {
    const parent = await rawCategory(tenantA, { archived: true });
    await expect(create(path, tenantA, parent)).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });
  });

  it.each(paths)('%s refuses another tenant parent without disclosing it', async path => {
    const parent = await rawCategory(tenantB);
    await expect(create(path, tenantA, parent)).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });
    expect(await read(tenantA, parent)).toBeNull();
  });

  it.each(paths)('%s refuses a missing or nested parent', async path => {
    await expect(create(path, tenantA, Ulid.generate(clock))).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });
    const root = await rawCategory(tenantA);
    const intermediate = await rawCategory(tenantA, { parentId: root });
    await expect(create(path, tenantA, intermediate)).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_FAILED,
    });
  });

  it.each(paths)('%s holds parent FOR UPDATE until child transaction commits', async path => {
    const parent = await rawCategory(tenantA);
    await uow.run(ctx(tenantA), async tx => {
      const id = Ulid.generate(clock);
      if (path === 'legacy') await legacy.insertCategory(tx, ctx(tenantA), {
        id, name: 'Locked-' + id, parentId: parent,
      });
      else await bilingual.insertCategory(tx, ctx(tenantA), {
        id, name: 'Locked-' + id, nameBn: null, parentId: parent, version: 1,
      });

      // A second PostgreSQL connection cannot update the locked parent.
      await expect(asTenant(pool, tenantA.tenantId, async client => {
        await client.query("SET LOCAL lock_timeout = '180ms'");
        return client.query(
          'UPDATE categories SET is_active = FALSE WHERE tenant_id = $1 AND id = $2',
          [tenantA.tenantId, parent],
        );
      })).rejects.toMatchObject({ code: '55P03' });
    });
    expect((await read(tenantA, parent))?.is_active).toBe(true);
  });

  it.each(paths)('%s sees a competing parent deactivation committed before lock', async path => {
    const parent = await rawCategory(tenantA);
    let pending: Promise<string> | undefined;
    await asTenant(pool, tenantA.tenantId, async client => {
      await client.query(
        'UPDATE categories SET is_active = FALSE WHERE tenant_id = $1 AND id = $2',
        [tenantA.tenantId, parent],
      );
      // INSERT starts while parent is row-locked by another transaction.
      pending = create(path, tenantA, parent);
      // Let the other connection reach the parent row before COMMIT.
      await new Promise(resolve => setTimeout(resolve, 80));
    });
    await expect(pending).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED });
    expect((await read(tenantA, parent))?.is_active).toBe(false);
  });

  it('legacy archived parent removal refuses children even if caller missed the count', async () => {
    const parent = await rawCategory(tenantA);
    const child = await create('legacy', tenantA, parent);
    await expect(uow.run(ctx(tenantA), tx => legacy.archiveCategory(
      tx, ctx(tenantA), parent,
    ))).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED });
    expect(await read(tenantA, parent)).toMatchObject({ deleted_at: null });
    expect((await read(tenantA, child))?.parent_id).toBe(parent);
  });

  it('legacy hard delete refuses existing children without relying only on FK/preflight', async () => {
    const parent = await rawCategory(tenantA);
    const child = await create('bilingual', tenantA, parent);
    await expect(uow.run(ctx(tenantA), tx => legacy.deleteCategory(
      tx, ctx(tenantA), parent,
    ))).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED });
    expect(await read(tenantA, parent)).not.toBeNull();
    expect(await read(tenantA, child)).not.toBeNull();
  });

  it('parent removal holds parent lock so concurrent creation times out and cannot commit', async () => {
    const parent = await rawCategory(tenantA);
    await uow.run(ctx(tenantA), async tx => {
      await legacy.archiveCategory(tx, ctx(tenantA), parent);
      await expect(asTenant(pool, tenantA.tenantId, async client => {
        await client.query("SET LOCAL lock_timeout = '180ms'");
        // This second session must not sneak in a child of the archived parent.
        return client.query(
          'INSERT INTO categories (id, tenant_id, parent_id, name, created_at, updated_at, ' +
          'created_by, updated_by, version) ' +
          'VALUES ($1,$2,$3,$4,now(),now(),$5,$5,1)',
          [Ulid.generate(clock), tenantA.tenantId, parent, 'Race-' + Ulid.generate(clock),
            tenantA.userId],
        );
      })).rejects.toMatchObject({ code: '55P03' });
    });
    expect((await read(tenantA, parent))?.deleted_at).not.toBeNull();
    await expect(create('legacy', tenantA, parent)).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });
  });

  it('removes parent without children and preserves history, metadata and unrelated data', async () => {
    const parent = await rawCategory(tenantA);
    await uow.run(ctx(tenantA), tx => legacy.archiveCategory(tx, ctx(tenantA), parent));
    expect(await read(tenantA, parent)).toMatchObject({ name_bn: 'বাংলা' });
    expect((await read(tenantA, parent))?.deleted_at).not.toBeNull();
    expect(await effects(tenantA)).toEqual([0, 0, 0, 0]);
  });
});
