/**
 * MOD-002 #324: real nonowner PostgreSQL16 status/audit/outbox authorization.
 * Unmounted application service. No production DB, API route or React changes.
 */
import type pg from 'pg';
import {
  createDatabase, PostgresAccessControl, PostgresAuditWriter, PostgresOutbox,
  PostgresUnitOfWork,
} from '@sher/adapter-postgres';
import { Permission } from '@sher/core-contracts';
import type { AuditWriter, Outbox } from '@sher/core-application';
import { SystemClock, Ulid } from '@sher/shared-utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ManageCatalogLifecycleV1StatusService } from
  '../../../packages/core-application/src/catalog/manage-catalog-lifecycle-v1-status-service';
import { PostgresCatalogLifecycleV1StatusWriter } from
  '../../../packages/adapter-postgres/src/catalog-lifecycle-v1-status-writer';
import { PostgresCatalogLifecycleV1CategoryStatusWriter } from
  '../../../packages/adapter-postgres/src/catalog-lifecycle-v1-category-status-writer';
import { SubscriptionEntitlementProvider } from '../src/deployment/subscription-entitlement-provider';
import { asTenant, prepareTestDatabase, seedTenant, testPool, type SeededTenant } from './support/database';

type Kind = 'unit' | 'brand' | 'category';
type State = 'ACTIVE' | 'INACTIVE';
const tables = { unit: 'units', brand: 'brands', category: 'categories' } as const;
const permissions = {
  unit: Permission.UNIT_MANAGE, brand: Permission.BRAND_MANAGE,
  category: Permission.CATEGORY_MANAGE,
} as const;
const clock = new SystemClock();
const ulid = () => Ulid.generate(clock);
const audit = new PostgresAuditWriter(clock);
const outbox = new PostgresOutbox(clock);
let pool: pg.Pool;
let uow: PostgresUnitOfWork;
let service: ManageCatalogLifecycleV1StatusService;
let a: SeededTenant;
let b: SeededTenant;

function disposableOnly() {
  const runtime = process.env['DATABASE_URL'];
  const admin = process.env['ADMIN_DATABASE_URL'];
  if (!runtime || !admin) throw new Error('Explicit isolated PG16 URLs required');
  const ru = new URL(runtime), ad = new URL(admin);
  for (const url of [ru, ad]) {
    if (!['localhost', '127.0.0.1'].includes(url.hostname) ||
        url.pathname !== '/sher_test') throw new Error('Refuse nonlocal or nontest database');
  }
  if (ru.username !== 'sher_app' || ad.username !== 'postgres' ||
      (ru.port || '5432') !== (ad.port || '5432')) {
    throw new Error('Require matching isolated database roles and ports');
  }
}
const ctx = (t: SeededTenant) => ({
  tenantId: t.tenantId, userId: t.userId, timezone: t.timezone,
});
function construct(auditWriter: AuditWriter = audit, eventOutbox: Outbox = outbox) {
  return new ManageCatalogLifecycleV1StatusService(
    uow,
    new PostgresAccessControl(new SubscriptionEntitlementProvider(), clock),
    new PostgresCatalogLifecycleV1StatusWriter(clock),
    new PostgresCatalogLifecycleV1CategoryStatusWriter(clock),
    auditWriter, eventOutbox,
  );
}
async function master(t: SeededTenant, kind: Kind, options: {
  state?: State | 'ARCHIVED'; parentId?: string; version?: number;
} = {}) {
  const key = ulid();
  const state = options.state ?? 'ACTIVE';
  const archived = state === 'ARCHIVED' ? clock.now() : null;
  const args = [key, t.tenantId, 'Master-' + key, 'বাংলা',
    state !== 'INACTIVE', archived, clock.now(), t.userId];
  const extra = kind === 'unit' ? 'symbol,' : kind === 'category' ? 'parent_id,' : '';
  const sql = 'INSERT INTO ' + tables[kind] +
    ' (id,tenant_id,name,name_bn,' + extra +
    'is_active,deleted_at,created_at,updated_at,created_by,updated_by,version) ' +
    'VALUES ($1,$2,$3,$4,' + (extra ? '$9,' : '') +
    '$5,$6,$7,$7,$8,$8,' + (extra ? '$10' : '$9') + ')';
  const params = extra
    ? [...args, kind === 'unit' ? 'pcs' : options.parentId ?? null, options.version ?? 1]
    : [...args, options.version ?? 1];
  await asTenant(pool, t.tenantId, client => client.query(sql, params).then(() => undefined));
  return key;
}
async function record(t: SeededTenant, kind: Kind, key: string) {
  return asTenant(pool, t.tenantId, client => client.query<{
    version: number; is_active: boolean; updated_by: string; updated_at: Date;
    name: string; name_bn: string | null; parent_id?: string | null;
  }>('SELECT version,is_active,updated_by,updated_at,name,name_bn' +
    (kind === 'category' ? ',parent_id' : '') +
    ' FROM ' + tables[kind] + ' WHERE tenant_id=$1 AND id=$2',
    [t.tenantId, key])).then(q => q.rows[0] ?? null);
}
async function effects(t: SeededTenant) {
  return asTenant(pool, t.tenantId, async client => {
    const audits = await client.query<{
      entity_type: string; entity_id: string; action: string; created_by: string;
      before_json: { state: string; version: number };
      after_json: { state: string; version: number };
    }>('SELECT entity_type,entity_id,action,created_by,before_json,after_json ' +
      'FROM audit_events WHERE tenant_id=$1 ORDER BY created_at,id', [t.tenantId]);
    const events = await client.query<{
      event_type: string; aggregate_type: string; aggregate_id: string;
      created_by: string; payload: {
        change: string; fromState: string; state: string;
        previousVersion: number; version: number;
      };
    }>('SELECT event_type,aggregate_type,aggregate_id,created_by,payload ' +
      'FROM outbox WHERE tenant_id=$1 ORDER BY created_at,id', [t.tenantId]);
    const other = await Promise.all(['journal_entries', 'stock_movements', 'cash_movements']
      .map(table => client.query<{ n: number }>(
        'SELECT count(*)::integer AS n FROM ' + table)));
    return {
      audits: audits.rows, events: events.rows,
      stockCashJournal: other.map(x => x.rows[0]?.n ?? -1),
    };
  });
}
function apply(t: SeededTenant, kind: Kind, key: string, expectedVersion: number,
  desiredState: State, target = service) {
  return target.transition({ ctx: ctx(t), kind, id: key, expectedVersion, desiredState });
}

beforeAll(async () => {
  disposableOnly();
  pool = testPool();
  await prepareTestDatabase();
  uow = new PostgresUnitOfWork(createDatabase(pool));
  service = construct();
});
afterAll(async () => { await pool?.end(); });
beforeEach(async () => {
  a = await seedTenant(pool, { name: 'Status A', permissions: Object.values(permissions) });
  b = await seedTenant(pool, { name: 'Status B', permissions: Object.values(permissions) });
});

describe('MOD-002 #324 Class-M status, permissions and atomic event evidence (PG16 FORCE RLS)', () => {
  it.each(['unit', 'brand', 'category'] as const)(
    '%s changed status produces exact per-row audit/outbox and no financial effects', async kind => {
      const key = await master(a, kind);
      const before = await record(a, kind, key);
      expect(await apply(a, kind, key, 1, 'INACTIVE')).toEqual({
        outcome: 'CHANGED', state: 'INACTIVE', version: 2,
      });
      expect(await record(a, kind, key)).toMatchObject({
        version: 2, is_active: false, updated_by: a.userId,
        name: before?.name, name_bn: 'বাংলা',
      });
      const result = await effects(a);
      expect(result.audits).toHaveLength(1);
      expect(result.events).toHaveLength(1);
      expect(result.audits[0]).toMatchObject({
        entity_type: kind, entity_id: key, action: 'UPDATE', created_by: a.userId,
        before_json: { state: 'ACTIVE', version: 1 },
        after_json: { state: 'INACTIVE', version: 2 },
      });
      expect(result.events[0]).toMatchObject({
        event_type: kind + '.updated', aggregate_type: kind,
        aggregate_id: key, created_by: a.userId,
        payload: { change: 'status', fromState: 'ACTIVE',
          state: 'INACTIVE', previousVersion: 1, version: 2 },
      });
      expect(result.stockCashJournal).toEqual([0, 0, 0]);
      expect(await apply(a, kind, key, 2, 'ACTIVE')).toEqual({
        outcome: 'CHANGED', state: 'ACTIVE', version: 3,
      });
      expect((await effects(a)).audits).toHaveLength(2);
      expect((await effects(a)).events).toHaveLength(2);
    },
  );

  it.each(['unit', 'brand', 'category'] as const)(
    '%s same-state is no-op; stale same-state refuses without effects', async kind => {
      const key = await master(a, kind, { state: 'INACTIVE' });
      const before = await record(a, kind, key);
      expect(await apply(a, kind, key, 1, 'INACTIVE')).toEqual({
        outcome: 'UNCHANGED', state: 'INACTIVE', version: 1,
      });
      expect(await apply(a, kind, key, 2, 'INACTIVE')).toEqual({
        outcome: 'STALE_VERSION',
      });
      expect(await record(a, kind, key)).toEqual(before);
      expect(await effects(a)).toEqual({
        audits: [], events: [], stockCashJournal: [0, 0, 0],
      });
    },
  );

  it.each(['unit', 'brand', 'category'] as const)(
    '%s foreign and missing IDs do not disclose or write', async kind => {
      const key = await master(a, kind);
      expect(await apply(b, kind, key, 1, 'INACTIVE')).toEqual({
        outcome: 'NOT_FOUND',
      });
      expect(await apply(a, kind, ulid(), 1, 'INACTIVE')).toEqual({
        outcome: 'NOT_FOUND',
      });
      expect((await record(a, kind, key))?.version).toBe(1);
      expect((await effects(a)).audits).toHaveLength(0);
      expect((await effects(b)).events).toHaveLength(0);
    },
  );

  it.each(['unit', 'brand', 'category'] as const)(
    '%s archived, stale archived and int4 overflow have zero events', async kind => {
      const archived = await master(a, kind, { state: 'ARCHIVED' });
      const capped = await master(a, kind, { version: 2_147_483_647 });
      expect(await apply(a, kind, archived, 1, 'INACTIVE')).toEqual({ outcome: 'ARCHIVED' });
      expect(await apply(a, kind, archived, 2, 'INACTIVE')).toEqual({
        outcome: 'STALE_VERSION',
      });
      expect(await apply(a, kind, capped, 2_147_483_647, 'ACTIVE')).toEqual({
        outcome: 'UNCHANGED', state: 'ACTIVE', version: 2_147_483_647,
      });
      expect(await apply(a, kind, capped, 2_147_483_647, 'INACTIVE')).toEqual({
        outcome: 'VERSION_OVERFLOW',
      });
      expect((await effects(a)).audits).toHaveLength(0);
      expect((await effects(a)).events).toHaveLength(0);
    },
  );

  it.each(['unit', 'brand', 'category'] as const)(
    '%s denies current user without kind-specific management permission', async kind => {
      const denied = await seedTenant(pool, {
        name: 'Denied', permissions: [Permission.PRODUCT_VIEW],
      });
      const key = await master(denied, kind);
      await expect(apply(denied, kind, key, 1, 'INACTIVE')).rejects.toMatchObject({
        code: 'PERMISSION_DENIED',
      });
      expect((await record(denied, kind, key))?.version).toBe(1);
      expect((await effects(denied)).audits).toHaveLength(0);
    },
  );

  it('enforces post-login revocation and refuses a foreign tenant user ID', async () => {
    const key = await master(a, 'brand');
    expect((await apply(a, 'brand', key, 1, 'INACTIVE')).outcome).toBe('CHANGED');
    await asTenant(pool, a.tenantId, client => client.query(
      'DELETE FROM role_permissions WHERE tenant_id=$1 AND role_id=$2 AND permission_code=$3',
      [a.tenantId, a.roleId, Permission.BRAND_MANAGE],
    ).then(() => undefined));
    await expect(apply(a, 'brand', key, 2, 'ACTIVE')).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    await expect(service.transition({
      ctx: { tenantId: a.tenantId, userId: b.userId, timezone: a.timezone },
      kind: 'brand', id: key, expectedVersion: 2, desiredState: 'ACTIVE',
    })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect((await record(a, 'brand', key))?.version).toBe(2);
    expect((await effects(a)).audits).toHaveLength(1);
    expect((await effects(a)).events).toHaveLength(1);
  });

  it('preserves parent/child status and no-cascade invariants with zero refusal events', async () => {
    const root = await master(a, 'category');
    const child = await master(a, 'category', { parentId: root });
    expect(await apply(a, 'category', root, 1, 'INACTIVE')).toEqual({
      outcome: 'ACTIVE_CHILDREN',
    });
    expect(await apply(a, 'category', child, 1, 'INACTIVE')).toMatchObject({
      outcome: 'CHANGED', version: 2,
    });
    expect(await apply(a, 'category', root, 1, 'INACTIVE')).toMatchObject({
      outcome: 'CHANGED', version: 2,
    });
    expect(await apply(a, 'category', child, 2, 'ACTIVE')).toEqual({
      outcome: 'PARENT_NOT_ACTIVE',
    });
    const result = await effects(a);
    expect(result.audits).toHaveLength(2);
    expect(result.events).toHaveLength(2);
    expect(result.stockCashJournal).toEqual([0, 0, 0]);
    expect((await record(a, 'category', child))?.parent_id).toBe(root);
  });

  it.each(['unit', 'brand', 'category'] as const)(
    '%s concurrent matching version changes have one winner and one event pair', async kind => {
      const key = await master(a, kind);
      const results = await Promise.all([
        apply(a, kind, key, 1, 'INACTIVE'),
        apply(a, kind, key, 1, 'INACTIVE'),
      ]);
      expect(results.map(x => x.outcome).sort()).toEqual(['CHANGED', 'STALE_VERSION']);
      expect((await record(a, kind, key))?.version).toBe(2);
      expect((await effects(a)).audits).toHaveLength(1);
      expect((await effects(a)).events).toHaveLength(1);
    },
  );

  it('rolls back row, audit and already inserted outbox on outbox failure', async () => {
    const key = await master(a, 'unit');
    const failingOutbox: Outbox = {
      append: async (tx, c, event) => {
        await outbox.append(tx, c, event);
        throw new Error('forced outbox failure');
      },
    };
    await expect(apply(a, 'unit', key, 1, 'INACTIVE',
      construct(audit, failingOutbox))).rejects.toThrow('forced outbox failure');
    expect((await record(a, 'unit', key))?.version).toBe(1);
    expect(await effects(a)).toEqual({
      audits: [], events: [], stockCashJournal: [0, 0, 0],
    });
  });

  it('rolls back row and already inserted audit on audit failure', async () => {
    const key = await master(a, 'brand');
    const failingAudit: AuditWriter = {
      append: async (tx, c, event) => {
        await audit.append(tx, c, event);
        throw new Error('forced audit failure');
      },
      appendPlatform: (tx, event) => audit.appendPlatform(tx, event),
    };
    await expect(apply(a, 'brand', key, 1, 'INACTIVE',
      construct(failingAudit, outbox))).rejects.toThrow('forced audit failure');
    expect((await record(a, 'brand', key))?.version).toBe(1);
    expect(await effects(a)).toEqual({
      audits: [], events: [], stockCashJournal: [0, 0, 0],
    });
  });

  it('rejects invalid kinds, states and versions before any change', async () => {
    const key = await master(a, 'unit');
    await expect(service.transition({
      ctx: ctx(a), kind: 'other' as Kind, id: key,
      expectedVersion: 1, desiredState: 'INACTIVE',
    })).rejects.toThrow(RangeError);
    for (const bad of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(apply(a, 'unit', key, bad, 'INACTIVE'))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    }
    await expect(apply(a, 'unit', key, 1, 'PAUSED' as State))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await record(a, 'unit', key))?.version).toBe(1);
    expect((await effects(a)).audits).toHaveLength(0);
  });
});
