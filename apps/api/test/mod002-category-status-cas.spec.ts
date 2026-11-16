/**
 * MOD-002 P8b2c2 / #301 — real PG16 FORCE-RLS category status CAS.
 * Backend-only/unmounted. Parent-first locking shares the P8b2c1 category
 * create/remove protocol. Uses a disposable sher_test database; NEVER prod.
 */
import type pg from 'pg';
import {
  createDatabase,
  PostgresCatalogRepository,
  PostgresCatalogMetadataV1CreationRepository,
  PostgresUnitOfWork,
} from '@sher/adapter-postgres';
import { ErrorCode } from '@sher/core-contracts';
import { SystemClock, Ulid } from '@sher/shared-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresCatalogLifecycleV1CategoryStatusWriter } from '../../../packages/adapter-postgres/src/catalog-lifecycle-v1-category-status-writer';
import {
  asTenant, prepareTestDatabase, seedTenant, testPool, type SeededTenant,
} from './support/database';

type State = 'ACTIVE' | 'INACTIVE';
type Variant = 'legacy' | 'bilingual';
const clock = new SystemClock();
const writer = new PostgresCatalogLifecycleV1CategoryStatusWriter(clock);
const legacy = new PostgresCatalogRepository(clock);
const bilingual = new PostgresCatalogMetadataV1CreationRepository(clock);
let pool: pg.Pool;
let uow: PostgresUnitOfWork;
let a: SeededTenant;
let b: SeededTenant;

function requireDisposablePg16(): void {
  const userUrl = process.env['DATABASE_URL'];
  const adminUrl = process.env['ADMIN_DATABASE_URL'];
  if (!userUrl || !adminUrl) throw new Error('Two explicit disposable PG16 URLs required');
  const user = new URL(userUrl);
  const admin = new URL(adminUrl);
  if ([user, admin].some(u => !['127.0.0.1', 'localhost'].includes(u.hostname) ||
      u.pathname !== '/sher_test') ||
      user.username !== 'sher_app' || admin.username !== 'postgres' ||
      (user.port || '5432') !== (admin.port || '5432')) {
    throw new Error('MOD-002 #301 test refuses nonlocal, nontest, or mismatched PG roles/ports');
  }
}
function ctx(t: SeededTenant) {
  return { tenantId: t.tenantId, userId: t.userId, timezone: t.timezone };
}
async function seed(t: SeededTenant, options: {
  parentId?: string | null;
  active?: boolean;
  archived?: boolean;
  version?: number;
} = {}): Promise<string> {
  const id = Ulid.generate(clock);
  const now = clock.now();
  await asTenant(pool, t.tenantId, client => client.query(
    'INSERT INTO categories (id,tenant_id,parent_id,name,name_bn,is_active,deleted_at,' +
    'created_at,updated_at,created_by,updated_by,version) ' +
    'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$9,$10)',
    [id, t.tenantId, options.parentId ?? null, 'Category-' + id, 'বাংলা',
      options.active ?? true, options.archived ? now : null, now, t.userId, options.version ?? 1],
  ).then(() => undefined));
  return id;
}
async function get(t: SeededTenant, id: string) {
  return asTenant(pool, t.tenantId, client => client.query<{
    id: string; parent_id: string | null; version: number; name: string;
    name_bn: string | null; is_active: boolean; deleted_at: Date | null;
    updated_at: Date; updated_by: string;
  }>('SELECT id,parent_id,version,name,name_bn,is_active,deleted_at,' +
    'updated_at,updated_by FROM categories WHERE tenant_id=$1 AND id=$2',
    [t.tenantId, id])).then(r => r.rows[0] ?? null);
}
function apply(t: SeededTenant, id: string, version: number, desired: State) {
  return uow.run(ctx(t), tx => writer.transitionCategory(tx, ctx(t), id, version, desired));
}
async function createChild(t: SeededTenant, parentId: string, variant: Variant) {
  const id = Ulid.generate(clock);
  await uow.run(ctx(t), tx => variant === 'legacy'
    ? legacy.insertCategory(tx, ctx(t), { id, name: 'Child-' + id, parentId })
    : bilingual.insertCategory(tx, ctx(t), {
        id, name: 'Child-' + id, nameBn: 'উপশ্রেণি', parentId, version: 1,
      }));
  return id;
}
async function countChildren(t: SeededTenant, id: string) {
  return asTenant(pool, t.tenantId, client => client.query<{ total: number }>(
    'SELECT count(*)::integer AS total FROM categories WHERE tenant_id=$1 AND parent_id=$2 ' +
    'AND is_active=TRUE AND deleted_at IS NULL', [t.tenantId, id],
  )).then(r => r.rows[0]?.total ?? -1);
}
async function businessSideEffects(t: SeededTenant) {
  return asTenant(pool, t.tenantId, async client => {
    const tables = ['audit_events', 'outbox', 'journal_entries', 'stock_movements'];
    const rows = await Promise.all(tables.map(table =>
      client.query<{ total: number }>('SELECT count(*)::integer AS total FROM ' + table)));
    return rows.map(r => r.rows[0]?.total ?? -1);
  });
}
function briefDelay() { return new Promise<void>(resolve => setTimeout(resolve, 75)); }

beforeAll(async () => {
  requireDisposablePg16();
  pool = testPool();
  await prepareTestDatabase();
  uow = new PostgresUnitOfWork(createDatabase(pool));
  a = await seedTenant(pool, { name: 'P8b2c2 Tenant A', permissions: [] });
  b = await seedTenant(pool, { name: 'P8b2c2 Tenant B', permissions: [] });
});
afterAll(async () => { await pool?.end(); });

describe('MOD-002 #301 parent-first category status CAS (PG16 FORCE RLS)', () => {
  it('changes a root ACTIVE → INACTIVE → ACTIVE, stamping once and preserving bilingual metadata', async () => {
    const root = await seed(a);
    const before = await get(a, root);
    expect(await apply(a, root, 1, 'INACTIVE')).toEqual({
      outcome: 'CHANGED', state: 'INACTIVE', version: 2,
    });
    expect(await get(a, root)).toMatchObject({
      name: before?.name, name_bn: 'বাংলা', parent_id: null, version: 2,
      is_active: false, updated_by: a.userId,
    });
    expect(await apply(a, root, 2, 'ACTIVE')).toEqual({
      outcome: 'CHANGED', state: 'ACTIVE', version: 3,
    });
    expect(await businessSideEffects(a)).toEqual([0, 0, 0, 0]);
  });

  it('root deactivation blocks ACTIVE children, but ignores INACTIVE/archived children without cascading', async () => {
    const root = await seed(a);
    const active = await seed(a, { parentId: root });
    const inactive = await seed(a, { parentId: root, active: false });
    const archived = await seed(a, { parentId: root, archived: true });
    expect(await apply(a, root, 1, 'INACTIVE')).toEqual({ outcome: 'ACTIVE_CHILDREN' });
    expect((await get(a, root))?.version).toBe(1);
    expect(await apply(a, active, 1, 'INACTIVE')).toEqual({
      outcome: 'CHANGED', state: 'INACTIVE', version: 2,
    });
    expect(await apply(a, root, 1, 'INACTIVE')).toMatchObject({
      outcome: 'CHANGED', version: 2,
    });
    expect(await get(a, inactive)).toMatchObject({ is_active: false, version: 1 });
    expect(await get(a, archived)).toMatchObject({ deleted_at: expect.any(Date), version: 1 });
    expect(await countChildren(a, root)).toBe(0);
  });

  it('child cannot activate under INACTIVE parent; deactivation is still permitted', async () => {
    const root = await seed(a, { active: false });
    const inactive = await seed(a, { parentId: root, active: false });
    const active = await seed(a, { parentId: root, active: true });
    expect(await apply(a, inactive, 1, 'ACTIVE')).toEqual({ outcome: 'PARENT_NOT_ACTIVE' });
    expect(await apply(a, active, 1, 'INACTIVE')).toEqual({
      outcome: 'CHANGED', state: 'INACTIVE', version: 2,
    });
    expect(await apply(a, root, 1, 'ACTIVE')).toMatchObject({ outcome: 'CHANGED', version: 2 });
    expect(await apply(a, inactive, 1, 'ACTIVE')).toMatchObject({ outcome: 'CHANGED', version: 2 });
    expect(await businessSideEffects(a)).toEqual([0, 0, 0, 0]);
  });

  it('same-version same-state is a true no-op; stale same-state must conflict even at max int4', async () => {
    const root = await seed(a, { version: 2_147_483_647 });
    const before = await get(a, root);
    expect(await apply(a, root, 2_147_483_647, 'ACTIVE')).toEqual({
      outcome: 'UNCHANGED', state: 'ACTIVE', version: 2_147_483_647,
    });
    expect(await get(a, root)).toEqual(before);
    expect(await apply(a, root, 2_147_483_646, 'ACTIVE')).toEqual({
      outcome: 'STALE_VERSION',
    });
    expect(await apply(a, root, 2_147_483_647, 'INACTIVE')).toEqual({
      outcome: 'VERSION_OVERFLOW',
    });
    expect(await get(a, root)).toEqual(before);
  });

  it('not-found, foreign tenant, archived, and stale archived requests do not disclose or mutate', async () => {
    const other = await seed(b);
    const archivedRoot = await seed(a, { archived: true });
    const archivedChildParent = await seed(a);
    const archivedChild = await seed(a, { parentId: archivedChildParent, archived: true });
    const missing = Ulid.generate(clock);
    expect(await apply(a, other, 1, 'INACTIVE')).toEqual({ outcome: 'NOT_FOUND' });
    expect(await apply(a, missing, 1, 'INACTIVE')).toEqual({ outcome: 'NOT_FOUND' });
    expect(await get(a, other)).toBeNull();
    expect(await apply(a, archivedRoot, 1, 'INACTIVE')).toEqual({ outcome: 'ARCHIVED' });
    expect(await apply(a, archivedChild, 1, 'ACTIVE')).toEqual({ outcome: 'ARCHIVED' });
    expect(await apply(a, archivedRoot, 2, 'ACTIVE')).toEqual({ outcome: 'STALE_VERSION' });
    expect((await get(b, other))?.version).toBe(1);
    expect(await businessSideEffects(a)).toEqual([0, 0, 0, 0]);
  });

  it('rejects invalid requested version/state without touching the database row', async () => {
    const root = await seed(a);
    for (const bad of [-1, 0, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(apply(a, root, bad, 'INACTIVE')).rejects.toThrow(RangeError);
    }
    await expect(apply(a, root, 1, 'PAUSED' as State)).rejects.toThrow(RangeError);
    expect((await get(a, root))?.version).toBe(1);
  });

  it('serializes two simultaneous version-matched writers; one wins, the other is stale', async () => {
    const root = await seed(a);
    const results = await Promise.all([
      apply(a, root, 1, 'INACTIVE'),
      apply(a, root, 1, 'INACTIVE'),
    ]);
    expect(results.map(r => r.outcome).sort()).toEqual(['CHANGED', 'STALE_VERSION']);
    expect(await get(a, root)).toMatchObject({ is_active: false, version: 2 });
  });

  it.each(['legacy', 'bilingual'] as const)(
    '%s child create cannot race behind a committed root deactivation', async variant => {
      const root = await seed(a);
      let blocked: Promise<string> | undefined;
      await uow.run(ctx(a), async tx => {
        expect(await writer.transitionCategory(tx, ctx(a), root, 1, 'INACTIVE'))
          .toMatchObject({ outcome: 'CHANGED' });
        blocked = createChild(a, root, variant);
        await briefDelay();
      });
      await expect(blocked).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED });
      expect(await countChildren(a, root)).toBe(0);
      expect(await get(a, root)).toMatchObject({ is_active: false, version: 2 });
    },
  );

  it.each(['legacy', 'bilingual'] as const)(
    '%s child create locking the root first prevents a competing root deactivation', async variant => {
      const root = await seed(a);
      let pending: ReturnType<typeof apply> | undefined;
      await uow.run(ctx(a), async tx => {
        const id = Ulid.generate(clock);
        if (variant === 'legacy') await legacy.insertCategory(tx, ctx(a), {
          id, name: 'Insert-first-' + id, parentId: root,
        });
        else await bilingual.insertCategory(tx, ctx(a), {
          id, name: 'Insert-first-' + id, nameBn: 'বাংলা', parentId: root, version: 1,
        });
        pending = apply(a, root, 1, 'INACTIVE');
        await briefDelay();
      });
      await expect(pending).resolves.toEqual({ outcome: 'ACTIVE_CHILDREN' });
      expect((await get(a, root))?.is_active).toBe(true);
      expect(await countChildren(a, root)).toBe(1);
    },
  );

  it('child activation holding parent lock prevents deactivation until active-child recheck', async () => {
    const root = await seed(a);
    const child = await seed(a, { parentId: root, active: false });
    let pending: ReturnType<typeof apply> | undefined;
    await uow.run(ctx(a), async tx => {
      expect(await writer.transitionCategory(tx, ctx(a), child, 1, 'ACTIVE'))
        .toMatchObject({ outcome: 'CHANGED' });
      pending = apply(a, root, 1, 'INACTIVE');
      await briefDelay();
    });
    await expect(pending).resolves.toEqual({ outcome: 'ACTIVE_CHILDREN' });
    expect(await get(a, child)).toMatchObject({ is_active: true, version: 2 });
  });

  it('root deactivation holding parent lock blocks later child activation', async () => {
    const root = await seed(a);
    const child = await seed(a, { parentId: root, active: false });
    let pending: ReturnType<typeof apply> | undefined;
    await uow.run(ctx(a), async tx => {
      expect(await writer.transitionCategory(tx, ctx(a), root, 1, 'INACTIVE'))
        .toMatchObject({ outcome: 'CHANGED' });
      pending = apply(a, child, 1, 'ACTIVE');
      await briefDelay();
    });
    await expect(pending).resolves.toEqual({ outcome: 'PARENT_NOT_ACTIVE' });
    expect(await get(a, child)).toMatchObject({ is_active: false, version: 1 });
  });

  it('root archive and metadata edit invalidate future matching-version transitions', async () => {
    const archivedRoot = await seed(a);
    await uow.run(ctx(a), tx => legacy.archiveCategory(tx, ctx(a), archivedRoot));
    expect(await apply(a, archivedRoot, 2, 'ACTIVE')).toEqual({ outcome: 'ARCHIVED' });
    const editedRoot = await seed(a);
    await uow.run(ctx(a), tx => legacy.renameCategory(tx, ctx(a), editedRoot, 'Renamed'));
    expect(await apply(a, editedRoot, 1, 'INACTIVE')).toEqual({
      outcome: 'STALE_VERSION',
    });
    expect(await get(a, editedRoot)).toMatchObject({
      name: 'Renamed', version: 2, is_active: true,
    });
  });

  it('rolls back entire transaction after a successful status change', async () => {
    const root = await seed(a);
    await expect(uow.run(ctx(a), async tx => {
      expect(await writer.transitionCategory(tx, ctx(a), root, 1, 'INACTIVE'))
        .toMatchObject({ outcome: 'CHANGED' });
      throw new Error('simulate audit/outbox failure owned by future service');
    })).rejects.toThrow('simulate audit/outbox failure');
    expect(await get(a, root)).toMatchObject({ is_active: true, version: 1 });
    expect(await businessSideEffects(a)).toEqual([0, 0, 0, 0]);
  });
});
