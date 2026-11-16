/**
 * MOD-002 P8b3-T1 #333: signed Nest lifecycle-v1 HTTP + real PG16 FORCE RLS.
 * This test opts into exclusive localhost:55961/sher_test only. No shared DB.
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
import { asTenant, prepareTestDatabase, resetDatabase, seedTenant, testPool } from './support/database';
import type { SeededTenant } from './support/database';

const clock = new SystemClock();
const ulid = () => Ulid.generate(clock);
type Kind = 'unit' | 'brand' | 'category';
type State = 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
const kinds = ['unit', 'brand', 'category'] as const;
const table = { unit: 'units', brand: 'brands', category: 'categories' } as const;
const permission = {
  unit: Permission.UNIT_MANAGE,
  brand: Permission.BRAND_MANAGE,
  category: Permission.CATEGORY_MANAGE,
} as const;
const root = '/api/v1/catalog/lifecycle-v1';
const plural = (kind: Kind) => kind === 'category' ? 'categories' : kind + 's';
const pathFor = (kind: Kind) => root + '/' + plural(kind);
const patchFor = (kind: Kind, id: string) => pathFor(kind) + '/' + id + '/status';
let app: INestApplication;
let pool: pg.Pool;
let a: SeededTenant;
let b: SeededTenant;
let tokenA: string;
let tokenB: string;

function disposableOnly() {
  for (const name of ['DATABASE_URL', 'TEST_DATABASE_URL', 'ADMIN_DATABASE_URL']) {
    const raw = process.env[name];
    if (!raw) throw new Error('Missing isolated ' + name);
    const u = new URL(raw);
    if (u.protocol !== 'postgresql:' || u.hostname !== '127.0.0.1' ||
        u.port !== '55961' || u.pathname !== '/sher_test' ||
        u.username !== (name === 'ADMIN_DATABASE_URL' ? 'postgres' : 'sher_app')) {
      throw new Error('P8b3-T1 refuses any shared or non-disposable PostgreSQL URL');
    }
  }
}
async function master(t: SeededTenant, kind: Kind, options: {
  name?: string; state?: State; parentId?: string | null; version?: number;
} = {}): Promise<string> {
  const key = ulid();
  const state = options.state ?? 'ACTIVE';
  const now = clock.now();
  const extra = kind === 'unit' ? 'symbol,' : kind === 'category' ? 'parent_id,' : '';
  const values = [key, t.tenantId, options.name ?? 'Same name', 'বাংলা',
    state !== 'INACTIVE', state === 'ARCHIVED' ? now : null, now, t.userId];
  const sql = 'INSERT INTO ' + table[kind] + ' ' +
    '(id,tenant_id,name,name_bn,' + extra +
    'is_active,deleted_at,created_at,updated_at,created_by,updated_by,version) ' +
    'VALUES ($1,$2,$3,$4,' + (extra ? '$9,' : '') +
    '$5,$6,$7,$7,$8,$8,$' + (extra ? '10' : '9') + ')';
  const params = extra
    ? [...values, kind === 'unit' ? 'pcs' : options.parentId ?? null, options.version ?? 1]
    : [...values, options.version ?? 1];
  await asTenant(pool, t.tenantId, client => client.query(sql, params).then(() => undefined));
  return key;
}
function get(kind: Kind, token = tokenA) {
  return request(app.getHttpServer()).get(pathFor(kind))
    .set('Authorization', 'Bearer ' + token);
}
function patch(kind: Kind, key: string, expectedVersion: number,
  desiredState: 'ACTIVE' | 'INACTIVE', token = tokenA) {
  return request(app.getHttpServer()).patch(patchFor(kind, key))
    .set('Authorization', 'Bearer ' + token)
    .send({ expectedVersion, desiredState });
}
async function effects(t: SeededTenant) {
  return asTenant(pool, t.tenantId, async client => {
    const r = await client.query<{
      audits: number; outbox: number; journal: number; stock: number; cash: number;
    }>(
      'SELECT (SELECT COUNT(*)::int FROM audit_events) audits,' +
      '(SELECT COUNT(*)::int FROM outbox) outbox,' +
      '(SELECT COUNT(*)::int FROM journal_entries) journal,' +
      '(SELECT COUNT(*)::int FROM stock_movements) stock,' +
      '(SELECT COUNT(*)::int FROM cash_movements) cash',
    );
    return r.rows[0]!;
  });
}
async function saved(t: SeededTenant, kind: Kind, key: string) {
  return asTenant(pool, t.tenantId, client => client.query<{
    version: number; is_active: boolean; updated_at: Date; updated_by: string;
  }>('SELECT version,is_active,updated_at,updated_by FROM ' + table[kind] +
    ' WHERE tenant_id=$1 AND id=$2', [t.tenantId, key])
  ).then(r => r.rows[0] ?? null);
}
async function revoke(t: SeededTenant, right: string) {
  await asTenant(pool, t.tenantId, client => client.query(
    'DELETE FROM role_permissions WHERE tenant_id=$1 AND role_id=$2 AND permission_code=$3',
    [t.tenantId, t.roleId, right],
  ).then(() => undefined));
}
beforeAll(async () => {
  disposableOnly();
  pool = testPool();
  await prepareTestDatabase();
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication();
  app.useGlobalFilters(new AppErrorFilter());
  await app.init();
}, 90_000);
afterAll(async () => { await app?.close(); await pool?.end(); });
beforeEach(async () => {
  await resetDatabase(pool);
  a = await seedTenant(pool, {
    name: 'Catalog shop A',
    permissions: [Permission.PRODUCT_VIEW, ...Object.values(permission)],
  });
  b = await seedTenant(pool, {
    name: 'Catalog shop B',
    permissions: [Permission.PRODUCT_VIEW, ...Object.values(permission)],
  });
  tokenA = signToken(a, TEST_JWT_SECRET);
  tokenB = signToken(b, TEST_JWT_SECRET);
});

describe('MOD-002 #333 signed lifecycle-v1 Nest HTTP / PostgreSQL16', () => {
  it('uses FORCE ROW LEVEL SECURITY, nonowner runtime and no shared DB', async () => {
    const r = await pool.query<{
      relrowsecurity: boolean; relforcerowsecurity: boolean;
    }>("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid='categories'::regclass");
    expect(r.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it.each(kinds)('GET %s signed roster is bilingual, archive-accurate and tenant-isolated', async kind => {
    const own = await master(a, kind, { state: 'ACTIVE' });
    const inactive = await master(a, kind, { state: 'INACTIVE', name: 'Inactive' });
    const archived = await master(a, kind, { state: 'ARCHIVED', name: 'Archived' });
    const foreign = await master(b, kind, { name: 'Same name' });
    const before = await effects(a);
    const ra = await get(kind);
    expect(ra.status, JSON.stringify(ra.body)).toBe(200);
    expect(ra.body.data.kind).toBe(kind);
    expect(ra.body.data.entries).toHaveLength(3);
    expect(ra.body.data.entries.find((x: { id: string }) => x.id === own))
      .toMatchObject({ name: 'Same name', nameBn: 'বাংলা', state: 'ACTIVE', version: 1, archivedAt: null });
    expect(ra.body.data.entries.find((x: { id: string }) => x.id === inactive))
      .toMatchObject({ state: 'INACTIVE', archivedAt: null });
    expect(ra.body.data.entries.find((x: { id: string }) => x.id === archived))
      .toMatchObject({ state: 'ARCHIVED', archivedAt: expect.any(String) });
    expect(ra.text).not.toContain(foreign);
    expect(ra.text).not.toContain(a.tenantId);
    expect(ra.text).not.toContain(a.userId);
    const rb = await get(kind, tokenB);
    expect(rb.status).toBe(200);
    expect(rb.body.data.entries.map((x: {id: string}) => x.id)).toEqual([foreign]);
    expect(await effects(a)).toEqual(before);
  });

  it('GET category retains active/inactive parent hierarchy without reparenting', async () => {
    const parent = await master(a, 'category', { name: 'Electrical' });
    const child = await master(a, 'category', { name: 'Switch', state: 'INACTIVE', parentId: parent });
    const r = await get('category');
    expect(r.status).toBe(200);
    expect(r.body.data.entries.find((x: {id: string}) => x.id === parent)?.parentId).toBeNull();
    expect(r.body.data.entries.find((x: {id: string}) => x.id === child)?.parentId).toBe(parent);
  });

  it.each(kinds)('GET %s refuses unsigned and tampered bearer, and revoked current view', async kind => {
    const missing = await request(app.getHttpServer()).get(pathFor(kind));
    expect(missing.status).toBe(401);
    expect(missing.body.error.code).toBe('UNAUTHENTICATED');
    const bad = await get(kind, tokenA + 'x');
    expect(bad.status).toBe(401);
    await master(a, kind);
    await revoke(a, Permission.PRODUCT_VIEW);
    const revoked = await get(kind);
    expect(revoked.status).toBe(403);
    expect(revoked.body.error.code).toBe('PERMISSION_DENIED');
    expect(await effects(a)).toEqual({
      audits: 0, outbox: 0, journal: 0, stock: 0, cash: 0,
    });
  });

  it.each(kinds)('PATCH %s changes status, emits one audit/outbox, unchanged and stale replay write nothing', async kind => {
    const key = await master(a, kind);
    const r = await patch(kind, key, 1, 'INACTIVE');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({
      data: { kind, id: key, outcome: 'CHANGED', state: 'INACTIVE', version: 2 },
    });
    expect(await saved(a, kind, key)).toMatchObject({ version: 2, is_active: false, updated_by: a.userId });
    const e1 = await effects(a);
    expect(e1).toEqual({ audits: 1, outbox: 1, journal: 0, stock: 0, cash: 0 });
    const unchangedBefore = await saved(a, kind, key);
    const same = await patch(kind, key, 2, 'INACTIVE');
    expect(same.status).toBe(200);
    expect(same.body.data.outcome).toBe('UNCHANGED');
    expect(await saved(a, kind, key)).toEqual(unchangedBefore);
    const replay = await patch(kind, key, 1, 'INACTIVE');
    expect(replay.status).toBe(409);
    expect(replay.body.error).toMatchObject({
      code: 'CONFLICT_STALE_VERSION', details: { reason: 'STALE_VERSION' },
    });
    expect(await effects(a)).toEqual(e1);
    const active = await patch(kind, key, 2, 'ACTIVE');
    expect(active.status).toBe(200);
    expect(active.body.data).toMatchObject({ outcome: 'CHANGED', version: 3, state: 'ACTIVE' });
    expect(await effects(a)).toEqual({ audits: 2, outbox: 2, journal: 0, stock: 0, cash: 0 });
  });

  it.each(kinds)('PATCH %s missing and foreign IDs are identical 404s with zero changes', async kind => {
    const foreign = await master(b, kind);
    const missing = ulid();
    const x = await patch(kind, foreign, 1, 'INACTIVE');
    const y = await patch(kind, missing, 1, 'INACTIVE');
    expect(x.status).toBe(404);
    expect(y.status).toBe(404);
    expect(x.body.error).toMatchObject({
      code: y.body.error.code, message: y.body.error.message, details: y.body.error.details,
    });
    expect(typeof x.body.error.traceId).toBe('string');
    expect(typeof y.body.error.traceId).toBe('string');
    expect(x.text).not.toContain(foreign);
    expect(await effects(a)).toEqual({ audits: 0, outbox: 0, journal: 0, stock: 0, cash: 0 });
  });

  it.each(kinds)('PATCH %s denies unsigned, tampered and revoked kind-specific permission', async kind => {
    const key = await master(a, kind);
    const noToken = await request(app.getHttpServer())
      .patch(patchFor(kind, key)).send({ expectedVersion: 1, desiredState: 'INACTIVE' });
    expect(noToken.status).toBe(401);
    const invalid = await patch(kind, key, 1, 'INACTIVE', tokenA + 'bad');
    expect(invalid.status).toBe(401);
    await revoke(a, permission[kind]);
    const forbidden = await patch(kind, key, 1, 'INACTIVE');
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe('PERMISSION_DENIED');
    expect((await saved(a, kind, key))?.version).toBe(1);
    expect(await effects(a)).toEqual({ audits: 0, outbox: 0, journal: 0, stock: 0, cash: 0 });
  });

  it.each(kinds)('PATCH %s refuses unsafe versions, bad IDs, extra body keys and invalid states', async kind => {
    const key = await master(a, kind);
    for (const value of [0, -1, 1.5, '1', null, 2147483648]) {
      const r = await request(app.getHttpServer()).patch(patchFor(kind, key))
        .set('Authorization', 'Bearer ' + tokenA)
        .send({ expectedVersion: value, desiredState: 'INACTIVE' });
      // A safe JS integer beyond PostgreSQL int4 is invalid client expectedVersion.
      expect(r.status).toBe(400);
    }
    for (const body of [
      { expectedVersion: 1, desiredState: 'PAUSED' },
      { expectedVersion: 1, desiredState: 'INACTIVE', tenantId: b.tenantId },
      { expectedVersion: 1, desiredState: 'INACTIVE', actorId: b.userId },
      { expectedVersion: 1 },
    ]) {
      const r = await request(app.getHttpServer()).patch(patchFor(kind, key))
        .set('Authorization', 'Bearer ' + tokenA).send(body);
      expect(r.status, JSON.stringify(r.body)).toBe(400);
    }
    const badId = await patch(kind, 'not-ulid', 1, 'INACTIVE');
    expect(badId.status).toBe(400);
    expect((await saved(a, kind, key))?.version).toBe(1);
    expect(await effects(a)).toEqual({ audits: 0, outbox: 0, journal: 0, stock: 0, cash: 0 });
  });

  it.each(kinds)('PATCH %s archived and int4 overflow give precise 409, no audit/outbox', async kind => {
    const archived = await master(a, kind, { state: 'ARCHIVED' });
    const over = await master(a, kind, { version: 2147483647 });
    const ar = await patch(kind, archived, 1, 'INACTIVE');
    expect(ar.status).toBe(409);
    expect(ar.body.error.details.reason).toBe('ARCHIVED');
    const ov = await patch(kind, over, 2147483647, 'INACTIVE');
    expect(ov.status).toBe(409);
    expect(ov.body.error.details.reason).toBe('VERSION_OVERFLOW');
    expect(await effects(a)).toEqual({ audits: 0, outbox: 0, journal: 0, stock: 0, cash: 0 });
  });

  it('category rejects active children and inactive parent with accurate 409 reasons', async () => {
    const parent = await master(a, 'category', { name: 'Root' });
    const child = await master(a, 'category', { name: 'Child', parentId: parent });
    const p1 = await patch('category', parent, 1, 'INACTIVE');
    expect(p1.status).toBe(409);
    expect(p1.body.error.details.reason).toBe('ACTIVE_CHILDREN');
    expect((await patch('category', child, 1, 'INACTIVE')).status).toBe(200);
    expect((await patch('category', parent, 1, 'INACTIVE')).status).toBe(200);
    const p2 = await patch('category', child, 2, 'ACTIVE');
    expect(p2.status).toBe(409);
    expect(p2.body.error.details.reason).toBe('PARENT_NOT_ACTIVE');
    expect(await effects(a)).toEqual({ audits: 2, outbox: 2, journal: 0, stock: 0, cash: 0 });
  });

  it.each(kinds)('PATCH %s simultaneous same-version requests accept one winner and one 409', async kind => {
    const key = await master(a, kind);
    const [x, y] = await Promise.all([
      patch(kind, key, 1, 'INACTIVE'),
      patch(kind, key, 1, 'INACTIVE'),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    expect((await saved(a, kind, key))?.version).toBe(2);
    expect(await effects(a)).toEqual({ audits: 1, outbox: 1, journal: 0, stock: 0, cash: 0 });
  });

  it('legacy, metadata and usage GET routes stay mounted and unmodified', async () => {
    await master(a, 'unit', { name: 'Gauge' });
    for (const path of ['/api/v1/catalog', '/api/v1/catalog/metadata-v1',
      '/api/v1/catalog/settings-usage-v1']) {
      const r = await request(app.getHttpServer()).get(path)
        .set('Authorization', 'Bearer ' + tokenA);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
  });
});
