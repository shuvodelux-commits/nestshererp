/** MOD-004 T09C-P3A — least-friction Party writes, signed HTTP + real PostgreSQL16/RLS.
 * Use only a new throwaway test DB; not a production or development database.
 * V1 read/write response echoes remain a separate P3C privacy release blocker.
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
import { asTenant, prepareTestDatabase, resetDatabase, seedTenant, testPool } from './support/database';

const clock = new SystemClock();
const FULL = [
  Permission.CUSTOMER_VIEW, Permission.CUSTOMER_CREATE, Permission.CUSTOMER_EDIT,
  Permission.CUSTOMER_DEACTIVATE, Permission.SUPPLIER_VIEW, Permission.SUPPLIER_CREATE,
  Permission.SUPPLIER_EDIT, Permission.SUPPLIER_DEACTIVATE, Permission.SETTING_VIEW,
  Permission.SETTING_EDIT, Permission.SETTING_TOGGLE, Permission.PARTY_PROFILE_VIEW,
  Permission.PARTY_HISTORY_GLOBAL_VIEW,
];
let app: INestApplication;
let pool: pg.Pool;
let tenant: SeededTenant;
let token: string;
const auth = (as = token) => ({ Authorization: 'Bearer ' + as });

const fields = {
  name: 'Dual Role Merchant',
  roles: ['CUSTOMER', 'SUPPLIER'],
  phone: '01712345678',
  address: 'Natore private address',
  guardianName: 'Private guardian',
  nid: 'NID-SECRET',
  email: 'private@example.test',
  notes: 'Private note',
  customerGroupId: null,
  creditLimitMinor: null,
};

async function restrict(codes: readonly string[]): Promise<void> {
  await asTenant(pool, tenant.tenantId, async (client) => {
    await client.query('DELETE FROM role_permissions WHERE tenant_id = $1 AND role_id = $2',
      [tenant.tenantId, tenant.roleId]);
    const now = clock.now();
    for (const code of codes) {
      await client.query(
        'INSERT INTO role_permissions (id, tenant_id, role_id, permission_code, created_at, updated_at, created_by, updated_by, version) VALUES ($1, $2, $3, $4, $5, $5, $6, $6, 1)',
        [Ulid.generate(clock), tenant.tenantId, tenant.roleId, code, now, tenant.userId],
      );
    }
  });
}

async function enableFields(): Promise<void> {
  for (const key of [
    SettingKey.CUSTOMER_FIELD_ADDRESS_VISIBLE, SettingKey.CUSTOMER_FIELD_GUARDIAN_VISIBLE,
    SettingKey.CUSTOMER_FIELD_NID_VISIBLE, SettingKey.CUSTOMER_FIELD_EMAIL_VISIBLE,
    SettingKey.CUSTOMER_FIELD_NOTES_VISIBLE,
  ]) {
    await request(app.getHttpServer()).post('/api/v1/settings/value')
      .set(auth()).send({ key, value: 'on' }).expect(201);
  }
}

async function createParty(roles = ['CUSTOMER', 'SUPPLIER']): Promise<{ id: string; version: number }> {
  await enableFields();
  const created = await request(app.getHttpServer()).post('/api/v1/parties')
    .set(auth()).set('Idempotency-Key', Ulid.generate(clock))
    .send({ ...fields, roles }).expect(201);
  return created.body.data as { id: string; version: number };
}

function edit(id: string, version: number, overrides: Record<string, unknown> = {}): request.Test {
  return request(app.getHttpServer()).patch('/api/v1/parties/' + id)
    .set(auth()).send({ ...fields, ...overrides, version });
}

async function stored(id: string): Promise<{ name: string; phone: string; nid: string; credit_limit_minor: number | null; status: string }> {
  return asTenant(pool, tenant.tenantId, async (client) => {
    const r = await client.query<{name:string;phone:string;nid:string;credit_limit_minor:number|null;status:string}>(
      'SELECT name, phone, nid, credit_limit_minor, status FROM parties WHERE tenant_id = $1 AND id = $2', [tenant.tenantId, id]);
    return r.rows[0]!;
  });
}

async function postSupplierOpening(id: string): Promise<void> {
  await request(app.getHttpServer()).post('/api/v1/parties/' + id + '/opening')
    .set(auth()).set('Idempotency-Key', Ulid.generate(clock))
    .send({ role: 'SUPPLIER', direction: 'PAYABLE', amountMinor: 127_000,
      businessDate: clock.businessDate('Asia/Dhaka') }).expect(201);
}

beforeAll(async () => {
  pool = testPool();
  await prepareTestDatabase();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.useGlobalFilters(new AppErrorFilter());
  await app.init();
});
afterAll(async () => { await app.close(); await pool.end(); });
beforeEach(async () => {
  await resetDatabase(pool);
  tenant = await seedTenant(pool, { name: 'P3A disposable test tenant', permissions: FULL });
  token = signToken(tenant, TEST_JWT_SECRET);
});

describe('MOD-004 P3A — minimal-friction relationship-aware Party writer guards', () => {
  it('permits ordinary name/phone corrections with one role EDIT and unchanged private fields', async () => {
    const p = await createParty();
    await restrict([Permission.CUSTOMER_EDIT]);
    const saved = await edit(p.id, p.version, { name: 'Corrected Merchant', phone: '01722223333' }).expect(200);
    expect(saved.body.data.name).toBe('Corrected Merchant');
    const row = await stored(p.id);
    expect(row.name).toBe('Corrected Merchant');
    expect(row.phone).toBe('01722223333');
    expect(row.nid).toBe('NID-SECRET');
  });

  it('refuses effective changes to private fields without profile VIEW; allows with it', async () => {
    const p = await createParty();
    await restrict([Permission.CUSTOMER_EDIT]);
    const denied = await edit(p.id, p.version, { nid: 'ALTERED-NID' }).expect(403);
    expect(denied.body.error.code).toBe('PERMISSION_DENIED');
    expect((await stored(p.id)).nid).toBe('NID-SECRET');
    await restrict([Permission.CUSTOMER_EDIT, Permission.PARTY_PROFILE_VIEW]);
    await edit(p.id, p.version, { nid: 'ALTERED-NID' }).expect(200);
    expect((await stored(p.id)).nid).toBe('ALTERED-NID');
  });

  it('does not grant Customer-only credit edits to a Supplier-only editor', async () => {
    const p = await createParty();
    await restrict([Permission.SUPPLIER_EDIT]);
    const denied = await edit(p.id, p.version, { creditLimitMinor: 230_000 }).expect(403);
    expect(denied.body.error.code).toBe('PERMISSION_DENIED');
    expect((await stored(p.id)).credit_limit_minor).toBeNull();
    await restrict([Permission.CUSTOMER_EDIT]);
    await edit(p.id, p.version, { creditLimitMinor: 230_000 }).expect(200);
    expect((await stored(p.id)).credit_limit_minor).toBe(230_000);
  });

  it('allows adding a role with its CREATE grant without needing every existing role EDIT', async () => {
    const p = await createParty(['CUSTOMER']);
    await restrict([Permission.CUSTOMER_EDIT, Permission.SUPPLIER_CREATE]);
    const result = await edit(p.id, p.version, { roles: ['CUSTOMER', 'SUPPLIER'] }).expect(200);
    expect(result.body.data.roles).toEqual(['CUSTOMER', 'SUPPLIER']);
  });

  it('requires removal authority for the removed relationship; permits safe unused role removal', async () => {
    const p = await createParty();
    await restrict([Permission.CUSTOMER_EDIT]);
    const denied = await edit(p.id, p.version, { roles: ['CUSTOMER'] }).expect(403);
    expect(denied.body.error.code).toBe('PERMISSION_DENIED');
    await restrict([Permission.CUSTOMER_EDIT, Permission.SUPPLIER_DEACTIVATE]);
    const saved = await edit(p.id, p.version, { roles: ['CUSTOMER'] }).expect(200);
    expect(saved.body.data.roles).toEqual(['CUSTOMER']);
  });

  it('blocks removal of a relationship when the Party has posted source-linked history', async () => {
    const p = await createParty();
    await postSupplierOpening(p.id);
    await restrict([Permission.CUSTOMER_EDIT, Permission.SUPPLIER_DEACTIVATE]);
    const rejected = await edit(p.id, p.version, { roles: ['CUSTOMER'] }).expect(400);
    expect(rejected.body.error.code).toBe('VALIDATION_FAILED');
    const roles = await asTenant(pool, tenant.tenantId, async client => {
      const r = await client.query<{ role: string }>('SELECT role FROM party_roles WHERE tenant_id = $1 AND party_id = $2 ORDER BY role', [tenant.tenantId, p.id]);
      return r.rows.map(x => x.role);
    });
    expect(roles).toEqual(['CUSTOMER', 'SUPPLIER']);
  });

  it('reserves identity-wide status changes for all affected DEACTIVATE grants', async () => {
    const p = await createParty();
    await restrict([Permission.CUSTOMER_DEACTIVATE]);
    const denied = await request(app.getHttpServer()).post('/api/v1/parties/' + p.id + '/status')
      .set(auth()).send({ status: 'INACTIVE' }).expect(403);
    expect(denied.body.error.code).toBe('PERMISSION_DENIED');
    expect((await stored(p.id)).status).toBe('ACTIVE');
    await restrict([Permission.CUSTOMER_DEACTIVATE, Permission.SUPPLIER_DEACTIVATE]);
    await request(app.getHttpServer()).post('/api/v1/parties/' + p.id + '/status')
      .set(auth()).send({ status: 'INACTIVE' }).expect(200);
    expect((await stored(p.id)).status).toBe('INACTIVE');
  });

  it('does not let a single role DELETE an unused shared identity', async () => {
    const p = await createParty();
    await restrict([Permission.CUSTOMER_DEACTIVATE]);
    const denied = await request(app.getHttpServer()).delete('/api/v1/parties/' + p.id)
      .set(auth()).expect(403);
    expect(denied.body.error.code).toBe('PERMISSION_DENIED');
    await restrict([Permission.CUSTOMER_DEACTIVATE, Permission.SUPPLIER_DEACTIVATE]);
    await request(app.getHttpServer()).delete('/api/v1/parties/' + p.id)
      .set(auth()).expect(204);
  });

  it('preserves simple single-role status changes and refuses cross-tenant edits', async () => {
    const p = await createParty(['CUSTOMER']);
    await restrict([Permission.CUSTOMER_DEACTIVATE]);
    await request(app.getHttpServer()).post('/api/v1/parties/' + p.id + '/status')
      .set(auth()).send({ status: 'INACTIVE' }).expect(200);
    const other = await seedTenant(pool, {
      name: 'P3A isolated tenant B', permissions: [Permission.CUSTOMER_EDIT],
    });
    const cross = await request(app.getHttpServer()).patch('/api/v1/parties/' + p.id)
      .set(auth(signToken(other, TEST_JWT_SECRET)))
      .send({ ...fields, roles: ['CUSTOMER'], version: p.version }).expect(404);
    expect(cross.body.error.code).toBe('NOT_FOUND');
  });
});
