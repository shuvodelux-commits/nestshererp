/**
 * MOD-004 SEC-N02E (#332) — signed, non-owner PostgreSQL16/RLS status acceptance.
 * Test-first contract: identity-wide V2 status with all-affected-role grants,
 * atomic optimistic version, privacy-minimal receipt and stable same-state no-op.
 * @covers endpoint:POST /api/v2/parties/:id/status
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
import type { SeededTenant } from './support/database';
import { asTenant, prepareTestDatabase, resetDatabase, seedTenant, seedWalkInCustomer, testPool } from './support/database';

const clock = new SystemClock();
const newId = () => Ulid.generate(clock);
const ownerGrants = [
  Permission.CUSTOMER_CREATE, Permission.CUSTOMER_VIEW, Permission.CUSTOMER_EDIT,
  Permission.CUSTOMER_DEACTIVATE,
  Permission.SUPPLIER_CREATE, Permission.SUPPLIER_VIEW, Permission.SUPPLIER_DEACTIVATE,
  Permission.VENDOR_CREATE, Permission.VENDOR_VIEW, Permission.VENDOR_DEACTIVATE,
  Permission.PARTY_PROFILE_VIEW, Permission.PARTY_HISTORY_GLOBAL_VIEW,
];
let app: INestApplication;
let pool: pg.Pool;
let tenant: SeededTenant;
let token: string;
const auth = (jwt = token) => ({ Authorization: 'Bearer ' + jwt });
const record = (roles: string[] = ['CUSTOMER']) => ({
  selectedRole: roles[0], name: 'Private Shared Party', roles,
  phone: '01712345678', address: null, guardianName: null, nid: null,
  email: null, notes: null, customerGroupId: null, creditLimitMinor: null,
});
const create = (roles: string[] = ['CUSTOMER']) =>
  request(app.getHttpServer()).post('/api/v2/parties')
    .set(auth()).set('Idempotency-Key', newId()).send(record(roles));
const status = (partyId: string, body: object = {
  selectedRole: 'CUSTOMER', version: 1, status: 'INACTIVE',
}, jwt = token) => request(app.getHttpServer())
  .post('/api/v2/parties/' + partyId + '/status').set(auth(jwt)).send(body);
async function restrict(codes: readonly string[]): Promise<void> {
  await asTenant(pool, tenant.tenantId, async client => {
    await client.query('DELETE FROM role_permissions WHERE tenant_id=$1 AND role_id=$2',
      [tenant.tenantId, tenant.roleId]);
    for (const code of codes) {
      await client.query(
        'INSERT INTO role_permissions (id,tenant_id,role_id,permission_code,created_at,updated_at,created_by,updated_by,version) VALUES ($1,$2,$3,$4,$5,$5,$6,$6,1)',
        [newId(), tenant.tenantId, tenant.roleId, code, clock.now(), tenant.userId],
      );
    }
  });
}
async function read(partyId: string, who = tenant) {
  return asTenant(pool, who.tenantId, async client => {
    const q = await client.query<{ status: string; version: number }>(
      'SELECT status,version FROM parties WHERE tenant_id=$1 AND id=$2',
      [who.tenantId, partyId],
    );
    return q.rows[0] ?? null;
  });
}
async function counts(who = tenant) {
  return asTenant(pool, who.tenantId, async client => {
    const count = async (table: string, suffix = ''): Promise<number> => {
      const r = await client.query<{n: number}>(
        'SELECT count(*)::int AS n FROM ' + table + ' WHERE tenant_id=$1' + suffix,
        [who.tenantId],
      );
      return r.rows[0]!.n;
    };
    return {
      audit: await count('audit_events', " AND entity_type='party' AND action IN ('ACTIVATE','DEACTIVATE')"),
      outbox: await count('outbox', " AND event_type='party.status_changed'"),
      journals: await count('journal_entries'),
      journalLines: await count('journal_lines'),
      stock: await count('stock_movements'),
      cash: await count('cash_movements'),
    };
  });
}
function receipt(body: unknown, id: string, role: string, version: number, state: string): void {
  expect(body).toEqual({ data: { id, version, selectedRole: role, status: state } });
  expect(JSON.stringify(body)).not.toContain('Private Shared Party');
  expect(JSON.stringify(body)).not.toContain('hasLedgerEntries');
  expect(JSON.stringify(body)).not.toContain('balance');
  expect(JSON.stringify(body)).not.toContain('roles');
  expect(JSON.stringify(body)).not.toContain('profile');
}

beforeAll(async () => {
  pool = testPool();
  await prepareTestDatabase();
  const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = module.createNestApplication();
  app.useGlobalFilters(new AppErrorFilter());
  await app.init();
}, 90_000);
afterAll(async () => { if (app) await app.close(); if (pool) await pool.end(); });
beforeEach(async () => {
  await resetDatabase(pool);
  tenant = await seedTenant(pool, { name: 'SEC-N02E Tenant A', permissions: ownerGrants });
  token = signToken(tenant, TEST_JWT_SECRET);
});

describe('MOD-004 SEC-N02E V2 identity-wide Party status', () => {
  it('allows Customer-only DEACTIVATE without private/history or VIEW; versioned receipt and one event', async () => {
    const created = await create().expect(201);
    const id = created.body.data.id as string;
    const before = await counts();
    await restrict([Permission.CUSTOMER_DEACTIVATE]);
    const off = await status(id).expect(200);
    receipt(off.body, id, 'CUSTOMER', 2, 'INACTIVE');
    expect(await read(id)).toEqual({ status: 'INACTIVE', version: 2 });
    expect(await counts()).toEqual({ ...before, audit: before.audit + 1, outbox: before.outbox + 1 });
    await request(app.getHttpServer()).get('/api/v2/parties/' + id + '?role=CUSTOMER')
      .set(auth()).expect(403);
    const on = await status(id, { selectedRole: 'CUSTOMER', version: 2, status: 'ACTIVE' }).expect(200);
    receipt(on.body, id, 'CUSTOMER', 3, 'ACTIVE');
    expect(await counts()).toEqual({ ...before, audit: before.audit + 2, outbox: before.outbox + 2 });
  });

  it('same-state status is a stable no-op; stale version is 409 even when state matches', async () => {
    const created = await create().expect(201);
    const id = created.body.data.id as string;
    await restrict([Permission.CUSTOMER_DEACTIVATE]);
    const before = await counts();
    const same = await status(id, { selectedRole: 'CUSTOMER', version: 1, status: 'ACTIVE' }).expect(200);
    receipt(same.body, id, 'CUSTOMER', 1, 'ACTIVE');
    expect(await counts()).toEqual(before);
    await status(id).expect(200);
    const after = await counts();
    await status(id, { selectedRole: 'CUSTOMER', version: 1, status: 'INACTIVE' }).expect(409);
    expect(await read(id)).toEqual({ status: 'INACTIVE', version: 2 });
    expect(await counts()).toEqual(after);
    const repeated = await status(id, { selectedRole: 'CUSTOMER', version: 2, status: 'INACTIVE' }).expect(200);
    receipt(repeated.body, id, 'CUSTOMER', 2, 'INACTIVE');
    expect(await counts()).toEqual(after);
  });

  it('requires all affected role DEACTIVATE grants, never exposing hidden memberships', async () => {
    const created = await create(['CUSTOMER', 'SUPPLIER']).expect(201);
    const id = created.body.data.id as string;
    const before = await counts();
    await restrict([Permission.CUSTOMER_DEACTIVATE]);
    const denied = await status(id).expect(404);
    expect(JSON.stringify(denied.body)).not.toContain('SUPPLIER');
    expect(JSON.stringify(denied.body)).not.toContain('Private Shared Party');
    expect(await read(id)).toEqual({ status: 'ACTIVE', version: 1 });
    expect(await counts()).toEqual(before);
    await restrict([Permission.CUSTOMER_DEACTIVATE, Permission.SUPPLIER_DEACTIVATE]);
    const allowed = await status(id).expect(200);
    receipt(allowed.body, id, 'CUSTOMER', 2, 'INACTIVE');
    expect(await counts()).toEqual({ ...before, audit: before.audit + 1, outbox: before.outbox + 1 });
  });

  it('checks selected permission before lookup and returns identical missing/foreign/unselected-role responses', async () => {
    const created = await create().expect(201);
    const id = created.body.data.id as string;
    const other = await seedTenant(pool, { name: 'SEC-N02E Tenant B', permissions: ownerGrants });
    const otherToken = signToken(other, TEST_JWT_SECRET);
    await restrict([]);
    const before = await counts();
    await status(id).expect(403);
    await status(newId()).expect(403);
    expect(await counts()).toEqual(before);
    await restrict([Permission.SUPPLIER_DEACTIVATE]);
    const ownWrongRole = await status(id, { selectedRole: 'SUPPLIER', version: 1, status: 'INACTIVE' }).expect(404);
    const absent = await status(newId(), { selectedRole: 'SUPPLIER', version: 1, status: 'INACTIVE' }).expect(404);
    expect(ownWrongRole.body).toEqual(absent.body);
    const foreign = await status(id, undefined, otherToken).expect(404);
    expect(foreign.body).toEqual(absent.body);
    expect(await read(id)).toEqual({ status: 'ACTIVE', version: 1 });
    expect(await counts()).toEqual(before);
  });

  it('rejects reserved walk-in identity and Vendor selection while vendor feature is off', async () => {
    const created = await create().expect(201);
    const id = created.body.data.id as string;
    const before = await counts();
    await restrict([Permission.VENDOR_DEACTIVATE, Permission.CUSTOMER_DEACTIVATE]);
    await status(id, { selectedRole: 'VENDOR', version: 1, status: 'INACTIVE' }).expect(403);
    const walkIn = await seedWalkInCustomer(pool, tenant);
    await status(walkIn.id, { selectedRole: 'CUSTOMER', version: 1, status: 'INACTIVE' }).expect(400);
    expect(await counts()).toEqual(before);
  });

  it('exactly one racing writer may change status at a common optimistic version', async () => {
    const created = await create().expect(201);
    const id = created.body.data.id as string;
    await restrict([Permission.CUSTOMER_DEACTIVATE]);
    const before = await counts();
    const [a, b] = await Promise.all([status(id), status(id)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const winner = a.status === 200 ? a : b;
    receipt(winner.body, id, 'CUSTOMER', 2, 'INACTIVE');
    expect(await read(id)).toEqual({ status: 'INACTIVE', version: 2 });
    expect(await counts()).toEqual({ ...before, audit: before.audit + 1, outbox: before.outbox + 1 });
  });

  it('rejects invalid role, body extras, unsafe version and malformed ID without mutation', async () => {
    const created = await create().expect(201);
    const id = created.body.data.id as string;
    const before = await counts();
    const valid = { selectedRole: 'CUSTOMER', version: 1, status: 'INACTIVE' };
    for (const bad of [
      { ...valid, selectedRole: 'LENDER' },
      { ...valid, status: 'SUSPENDED' },
      { ...valid, version: 0 },
      { ...valid, version: Number.MAX_SAFE_INTEGER + 1 },
      { ...valid, roles: ['CUSTOMER'] },
      { ...valid, opening: { amountMinor: 5000 } },
      { ...valid, nid: 'PRIVATE' },
      { ...valid, globalHistory: true },
    ]) {
      await status(id, bad).expect(400);
    }
    await status('not-a-valid-ulid', valid).expect(400);
    await status(id, valid, 'bad-token').expect(401);
    expect(await read(id)).toEqual({ status: 'ACTIVE', version: 1 });
    expect(await counts()).toEqual(before);
  });
});
