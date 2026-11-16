/**
 * MOD-002 P8b3-A #321: CURRENT-ROLE lifecycle read authorization.
 * Uses real nonowner PostgreSQL16 FORCE RLS, never a production database.
 * No HTTP route, no status writer, no product-settings UI modifications.
 */
import type pg from 'pg';
import { createDatabase, PostgresAccessControl, PostgresUnitOfWork } from '@sher/adapter-postgres';
import { Permission } from '@sher/core-contracts';
import { SystemClock, Ulid } from '@sher/shared-utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ReadCatalogLifecycleV1Service } from '../../../packages/core-application/src/catalog/read-catalog-lifecycle-v1-service';
import { PostgresCatalogLifecycleV1RosterReader } from '../../../packages/adapter-postgres/src/catalog-lifecycle-v1-roster-reader';
import {
  catalogLifecycleV1BrandRosterEnvelopeSchema,
  catalogLifecycleV1CategoryRosterEnvelopeSchema,
  catalogLifecycleV1UnitRosterEnvelopeSchema,
} from '../../../packages/core-contracts/src/catalog-lifecycle-v1';
import { SubscriptionEntitlementProvider } from '../src/deployment/subscription-entitlement-provider';
import {
  asTenant, prepareTestDatabase, resetDatabase, seedTenant, testPool, type SeededTenant,
} from './support/database';

const clock = new SystemClock();
const ulid = () => Ulid.generate(clock);
let pool: pg.Pool;
let uow: PostgresUnitOfWork;
let service: ReadCatalogLifecycleV1Service;
let a: SeededTenant;
let b: SeededTenant;
type Kind = 'units' | 'brands' | 'categories';

function disposableDbOnly() {
  const runtime = process.env['DATABASE_URL'];
  const admin = process.env['ADMIN_DATABASE_URL'];
  if (!runtime || !admin) throw new Error('P8b3-A requires explicit isolated PG16 URLs');
  const ru = new URL(runtime);
  const ad = new URL(admin);
  for (const url of [ru, ad]) {
    if (!['localhost', '127.0.0.1'].includes(url.hostname) ||
        url.pathname !== '/sher_test') throw new Error('P8b3-A refuses nonlocal or nontest DB');
  }
  if (ru.username !== 'sher_app' || ad.username !== 'postgres' ||
      (ru.port || '5432') !== (ad.port || '5432')) {
    throw new Error('P8b3-A refuses mismatched roles or ports');
  }
}
const ctx = (t: SeededTenant) => ({
  tenantId: t.tenantId, userId: t.userId, timezone: t.timezone,
});
async function master(t: SeededTenant, kind: Kind, name: string,
    state: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED' = 'ACTIVE',
    parentId: string | null = null) {
  const key = ulid();
  const now = clock.now();
  const extra = kind === 'units' ? 'symbol,' : kind === 'categories' ? 'parent_id,' : '';
  const extraValue = kind === 'units' ? 'pcs' : parentId;
  await asTenant(pool, t.tenantId, client => client.query(
    'INSERT INTO ' + kind + ' (id,tenant_id,name,name_bn,' + extra +
    'is_active,deleted_at,created_at,updated_at,created_by,updated_by,version) ' +
    'VALUES ($1,$2,$3,$4,' + (kind === 'brands' ? '' : '$9,') +
    '$5,$6,$7,$7,$8,$8,1)',
    kind === 'brands'
      ? [key, t.tenantId, name, 'বাংলা', state !== 'INACTIVE',
          state === 'ARCHIVED' ? now : null, now, t.userId]
      : [key, t.tenantId, name, 'বাংলা', state !== 'INACTIVE',
          state === 'ARCHIVED' ? now : null, now, t.userId, extraValue],
  ).then(() => undefined));
  return key;
}
async function effects(t: SeededTenant) {
  return asTenant(pool, t.tenantId, async client => {
    const names = ['audit_events', 'outbox', 'journal_entries', 'stock_movements'];
    const found = await Promise.all(names.map(table =>
      client.query<{ count: number }>('SELECT count(*)::integer count FROM ' + table)));
    return found.map(x => x.rows[0]?.count ?? -1);
  });
}
async function revoke(t: SeededTenant) {
  await asTenant(pool, t.tenantId, client => client.query(
    'DELETE FROM role_permissions WHERE tenant_id=$1 AND role_id=$2 AND permission_code=$3',
    [t.tenantId, t.roleId, Permission.PRODUCT_VIEW],
  ).then(() => undefined));
}
beforeAll(async () => {
  disposableDbOnly();
  pool = testPool();
  await prepareTestDatabase();
  uow = new PostgresUnitOfWork(createDatabase(pool));
  service = new ReadCatalogLifecycleV1Service(
    uow, new PostgresAccessControl(new SubscriptionEntitlementProvider(), clock),
    new PostgresCatalogLifecycleV1RosterReader(),
  );
});
afterAll(async () => { await pool?.end(); });
beforeEach(async () => {
  await resetDatabase(pool);
  a = await seedTenant(pool, { name: 'P8b3-A shop A', permissions: [Permission.PRODUCT_VIEW] });
  b = await seedTenant(pool, { name: 'P8b3-A shop B', permissions: [Permission.PRODUCT_VIEW] });
});

describe('MOD-002 P8b3-A: signed-source current permission roster (PG16 FORCE RLS)', () => {
  it('lists units with exact bilingual labels, symbol, archived precedence, and no invented values', async () => {
    const active = await master(a, 'units', 'Gira');
    const inactive = await master(a, 'units', 'Meter', 'INACTIVE');
    const archived = await master(a, 'units', 'Old Meter', 'ARCHIVED');
    const result = await service.read(ctx(a), 'unit');
    expect(result.kind).toBe('unit');
    expect(result.entries).toHaveLength(3);
    expect(result.entries.find(x => x.id === active)).toMatchObject({
      name: 'Gira', nameBn: 'বাংলা', symbol: 'pcs', state: 'ACTIVE', version: 1, archivedAt: null,
    });
    expect(result.entries.find(x => x.id === inactive)).toMatchObject({
      state: 'INACTIVE', archivedAt: null,
    });
    expect(result.entries.find(x => x.id === archived)).toMatchObject({
      state: 'ARCHIVED', archivedAt: expect.any(String),
    });
    expect(catalogLifecycleV1UnitRosterEnvelopeSchema.safeParse({ data: result }).success).toBe(true);
    expect(await effects(a)).toEqual([0, 0, 0, 0]);
  });

  it('lists brands with archived-over-active precedence and strict envelope', async () => {
    const active = await master(a, 'brands', 'RFL');
    const archived = await master(a, 'brands', 'Legacy', 'ARCHIVED');
    const result = await service.read(ctx(a), 'brand');
    expect(result.entries.find(x => x.id === active)).toMatchObject({
      name: 'RFL', state: 'ACTIVE', nameBn: 'বাংলা',
    });
    expect(result.entries.find(x => x.id === archived)?.state).toBe('ARCHIVED');
    expect(catalogLifecycleV1BrandRosterEnvelopeSchema.safeParse({ data: result }).success).toBe(true);
  });

  it('lists inactive and archived children with intact parent ID', async () => {
    const root = await master(a, 'categories', 'Electrical');
    const child = await master(a, 'categories', 'Switch', 'INACTIVE', root);
    const archived = await master(a, 'categories', 'Old switch', 'ARCHIVED', root);
    const result = await service.read(ctx(a), 'category');
    expect(result.entries.find(x => x.id === root)).toMatchObject({
      state: 'ACTIVE', parentId: null,
    });
    expect(result.entries.find(x => x.id === child)).toMatchObject({
      state: 'INACTIVE', parentId: root,
    });
    expect(result.entries.find(x => x.id === archived)).toMatchObject({
      state: 'ARCHIVED', parentId: root,
    });
    expect(catalogLifecycleV1CategoryRosterEnvelopeSchema.safeParse({ data: result }).success).toBe(true);
  });

  it('returns exactly empty entries for a tenant without any catalog masters', async () => {
    for (const kind of ['unit', 'brand', 'category'] as const) {
      expect(await service.read(ctx(a), kind)).toEqual({ kind, entries: [] });
    }
    expect(await effects(a)).toEqual([0, 0, 0, 0]);
  });

  it('never exposes another tenant entries with the same display names', async () => {
    for (const [kind, label] of [
      ['units', 'Gira'], ['brands', 'RFL'], ['categories', 'Electrical'],
    ] as const) {
      const ownId = await master(a, kind, label);
      const foreignId = await master(b, kind, label);
      const apiKind = kind === 'units' ? 'unit' : kind === 'brands' ? 'brand' : 'category';
      const own = await service.read(ctx(a), apiKind);
      const foreign = await service.read(ctx(b), apiKind);
      expect(own.entries.map(x => x.id)).toEqual([ownId]);
      expect(foreign.entries.map(x => x.id)).toEqual([foreignId]);
    }
    const rls = await asTenant(pool, a.tenantId, client => client.query<{
      relrowsecurity: boolean; relforcerowsecurity: boolean;
    }>("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='categories'::regclass"));
    expect(rls.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it('rejects current tenant roles without PRODUCT_VIEW, not merely JWT identity', async () => {
    const noPermission = await seedTenant(pool, { name: 'No View', permissions: [] });
    await master(noPermission, 'units', 'Confidential');
    await expect(service.read(ctx(noPermission), 'unit')).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    expect(await effects(noPermission)).toEqual([0, 0, 0, 0]);
  });

  it('immediately respects revocation of PRODUCT_VIEW after a successful read', async () => {
    await master(a, 'brands', 'Vision');
    expect((await service.read(ctx(a), 'brand')).entries).toHaveLength(1);
    await revoke(a);
    await expect(service.read(ctx(a), 'brand')).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    await expect(service.read(ctx(a), 'unit')).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    await expect(service.read(ctx(a), 'category')).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    expect(await effects(a)).toEqual([0, 0, 0, 0]);
  });

  it('rejects a user ID from a different tenant even if the target tenant has masters', async () => {
    await master(a, 'units', 'Private');
    await expect(service.read({
      tenantId: a.tenantId, userId: b.userId, timezone: a.timezone,
    }, 'unit')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(await effects(a)).toEqual([0, 0, 0, 0]);
  });

  it('rejects a deleted user with a once-valid PRODUCT_VIEW role', async () => {
    await master(a, 'units', 'Private');
    await asTenant(pool, a.tenantId, client => client.query(
      'UPDATE users SET deleted_at=now() WHERE tenant_id=$1 AND id=$2',
      [a.tenantId, a.userId],
    ).then(() => undefined));
    await expect(service.read(ctx(a), 'unit')).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
  });

  it('rejects an invalid kind instead of treating it as an empty successful roster', async () => {
    await master(a, 'units', 'Private');
    await expect(service.read(ctx(a), 'unknown' as 'unit')).rejects.toThrow(RangeError);
    expect(await effects(a)).toEqual([0, 0, 0, 0]);
  });
});
