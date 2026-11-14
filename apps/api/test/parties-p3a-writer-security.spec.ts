/**
 * MOD-004 T09C-P3A — low-friction but role-safe Party writes.
 * Signed Nest HTTP, tenant RLS and an explicitly isolated PostgreSQL16 DB.
 * V1 read and write-response disclosure is intentionally NOT certified safe.
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
const ALL = [
  Permission.CUSTOMER_VIEW, Permission.CUSTOMER_CREATE, Permission.CUSTOMER_EDIT,
  Permission.CUSTOMER_DEACTIVATE, Permission.SUPPLIER_VIEW, Permission.SUPPLIER_CREATE,
  Permission.SUPPLIER_EDIT, Permission.SUPPLIER_DEACTIVATE,
  Permission.VENDOR_CREATE, Permission.VENDOR_VIEW,
  Permission.SETTING_VIEW, Permission.SETTING_EDIT, Permission.SETTING_TOGGLE,
  Permission.PARTY_PROFILE_VIEW, Permission.PARTY_HISTORY_GLOBAL_VIEW,
];
let app: INestApplication;
let pool: pg.Pool;
let tenant: SeededTenant;
let token: string;

const auth = (access = token) => ({ Authorization: 'Bearer ' + access });
type Role = 'CUSTOMER' | 'SUPPLIER' | 'VENDOR';
interface Draft {
  name: string;
  roles: Role[];
  phone: string | null;
  address: string | null;
  guardianName: string | null;
  nid: string | null;
  email: string | null;
  notes: string | null;
  customerGroupId: string | null;
  creditLimitMinor: number | null;
  version: number;
}

function saved(roles: Role[] = ['CUSTOMER', 'SUPPLIER']): Draft {
  return {
    name: 'Dual Party P3A', roles, phone: '01712345678',
    address: 'Private street', guardianName: 'Private guardian',
    nid: 'PRIVATE-NID', email: 'private@example.test', notes: 'Private note',
    customerGroupId: null, creditLimitMinor: 12000, version: 1,
  };
}
async function restrict(codes: readonly string[]): Promise<void> {
  await asTenant(pool, tenant.tenantId, async (client) => {
    await client.query('DELETE FROM role_permissions WHERE tenant_id=$1 AND role_id=$2',
      [tenant.tenantId, tenant.roleId]);
    const now = clock.now();
    for (const code of codes) {
      await client.query(
        'INSERT INTO role_permissions (id,tenant_id,role_id,permission_code,created_at,updated_at,created_by,updated_by,version) VALUES ($1,$2,$3,$4,$5,$5,$6,$6,1)',
        [Ulid.generate(clock), tenant.tenantId, tenant.roleId, code, now, tenant.userId],
      );
    }
  });
}
async function enableProfileFields(): Promise<void> {
  for (const key of [
    SettingKey.CUSTOMER_FIELD_ADDRESS_VISIBLE,
    SettingKey.CUSTOMER_FIELD_GUARDIAN_VISIBLE,
    SettingKey.CUSTOMER_FIELD_NID_VISIBLE,
    SettingKey.CUSTOMER_FIELD_EMAIL_VISIBLE,
    SettingKey.CUSTOMER_FIELD_NOTES_VISIBLE,
  ]) {
    await request(app.getHttpServer()).post('/api/v1/settings/value')
      .set(auth()).send({ key, value: 'on' }).expect(201);
  }
}
async function makeParty(roles: Role[] = ['CUSTOMER', 'SUPPLIER']): Promise<string> {
  await enableProfileFields();
  const draft = saved(roles);
  const { version: _v, ...input } = draft;
  const res = await request(app.getHttpServer()).post('/api/v1/parties').set(auth())
    .set('Idempotency-Key', Ulid.generate(clock)).send(input).expect(201);
  return res.body.data.id as string;
}
async function postSupplierOpening(id: string): Promise<void> {
  await request(app.getHttpServer()).post('/api/v1/parties/' + id + '/opening')
    .set(auth()).set('Idempotency-Key', Ulid.generate(clock))
    .send({ role: 'SUPPLIER', direction: 'PAYABLE', amountMinor: 99500,
      businessDate: clock.businessDate('Asia/Dhaka') }).expect(201);
}
function patch(id: string, body: Draft, access = token): request.Test {
  return request(app.getHttpServer()).patch('/api/v1/parties/' + id).set(auth(access)).send(body);
}
async function privilegedDetail(id: string): Promise<Record<string, unknown>> {
  await restrict(ALL);
  const res = await request(app.getHttpServer()).get('/api/v1/parties/' + id + '?role=CUSTOMER')
    .set(auth()).expect(200);
  return res.body.data as Record<string, unknown>;
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
  tenant = await seedTenant(pool, { name: 'P3A Isolated Test Tenant', permissions: ALL });
  token = signToken(tenant, TEST_JWT_SECRET);
});

describe('MOD-004 P3A — field-level grants without all-role EDIT', () => {
  it('lets Customer EDIT change name, preserving redacted full-PATCH private fields and Supplier role', async () => {
    const id = await makeParty();
    await restrict([Permission.CUSTOMER_EDIT, Permission.CUSTOMER_VIEW]);
    await patch(id, { ...saved(), name: 'Renamed by counter clerk', address: null,
      guardianName: null, nid: null, email: null, notes: null,
      customerGroupId: null, creditLimitMinor: null }).expect(200);
    const row = await privilegedDetail(id);
    expect(row.name).toBe('Renamed by counter clerk');
    expect(row.roles).toEqual(['CUSTOMER', 'SUPPLIER']);
    expect(row.address).toBe('Private street');
    expect(row.nid).toBe('PRIVATE-NID');
    expect(row.customerGroupId).toBeNull();
    expect(row.creditLimitMinor).toBe(12000);
  });

  it('denies new private values without profile grant but permits them with profile grant and one EDIT', async () => {
    const id = await makeParty();
    await restrict([Permission.CUSTOMER_EDIT]);
    await patch(id, { ...saved(), nid: 'UNAUTHORIZED-NID' }).expect(403);
    await restrict([Permission.CUSTOMER_EDIT, Permission.PARTY_PROFILE_VIEW]);
    await patch(id, { ...saved(), nid: 'AUTHORIZED-NID' }).expect(200);
    const row = await privilegedDetail(id);
    expect(row.nid).toBe('AUTHORIZED-NID');
  });

  it('allows Supplier EDIT of shared name without changing Customer-only credit; denies unauthorized credit edit', async () => {
    const id = await makeParty();
    await restrict([Permission.SUPPLIER_EDIT]);
    await patch(id, { ...saved(), name: 'Supplier-side rename', creditLimitMinor: null }).expect(200);
    await patch(id, { ...saved(), name: 'Bad credit edit',
      creditLimitMinor: 95000, version: 2 }).expect(403);
    const row = await privilegedDetail(id);
    expect(row.name).toBe('Supplier-side rename');
    expect(row.creditLimitMinor).toBe(12000);
  });

  it('requires the removed role DEACTIVATE, but not every relationship EDIT, on a never-used Party', async () => {
    const id = await makeParty();
    const removed = { ...saved(), roles: ['CUSTOMER'] as Role[] };
    await restrict([Permission.CUSTOMER_EDIT]);
    await patch(id, removed).expect(403);
    await restrict([Permission.CUSTOMER_EDIT, Permission.SUPPLIER_DEACTIVATE]);
    await patch(id, removed).expect(200);
    const row = await privilegedDetail(id);
    expect(row.roles).toEqual(['CUSTOMER']);
  });

  it('cannot remove any trading relationship when the Party has posted financial history', async () => {
    const id = await makeParty();
    await postSupplierOpening(id);
    await restrict([Permission.CUSTOMER_EDIT, Permission.SUPPLIER_DEACTIVATE]);
    await patch(id, { ...saved(), roles: ['CUSTOMER'] }).expect(400);
    const row = await privilegedDetail(id);
    expect(row.roles).toEqual(['CUSTOMER', 'SUPPLIER']);
    expect(row.hasLedgerEntries).toBe(true);
  });

  it('requires each existing role DEACTIVATE for one shared Party status, but only one for single-role Party', async () => {
    const dualId = await makeParty();
    await restrict([Permission.CUSTOMER_DEACTIVATE]);
    await request(app.getHttpServer()).post('/api/v1/parties/' + dualId + '/status')
      .set(auth()).send({ status: 'INACTIVE' }).expect(403);
    await restrict([Permission.CUSTOMER_DEACTIVATE, Permission.SUPPLIER_DEACTIVATE]);
    await request(app.getHttpServer()).post('/api/v1/parties/' + dualId + '/status')
      .set(auth()).send({ status: 'INACTIVE' }).expect(200);
    const row = await privilegedDetail(dualId);
    expect(row.status).toBe('INACTIVE');
    const onlyCustomer = await makeParty(['CUSTOMER']);
    await restrict([Permission.CUSTOMER_DEACTIVATE]);
    await request(app.getHttpServer()).post('/api/v1/parties/' + onlyCustomer + '/status')
      .set(auth()).send({ status: 'INACTIVE' }).expect(200);
  });

  it('does not accept Customer EDIT as permission to add Vendor or Supplier roles', async () => {
    const id = await makeParty(['CUSTOMER']);
    await restrict([Permission.CUSTOMER_EDIT]);
    await patch(id, { ...saved(['CUSTOMER', 'SUPPLIER']), creditLimitMinor: 12000 }).expect(403);
  });

  it('does not permit tenant B to edit or deactivate tenant A identity', async () => {
    const id = await makeParty();
    const other = await seedTenant(pool, { name: 'P3A Isolated Tenant B', permissions: ALL });
    const otherToken = signToken(other, TEST_JWT_SECRET);
    await patch(id, { ...saved(), name: 'Another-tenant edit' }, otherToken).expect(404);
    await request(app.getHttpServer()).post('/api/v1/parties/' + id + '/status')
      .set(auth(otherToken)).send({ status: 'INACTIVE' }).expect(404);
  });
});
