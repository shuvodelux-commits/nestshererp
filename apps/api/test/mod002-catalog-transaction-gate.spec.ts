/*
 * MOD-002 transactional and RLS gate: real disposable sher_test PostgreSQL16.
 * Existing signed JWT, UoW, audit, outbox and FORCE-RLS infrastructure only.
 *
 * @covers endpoint:POST /api/v1/catalog/metadata-v1/units
 * @covers endpoint:POST /api/v1/catalog/metadata-v1/brands
 * @covers endpoint:POST /api/v1/catalog/metadata-v1/categories
 * @covers endpoint:PATCH /api/v1/catalog/metadata-v1/units/:id
 * @covers endpoint:PATCH /api/v1/catalog/metadata-v1/brands/:id
 * @covers endpoint:PATCH /api/v1/catalog/metadata-v1/categories/:id
 */
import 'reflect-metadata';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Permission } from '@sher/core-contracts';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { AppErrorFilter } from '../src/common/app-error.filter';
import { OUTBOX } from '../src/infrastructure/tokens';
import { signToken, TEST_JWT_SECRET } from './support/auth';
import type { SeededTenant } from './support/database';
import { asTenant, prepareTestDatabase, resetDatabase, seedTenant, testPool } from './support/database';

type Kind = 'units' | 'brands' | 'categories';
const types: Record<Kind, string> = { units: 'unit', brands: 'brand', categories: 'category' };
const manages: Record<Kind, Permission> = {
  units: Permission.UNIT_MANAGE,
  brands: Permission.BRAND_MANAGE,
  categories: Permission.CATEGORY_MANAGE,
};
const rights = [Permission.PRODUCT_VIEW, ...Object.values(manages)];
const command: Record<Kind, Record<string, unknown>> = {
  units: { name: 'Gauge', nameBn: 'গেজ', symbol: 'Gg' },
  brands: { name: 'Vision', nameBn: 'ভিশন' },
  categories: { name: 'Electrical', nameBn: 'বিদ্যুৎ', parentId: null },
};
const rowName: Record<Kind, string> = { units: 'Gauge', brands: 'Vision', categories: 'Electrical' };
const table: Record<Kind, string> = { units: 'units', brands: 'brands', categories: 'categories' };

let app: INestApplication;
let pool: pg.Pool;
let a: SeededTenant;
let b: SeededTenant;
let tokenA: string;
let tokenB: string;

function create(kind: Kind, token = tokenA, server = app, body: unknown = command[kind]): request.Test {
  return request(server.getHttpServer())
    .post(`/api/v1/catalog/metadata-v1/${kind}`)
    .set('Authorization', `Bearer ${token}`)
    .send(body as object);
}
function patch(kind: Kind, id: string, body: unknown, token = tokenA): request.Test {
  return request(app.getHttpServer())
    .patch(`/api/v1/catalog/metadata-v1/${kind}/${id}`)
    .set('Authorization', `Bearer ${token}`)
    .send(body as object);
}
function getId(result: request.Response, kind: Kind): string {
  const found = (result.body.data[kind] as Array<{ id: string; name: string }>)
    .find(row => row.name === rowName[kind]);
  if (!found) throw new Error(`No ${kind} row in response`);
  return found.id;
}
async function auditAndOutbox(tenant: SeededTenant, kind: Kind, id: string) {
  return asTenant(pool, tenant.tenantId, async (client) => {
    const audit = await client.query<{ action: string; before_json: unknown; after_json: unknown }>(
      'SELECT action, before_json, after_json FROM audit_events WHERE entity_type = $1 AND entity_id = $2 ORDER BY created_at, id',
      [types[kind], id],
    );
    const outbox = await client.query<{ event_type: string; payload: Record<string, unknown> }>(
      'SELECT event_type, payload FROM outbox WHERE aggregate_type = $1 AND aggregate_id = $2 ORDER BY created_at, id',
      [types[kind], id],
    );
    return { audits: audit.rows, events: outbox.rows };
  });
}
async function deletePermission(tenant: SeededTenant, perm: Permission): Promise<void> {
  await asTenant(pool, tenant.tenantId, client =>
    client.query(
      'DELETE FROM role_permissions WHERE tenant_id = $1 AND role_id = $2 AND permission_code = $3',
      [tenant.tenantId, tenant.roleId, perm],
    ).then(() => undefined),
  );
}
async function countTable(tenant: SeededTenant, kind: Kind): Promise<number> {
  return asTenant(pool, tenant.tenantId, async client => {
    const res = await client.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM ${table[kind]}`,
    );
    return res.rows[0]?.count ?? -1;
  });
}

beforeAll(async () => {
  pool = testPool();
  await prepareTestDatabase();
  const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = module.createNestApplication();
  app.useGlobalFilters(new AppErrorFilter());
  await app.init();
});
afterAll(async () => {
  await app.close();
  await pool.end();
});
beforeEach(async () => {
  await resetDatabase(pool);
  a = await seedTenant(pool, { name: 'A Store', permissions: rights });
  b = await seedTenant(pool, { name: 'B Store', permissions: rights });
  tokenA = signToken(a, TEST_JWT_SECRET);
  tokenB = signToken(b, TEST_JWT_SECRET);
});

describe('MOD-002 transaction, permission and isolation gate', () => {
  it('honors live post-issuance permission revocation for ALL three create kinds', async () => {
    for (const kind of ['units', 'brands', 'categories'] as const) {
      const fresh = await seedTenant(pool, {
        name: `Denied ${kind}`, permissions: rights,
      });
      const token = signToken(fresh, TEST_JWT_SECRET);
      await deletePermission(fresh, manages[kind]);
      const response = await create(kind, token);
      expect(response.status, kind).toBe(403);
      expect(response.body.error.code).toBe('PERMISSION_DENIED');
      expect(await countTable(fresh, kind)).toBe(0);
    }
  });

  it('separates Product VIEW from per-kind manage rights, including GET revocation', async () => {
    await deletePermission(a, Permission.PRODUCT_VIEW);
    const denied = await request(app.getHttpServer())
      .get('/api/v1/catalog/metadata-v1').set('Authorization', `Bearer ${tokenA}`);
    expect(denied.status).toBe(403);
    const created = await create('brands');
    // A caller granted BRAND_MANAGE does not need PRODUCT_VIEW to save a brand.
    expect(created.status).toBe(201);
    expect(await countTable(a, 'brands')).toBe(1);
  });

  it('rejects all foreign tenant IDs on versioned PATCH with no effects', async () => {
    for (const kind of ['units', 'brands', 'categories'] as const) {
      const created = await create(kind, tokenB);
      expect(created.status).toBe(201);
      const id = getId(created, kind);
      const denial = await patch(kind, id, { expectedVersion: 1, nameBn: 'অন্য দোকান' });
      expect(denial.status).toBe(404);
      expect(denial.body.error.code).toBe('NOT_FOUND');
      const effects = await auditAndOutbox(b, kind, id);
      expect(effects.audits.map(row => row.action)).toEqual(['CREATE']);
      expect(effects.events.map(row => row.event_type)).toEqual([`${types[kind]}.created`]);
      const hidden = await asTenant(pool, a.tenantId, client =>
        client.query(`SELECT id FROM ${table[kind]} WHERE id = $1`, [id]));
      expect(hidden.rows).toEqual([]);
    }
  });

  it('audits one atomic CREATE and one UPDATE with consistent metadata payloads', async () => {
    for (const kind of ['units', 'brands', 'categories'] as const) {
      const created = await create(kind);
      expect(created.status).toBe(201);
      const id = getId(created, kind);
      const first = await auditAndOutbox(a, kind, id);
      expect(first.audits).toHaveLength(1);
      expect(first.audits[0]).toMatchObject({ action: 'CREATE', before_json: null });
      expect(first.audits[0]?.after_json).toMatchObject({ name: rowName[kind], nameBn: command[kind].nameBn });
      expect(first.events).toHaveLength(1);
      expect(first.events[0]).toMatchObject({
        event_type: `${types[kind]}.created`,
        payload: expect.objectContaining({ name: rowName[kind], nameBn: command[kind].nameBn }),
      });

      const update = await patch(kind, id, { expectedVersion: 1, nameBn: 'পরিবর্তন' });
      expect(update.status).toBe(200);
      const after = await auditAndOutbox(a, kind, id);
      expect(after.audits.map(row => row.action)).toEqual(['CREATE', 'UPDATE']);
      expect(after.audits[1]?.before_json).toMatchObject({ nameBn: command[kind].nameBn });
      expect(after.audits[1]?.after_json).toMatchObject({ nameBn: 'পরিবর্তন' });
      expect(after.events.map(row => row.event_type)).toEqual([
        `${types[kind]}.created`, `${types[kind]}.updated`,
      ]);
      expect(after.events[1]?.payload).toMatchObject({ nameBn: 'পরিবর্তন', version: 2 });
    }
  });

  it('sends exactly one 409 for stale CAS and preserves the winning metadata', async () => {
    const creation = await create('units');
    const id = getId(creation, 'units');
    // Both writers read version=1 before attempting the same row update.
    const responses = await Promise.all([
      patch('units', id, { expectedVersion: 1, nameBn: 'প্রথম' }),
      patch('units', id, { expectedVersion: 1, nameBn: 'দ্বিতীয়' }),
    ]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
    const winning = responses.find(r => r.status === 200);
    expect(winning?.body.data.units[0].version).toBe(2);
    const failed = responses.find(r => r.status === 409);
    expect(failed?.body.error.code).toBe('CONFLICT_STALE_VERSION');
    const effects = await auditAndOutbox(a, 'units', id);
    expect(effects.audits.map(r => r.action)).toEqual(['CREATE', 'UPDATE']);
    expect(effects.events.map(r => r.event_type)).toEqual(['unit.created', 'unit.updated']);
  });

  it('rolls back a failed OUTBOX write for EACH catalog kind, not just units', async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(OUTBOX)
      .useValue({
        append: async (): Promise<void> => { throw new Error('MOD-002 synthetic outbox failure'); },
      })
      .compile();
    const failed = module.createNestApplication();
    failed.useGlobalFilters(new AppErrorFilter());
    await failed.init();
    try {
      for (const kind of ['units', 'brands', 'categories'] as const) {
        const result = await create(kind, tokenA, failed);
        expect(result.status, kind).toBe(500);
        expect(result.body.error.code).toBe('INTERNAL_ERROR');
        expect(await countTable(a, kind)).toBe(0);
      }
      const effects = await asTenant(pool, a.tenantId, async client => {
        const audit = await client.query<{ count: number }>(
          "SELECT count(*)::integer AS count FROM audit_events WHERE action = 'CREATE' AND entity_type IN ('unit','brand','category')",
        );
        const outbox = await client.query<{ count: number }>(
          "SELECT count(*)::integer AS count FROM outbox WHERE aggregate_type IN ('unit','brand','category')",
        );
        return { audit: audit.rows[0]?.count, outbox: outbox.rows[0]?.count };
      });
      expect(effects).toEqual({ audit: 0, outbox: 0 });
    } finally {
      await failed.close();
    }
  });

  it('concurrent duplicate CREATE has one persisted record and no uncaught HTTP 500', async () => {
    const attempts = await Promise.all([create('brands'), create('brands')]);
    const statuses = attempts.map(result => result.status).sort();
    expect(statuses).toEqual([201, 400]);
    expect(await countTable(a, 'brands')).toBe(1);
    const succeeded = attempts.find(r => r.status === 201);
    const id = getId(succeeded as request.Response, 'brands');
    const effects = await auditAndOutbox(a, 'brands', id);
    expect(effects.audits.map(r => r.action)).toEqual(['CREATE']);
    expect(effects.events.map(r => r.event_type)).toEqual(['brand.created']);
  });
});
