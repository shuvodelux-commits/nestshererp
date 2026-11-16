/**
 * MOD-004 SEC-N02D (#316) — signed non-owner PG16/RLS acceptance for the
 * exact selected-role, name/phone-only V2 Party PATCH.
 * @covers endpoint:PATCH /api/v2/parties/:id
 */
import 'reflect-metadata';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Permission, SettingKey } from '@sher/core-contracts';
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
const grants = [
  Permission.CUSTOMER_CREATE, Permission.CUSTOMER_EDIT, Permission.CUSTOMER_VIEW,
  Permission.SUPPLIER_CREATE, Permission.SUPPLIER_EDIT, Permission.SUPPLIER_VIEW,
  Permission.VENDOR_CREATE, Permission.VENDOR_EDIT,
  Permission.PARTY_PROFILE_VIEW, Permission.PARTY_HISTORY_GLOBAL_VIEW,
  Permission.SETTING_VIEW, Permission.SETTING_EDIT, Permission.SETTING_TOGGLE,
];
const newId = () => Ulid.generate(clock);
let app: INestApplication;
let pool: pg.Pool;
let tenant: SeededTenant;
let token: string;
const auth = (jwt = token) => ({ Authorization: 'Bearer ' + jwt });
const body = (version = 1, selectedRole = 'CUSTOMER') => ({
  selectedRole, version, name: 'দোকান নতুন নাম', phone: '01712345678',
});
const record = (roles: string[] = ['CUSTOMER'], name = 'Original Party', phone = '01712345678') => ({
  selectedRole: roles[0], name, roles, phone,
  address: null, guardianName: null, nid: null, email: null, notes: null,
  customerGroupId: null, creditLimitMinor: null,
});
const create = (input: object = record(), jwt = token) =>
  request(app.getHttpServer()).post('/api/v2/parties')
    .set(auth(jwt)).set('Idempotency-Key', newId()).send(input);
const patch = (id: string, input: object = body(), jwt = token) =>
  request(app.getHttpServer()).patch('/api/v2/parties/' + id)
    .set(auth(jwt)).send(input);
async function restrict(codes: readonly string[], who = tenant): Promise<void> {
  await asTenant(pool, who.tenantId, async (client) => {
    await client.query('DELETE FROM role_permissions WHERE tenant_id=$1 AND role_id=$2',
      [who.tenantId, who.roleId]);
    for (const code of codes) {
      await client.query(
        'INSERT INTO role_permissions (id,tenant_id,role_id,permission_code,created_at,updated_at,created_by,updated_by,version) VALUES ($1,$2,$3,$4,$5,$5,$6,$6,1)',
        [newId(), who.tenantId, who.roleId, code, clock.now(), who.userId],
      );
    }
  });
}
async function counts(who = tenant) {
  return asTenant(pool, who.tenantId, async (client) => {
    const count = async (table: string, filter = ''): Promise<number> => {
      const result = await client.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM ' + table + ' WHERE tenant_id=$1' + filter, [who.tenantId],
      );
      return result.rows[0]!.n;
    };
    return {
      updated: await count('audit_events', " AND entity_type='party' AND action='UPDATE'"),
      outbox: await count('outbox', " AND event_type='party.updated'"),
      journals: await count('journal_entries'),
      journalLines: await count('journal_lines'),
      stockMovements: await count('stock_movements'),
      openings: await count('party_openings'),
      cash: await count('cash_movements'),
    };
  });
}
async function stored(id: string, who = tenant) {
  return asTenant(pool, who.tenantId, async (client) => {
    const row = await client.query<{
      name: string; phone: string | null; nid: string | null;
      address: string | null; guardian_name: string | null; email: string | null;
      notes: string | null; customer_group_id: string | null;
      credit_limit_minor: string | null; version: number;
    }>(
      'SELECT name, phone, nid, address, guardian_name, email, notes, customer_group_id, credit_limit_minor, version FROM parties WHERE tenant_id=$1 AND id=$2',
      [who.tenantId, id],
    );
    const roles = await client.query<{ role: string }>(
      'SELECT role FROM party_roles WHERE tenant_id=$1 AND party_id=$2 ORDER BY role',
      [who.tenantId, id],
    );
    return { row: row.rows[0], roles: roles.rows.map(r => r.role) };
  });
}
function checkReceipt(value: unknown, selectedRole: string, version: number): string {
  expect(value).toBeTruthy();
  const received = value as { data: Record<string, unknown> };
  expect(Object.keys(received)).toEqual(['data']);
  expect(Object.keys(received.data).sort()).toEqual(['id', 'selectedRole', 'status', 'version']);
  expect(received.data.selectedRole).toBe(selectedRole);
  expect(received.data.version).toBe(version);
  expect(received.data.status).toBe('ACTIVE');
  expect(typeof received.data.id).toBe('string');
  expect(String(received.data.id)).toHaveLength(26);
  return received.data.id as string;
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
  tenant = await seedTenant(pool, { name: 'V2 Party PATCH Tenant A', permissions: grants });
  token = signToken(tenant, TEST_JWT_SECRET);
});

describe('MOD-004 SEC-N02D signed V2 Party name/phone PATCH', () => {
  it('edits with selected Customer EDIT only, no VIEW/PROFILE/HISTORY, and returns a safe receipt', async () => {
    const created = await create().expect(201);
    const id = created.body.data.id as string;
    const before = await counts();
    await restrict([Permission.CUSTOMER_EDIT]);
    const updated = await patch(id).expect(200);
    expect(checkReceipt(updated.body, 'CUSTOMER', 2)).toBe(id);
    expect(JSON.stringify(updated.body)).not.toContain('দোকান');
    expect(JSON.stringify(updated.body)).not.toContain('balance');
    await request(app.getHttpServer()).get('/api/v2/parties/' + id + '?role=CUSTOMER')
      .set(auth()).expect(403);
    const after = await counts();
    expect(after).toEqual({
      ...before, updated: before.updated + 1, outbox: before.outbox + 1,
    });
    expect((await stored(id)).row?.name).toBe('দোকান নতুন নাম');
  });


  it('changes a Customer phone with EDIT only, persisting normalized directory fields once', async () => {
    const created = await create(record(['CUSTOMER'], 'Customer Before', '01711111111')).expect(201);
    const id = created.body.data.id as string;
    const before = await counts();
    await restrict([Permission.CUSTOMER_EDIT]);
    const updated = await patch(id, {
      ...body(), name: '  গ্রাহকের নতুন নাম  ', phone: ' 01788888888 ',
    }).expect(200);
    expect(checkReceipt(updated.body, 'CUSTOMER', 2)).toBe(id);
    const actual = await stored(id);
    expect(actual.row?.name).toBe('গ্রাহকের নতুন নাম');
    expect(actual.row?.phone).toBe('01788888888');
    expect(actual.row?.version).toBe(2);
    expect(await counts()).toEqual({
      ...before, updated: before.updated + 1, outbox: before.outbox + 1,
    });
  });

  it('allows Supplier-only EDIT to clear an optional phone without profile or Customer grants', async () => {
    const created = await create(record(['SUPPLIER'], 'Supplier Before', '01799999999')).expect(201);
    const id = created.body.data.id as string;
    const before = await counts();
    await restrict([Permission.SUPPLIER_EDIT]);
    const updated = await patch(id, {
      ...body(), selectedRole: 'SUPPLIER', name: 'Supplier After', phone: null,
    }).expect(200);
    expect(checkReceipt(updated.body, 'SUPPLIER', 2)).toBe(id);
    const actual = await stored(id);
    expect(actual.row?.phone).toBeNull();
    expect(actual.row?.name).toBe('Supplier After');
    expect(actual.roles).toEqual(['SUPPLIER']);
    expect(await counts()).toEqual({
      ...before, updated: before.updated + 1, outbox: before.outbox + 1,
    });
  });

  it('Supplier-only EDIT on Customer+Supplier shared identity preserves both roles and private/credit fields', async () => {
    await request(app.getHttpServer()).post('/api/v1/settings/value')
      .set(auth()).send({ key: SettingKey.CUSTOMER_FIELD_NID_VISIBLE, value: 'on' }).expect(201);
    await request(app.getHttpServer()).post('/api/v1/settings/value')
      .set(auth()).send({ key: SettingKey.CUSTOMER_GROUPS_ENABLED, value: 'on' }).expect(201);
    const groupId = newId();
    await asTenant(pool, tenant.tenantId, async client => {
      await client.query(
        'INSERT INTO customer_groups (id,tenant_id,name,created_at,updated_at,created_by,updated_by,version) VALUES ($1,$2,$3,$4,$4,$5,$5,1)',
        [groupId, tenant.tenantId, 'Private Group', clock.now(), tenant.userId],
      );
    });
    const created = await create({
      ...record(['CUSTOMER', 'SUPPLIER']), nid: 'NID-V2-PROTECTED',
      customerGroupId: groupId, creditLimitMinor: 123456,
    }).expect(201);
    const id = created.body.data.id as string;
    // Direct SQL only constructs a disposable private fixture, not the action under test.
    await asTenant(pool, tenant.tenantId, async client => {
      await client.query(
        'UPDATE parties SET address=$1,guardian_name=$2,email=$3,notes=$4 WHERE tenant_id=$5 AND id=$6',
        ['Private Address', 'Private Guardian', 'private@example.test',
          'Private Notes', tenant.tenantId, id],
      );
    });
    await restrict([Permission.SUPPLIER_EDIT]);
    const before = await counts();
    const edited = await patch(id, { ...body(), selectedRole: 'SUPPLIER',
      name: 'Supplier renamed shared directory' }).expect(200);
    checkReceipt(edited.body, 'SUPPLIER', 2);
    expect(JSON.stringify(edited.body)).not.toContain('NID-V2-PROTECTED');
    expect(JSON.stringify(edited.body)).not.toContain('123456');
    const actual = await stored(id);
    expect(actual.roles).toEqual(['CUSTOMER', 'SUPPLIER']);
    expect(actual.row?.nid).toBe('NID-V2-PROTECTED');
    expect(actual.row?.address).toBe('Private Address');
    expect(actual.row?.guardian_name).toBe('Private Guardian');
    expect(actual.row?.email).toBe('private@example.test');
    expect(actual.row?.notes).toBe('Private Notes');
    expect(actual.row?.customer_group_id).toBe(groupId);
    expect(Number(actual.row?.credit_limit_minor)).toBe(123456);
    expect(actual.row?.name).toBe('Supplier renamed shared directory');
    expect(await counts()).toEqual({ ...before, updated: before.updated + 1, outbox: before.outbox + 1 });
  });

  it('refuses selectedRole EDIT without permission before knowing whether ID exists', async () => {
    const created = await create().expect(201);
    const before = await counts();
    await restrict([]);
    const seen = await patch(created.body.data.id).expect(403);
    const missing = await patch(newId()).expect(403);
    expect(seen.body.error.code).toBe('PERMISSION_DENIED');
    expect(missing.body.error.code).toBe('PERMISSION_DENIED');
    expect(missing.body.error.message).toBe(seen.body.error.message);
    expect(await counts()).toEqual(before);
  });

  it('conceals missing selected membership, unknown id and another tenant under the same NOT_FOUND response', async () => {
    const supplier = await create(record(['SUPPLIER'], 'Supplier only')).expect(201);
    const other = await seedTenant(pool, {
      name: 'V2 Party PATCH Tenant B', permissions: [Permission.CUSTOMER_EDIT],
    });
    const before = await counts();
    await restrict([Permission.CUSTOMER_EDIT]);
    const hidden = await patch(supplier.body.data.id).expect(404);
    const unknown = await patch(newId()).expect(404);
    const foreign = await patch(supplier.body.data.id, body(), signToken(other, TEST_JWT_SECRET))
      .expect(404);
    for (const failure of [unknown, foreign]) {
      expect(failure.body.error.code).toBe(hidden.body.error.code);
      expect(failure.body.error.message).toBe(hidden.body.error.message);
      expect(failure.body.error.details).toEqual(hidden.body.error.details);
    }
    expect(await counts()).toEqual(before);
    expect(await counts(other)).toEqual({
      updated: 0, outbox: 0, journals: 0, journalLines: 0,
      stockMovements: 0, openings: 0, cash: 0,
    });
  });

  it('denies Vendor selectedRole edit when Vendor Management is off before accessing Party data', async () => {
    await restrict([Permission.VENDOR_EDIT]);
    const before = await counts();
    const denied = await patch(newId(), { ...body(), selectedRole: 'VENDOR' }).expect(403);
    expect(denied.body.error.code).toBe('FEATURE_DISABLED');
    expect(await counts()).toEqual(before);
  });

  it('rejects the system-reserved walk-in Party without changing its version', async () => {
    const reservedId = await seedWalkInCustomer(pool, tenant);
    const before = await counts();
    const denied = await patch(reservedId, { ...body(), phone: null }).expect(400);
    expect(denied.body.error.code).toBe('VALIDATION_FAILED');
    expect(await counts()).toEqual(before);
    expect((await stored(reservedId)).row?.version).toBe(1);
  });

  it('rejects stale version with zero duplicate audit/outbox and preserves winning name', async () => {
    const created = await create().expect(201);
    const id = created.body.data.id as string;
    const before = await counts();
    await patch(id).expect(200);
    const updated = await counts();
    expect(updated.updated).toBe(before.updated + 1);
    const stale = await patch(id, { ...body(), name: 'Stale overwrite' }).expect(409);
    expect(stale.body.error.code).toBe('CONFLICT_STALE_VERSION');
    expect((await stored(id)).row?.name).toBe('দোকান নতুন নাম');
    expect(await counts()).toEqual(updated);
  });

  it('performs concurrent competing edits using optimistic compare-and-swap', async () => {
    const created = await create().expect(201);
    const id = created.body.data.id as string;
    const before = await counts();
    const [a, b] = await Promise.all([
      patch(id, { ...body(), name: 'First competing edit' }),
      patch(id, { ...body(), name: 'Second competing edit' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const succeeded = a.status === 200 ? a : b;
    checkReceipt(succeeded.body, 'CUSTOMER', 2);
    const after = await counts();
    expect(after).toEqual({ ...before, updated: before.updated + 1, outbox: before.outbox + 1 });
    const winnerName = a.status === 200 ? 'First competing edit' : 'Second competing edit';
    expect((await stored(id)).row?.name).toBe(winnerName);
    expect((await stored(id)).row?.version).toBe(2);
  });

  it('rejects duplicate Customer phone without disclosing the other Party ID', async () => {
    const a = await create(record(['CUSTOMER'], 'First', '01711111111')).expect(201);
    const b = await create(record(['CUSTOMER'], 'Second', '01722222222')).expect(201);
    const before = await counts();
    // A write-only cashier may detect the conflict but may not learn its owner's ID or phone.
    await restrict([Permission.CUSTOMER_EDIT]);
    const denied = await patch(b.body.data.id, {
      ...body(), name: 'Invalid duplicate', phone: '01711111111',
    }).expect(400);
    expect(denied.body.error.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(denied.body)).not.toContain(a.body.data.id as string);
    expect(JSON.stringify(denied.body)).not.toContain('01711111111');
    expect(denied.body.error.details).not.toHaveProperty('partyId');
    expect((await stored(b.body.data.id)).row?.phone).toBe('01722222222');
    expect(await counts()).toEqual(before);
  });

  it('rejects non-directory fields, invalid selected role and malformed optimistic versions', async () => {
    const created = await create().expect(201);
    const id = created.body.data.id as string;
    const before = await counts();
    for (const invalid of [
      { ...body(), nid: 'private' },
      { ...body(), roles: ['CUSTOMER', 'SUPPLIER'] },
      { ...body(), opening: null },
      { ...body(), customerGroupId: null },
      { ...body(), creditLimitMinor: 200 },
      { ...body(), balance: {} },
      { ...body(), status: 'INACTIVE' },
      { ...body(), tenantId: tenant.tenantId },
      { ...body(), selectedRole: 'OWNER' },
      { ...body(), selectedRole: 'All' },
      { ...body(), version: 0 },
      { ...body(), version: 1.2 },
      { ...body(), version: Number.MAX_SAFE_INTEGER + 1 },
      { ...body(), name: '   ' },
    ]) {
      await patch(id, invalid).expect(400);
    }
    await patch('bad-id').expect(400);
    expect(await counts()).toEqual(before);
    expect((await stored(id)).row?.version).toBe(1);
  });

  it('requires signed authentication and never creates a Party from PATCH', async () => {
    const before = await counts();
    await request(app.getHttpServer()).patch('/api/v2/parties/' + newId())
      .send(body()).expect(401);
    await patch(newId()).expect(404);
    expect(await counts()).toEqual(before);
  });
});
