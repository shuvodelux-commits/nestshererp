/**
 * MOD-006 T02-B — signed, read-only Counter preflight source acceptance.
 * Only a unique opt-in disposable PostgreSQL16 may be migrated/reset.
 * Fixtures POST accounts/parties; assertions exercise the three actual GET
 * endpoints consumed by the merged, unmounted HisabIQ Counter preflight.
 * @covers endpoint:GET /api/v1/me
 * @covers endpoint:GET /api/v2/parties/:id
 * @covers endpoint:GET /api/v1/money/accounts
 */
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Permission } from '@sher/core-contracts';
import { SystemClock, Ulid } from '@sher/shared-utils';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { AppErrorFilter } from '../src/common/app-error.filter';
import { signToken, TEST_JWT_SECRET } from './support/auth';
import type { SeededTenant } from './support/database';
import {
  asTenant, prepareTestDatabase, resetDatabase, seedTenant, testPool,
} from './support/database';
import { assertGoldenInvariants } from './support/invariants';

const clock = new SystemClock();
const DB = 'hisabiq_mod006_t02b_preflight_20261115';
const PORT = '55773';
const SENTINEL = 'MOD006_T02B_DISPOSABLE_20261115';
const suite = process.env['MOD006_T02B_TEST_ONLY'] === SENTINEL ? describe : describe.skip;
const GRANTS = [
  Permission.CUSTOMER_VIEW, Permission.CUSTOMER_CREATE,
  Permission.SUPPLIER_VIEW, Permission.SUPPLIER_CREATE,
  Permission.SALE_RECEIVE_PAYMENT, Permission.PURCHASE_PAY,
  Permission.CASH_ACCOUNT_VIEW, Permission.CASH_ACCOUNT_MANAGE,
  Permission.BANK_ACCOUNT_VIEW, Permission.BANK_ACCOUNT_MANAGE,
  Permission.SETTING_VIEW, Permission.SETTING_EDIT, Permission.SETTING_TOGGLE,
];

let app: INestApplication;
let pool: pg.Pool;
let shop: SeededTenant;
let token: string;
const api = () => request(app.getHttpServer());
const auth = (as = token) => ({ Authorization: 'Bearer ' + as });
const id = () => Ulid.generate(clock);
const partyPath = (partyId: string, role: 'CUSTOMER' | 'SUPPLIER') =>
  '/api/v2/parties/' + partyId + '?role=' + role;
const me = (as = token) => api().get('/api/v1/me').set(auth(as));
const money = (as = token) => api().get('/api/v1/money/accounts').set(auth(as));
const party = (partyId: string, role: 'CUSTOMER' | 'SUPPLIER', as = token) =>
  api().get(partyPath(partyId, role)).set(auth(as));

function assertDisposable(): void {
  if (process.env['MOD006_T02B_TEST_ONLY'] !== SENTINEL) {
    throw new Error('T02-B requires the exact explicit opt-in sentinel');
  }
  for (const key of ['DATABASE_URL', 'TEST_DATABASE_URL', 'ADMIN_DATABASE_URL']) {
    const value = process.env[key];
    if (!value) throw new Error('T02-B missing explicit disposable URL: ' + key);
    const url = new URL(value);
    const role = key === 'ADMIN_DATABASE_URL' ? 'postgres' : 'sher_app';
    if (url.protocol !== 'postgres:' || url.hostname !== '127.0.0.1' ||
        url.port !== PORT || url.pathname !== '/' + DB || url.username !== role) {
      throw new Error('T02-B refuses external, shared or privileged application database');
    }
  }
}
async function createParty(name: string, roles: Array<'CUSTOMER' | 'SUPPLIER'>): Promise<string> {
  const operationId = id();
  const result = await api().post('/api/v1/parties')
    .set(auth()).set('Idempotency-Key', operationId)
    .send({
      name, roles, phone: '01712345678', address: null, guardianName: null,
      nid: null, email: null, notes: null, customerGroupId: null,
      creditLimitMinor: null,
    });
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  return result.body.data.id as string;
}
async function enableBank(): Promise<void> {
  const result = await api().post('/api/v1/settings/value')
    .set(auth()).send({key: 'bank_accounts_enabled', value: 'on'});
  expect(result.status, JSON.stringify(result.body)).toBe(201);
}
async function createAccount(
  name: string, type: 'CASH' | 'BANK' | 'MFS',
): Promise<{id: string; version: number}> {
  const operationId = id();
  const result = await api().post('/api/v1/money/accounts')
    .set(auth()).set('Idempotency-Key', operationId)
    .send({
      name, type, holderName: null, reference: null, isDrawer: false,
      openingAmountMinor: 0, openingDate: null, operationId,
    });
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  return { id: result.body.data.id as string, version: result.body.data.version as number };
}
async function restrict(codes: readonly string[]): Promise<void> {
  await asTenant(pool, shop.tenantId, async db => {
    await db.query(
      'DELETE FROM role_permissions WHERE tenant_id=$1 AND role_id=$2',
      [shop.tenantId, shop.roleId],
    );
    const now = clock.now();
    for (const code of codes) {
      await db.query(
        'INSERT INTO role_permissions (id, tenant_id, role_id, permission_code, created_at, updated_at, created_by, updated_by, version) VALUES ($1,$2,$3,$4,$5,$5,$6,$6,1)',
        [id(), shop.tenantId, shop.roleId, code, now, shop.userId],
      );
    }
  });
}
async function sourceSnapshot(): Promise<Record<string, number>> {
  return asTenant(pool, shop.tenantId, async db => {
    const counts: Record<string, number> = {};
    for (const table of [
      'accounts', 'parties', 'journal_entries', 'journal_lines', 'cash_sessions',
      'audit_events', 'outbox', 'idempotency_keys',
    ]) {
      const result = await db.query<{count:number}>(
        'SELECT COUNT(*)::int AS count FROM ' + table,
      );
      counts[table] = result.rows[0]?.count ?? -1;
    }
    return counts;
  });
}

suite('MOD-006 T02-B: signed connected Counter GET preflight and tenant-RLS', () => {
  beforeAll(async () => {
    assertDisposable(); // Required BEFORE any DB migration, fixture or reset.
    pool = testPool();
    await prepareTestDatabase();
    const moduleRef = await Test.createTestingModule({imports:[AppModule]}).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AppErrorFilter());
    await app.init();
  }, 60_000);
  afterAll(async () => { await app?.close(); await pool?.end(); });
  beforeEach(async () => {
    await resetDatabase(pool);
    shop = await seedTenant(pool, { name: 'T02B Synthetic Counter', permissions: GRANTS });
    token = signToken(shop, TEST_JWT_SECRET);
  });
  afterEach(async () => {
    if (shop?.tenantId) await assertGoldenInvariants(pool, shop.tenantId);
  });

  it('signed /me plus role-specific Party and CASH/BANK/MFS GETs never post a journal', async () => {
    await enableBank();
    const shared = await createParty('T02B shared trading party', ['CUSTOMER','SUPPLIER']);
    const cash = await createAccount('T02B Counter Cash', 'CASH');
    const bank = await createAccount('T02B Counter Bank', 'BANK');
    const mfs = await createAccount('T02B Counter MFS', 'MFS');
    const before = await sourceSnapshot();

    const who = await me().expect(200);
    expect(who.body.data.tenantId).toBe(shop.tenantId);
    expect(who.body.data.user.id).toBe(shop.userId);
    for (const permission of [
      Permission.CUSTOMER_VIEW, Permission.SUPPLIER_VIEW,
      Permission.SALE_RECEIVE_PAYMENT, Permission.PURCHASE_PAY,
      Permission.CASH_ACCOUNT_VIEW, Permission.BANK_ACCOUNT_VIEW,
    ]) expect(who.body.data.permissions).toContain(permission);

    for (const role of ['CUSTOMER', 'SUPPLIER'] as const) {
      const result = await party(shared, role).expect(200);
      expect(result.body.data.id).toBe(shared);
      expect(result.body.data.readRole).toBe(role);
      expect(result.body.data.roles).toContain(role);
      expect(result.body.data.status).toBe('ACTIVE');
      expect(result.body.data.isSystemReserved).toBe(false);
      expect(result.body.data.profile).toEqual({state:'WITHHELD'});
      expect(result.body.data.globalHistory).toEqual({state:'WITHHELD'});
    }
    const list = await money().expect(200);
    const expected = new Map([[cash.id,'CASH'],[bank.id,'BANK'],[mfs.id,'MFS']]);
    for (const [accountId, type] of expected) {
      const selected = (list.body.accounts as Array<{id:string;type:string;status:string}>)
        .find(row => row.id === accountId);
      expect(selected).toMatchObject({id:accountId,type,status:'ACTIVE'});
    }
    expect(await sourceSnapshot()).toEqual(before);
  }, 60_000);

  it('revokes supplier visibility and BANK/MFS account sources independently per signed request', async () => {
    await enableBank();
    const shared = await createParty('T02B grant boundary', ['CUSTOMER','SUPPLIER']);
    const cash = await createAccount('T02B Cash boundary', 'CASH');
    const bank = await createAccount('T02B Bank boundary', 'BANK');
    const mfs = await createAccount('T02B MFS boundary', 'MFS');
    await restrict([
      Permission.CUSTOMER_VIEW, Permission.SALE_RECEIVE_PAYMENT,
      Permission.CASH_ACCOUNT_VIEW,
    ]);
    const who = await me().expect(200);
    expect(who.body.data.permissions).not.toContain(Permission.SUPPLIER_VIEW);
    expect(who.body.data.permissions).not.toContain(Permission.BANK_ACCOUNT_VIEW);
    await party(shared, 'CUSTOMER').expect(200);
    await party(shared, 'SUPPLIER').expect(403);
    const visible = await money().expect(200);
    const visibleIds = (visible.body.accounts as Array<{id:string}>).map(x => x.id);
    expect(visibleIds).toContain(cash.id);
    expect(visibleIds).not.toContain(bank.id);
    expect(visibleIds).not.toContain(mfs.id);
  }, 60_000);

  it('tenant B cannot select tenant A Party or money account even with the same view grants', async () => {
    const shared = await createParty('T02B private cross-tenant Party', ['CUSTOMER']);
    const cash = await createAccount('T02B private till', 'CASH');
    const foreign = await seedTenant(pool, {
      name: 'T02B other independent tenant',
      permissions: [Permission.CUSTOMER_VIEW,Permission.CASH_ACCOUNT_VIEW],
    });
    const otherToken = signToken(foreign, TEST_JWT_SECRET);
    const who = await me(otherToken).expect(200);
    expect(who.body.data.tenantId).toBe(foreign.tenantId);
    expect(who.body.data.tenantId).not.toBe(shop.tenantId);
    await party(shared, 'CUSTOMER', otherToken).expect(404);
    const list = await money(otherToken).expect(200);
    expect((list.body.accounts as Array<{id:string}>).some(x=>x.id===cash.id)).toBe(false);
    expect(JSON.stringify(list.body)).not.toContain('T02B private till');
  }, 60_000);

  it('inactive CASH accounts remain excluded by default but visible as inactive with explicit opt-in', async () => {
    const created = await createAccount('T02B dormant till', 'CASH');
    const changed = await api().post('/api/v1/money/accounts/'+created.id+'/deactivate')
      .set(auth()).send({version:created.version});
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    const defaultList = await money().expect(200);
    expect(defaultList.body.accounts.some((x:{id:string})=>x.id===created.id)).toBe(false);
    const full = await api().get('/api/v1/money/accounts?includeInactive=true')
      .set(auth()).expect(200);
    expect(full.body.accounts.find((x:{id:string})=>x.id===created.id).status).toBe('INACTIVE');
  });

  it('wrong Party role and unsigned requests do not produce selectable source data', async () => {
    const customer = await createParty('T02B customer only', ['CUSTOMER']);
    await party(customer, 'SUPPLIER').expect(404);
    await api().get('/api/v1/me').expect(401);
    await api().get('/api/v1/money/accounts').expect(401);
    await api().get(partyPath(customer,'CUSTOMER')).expect(401);
    const before = await sourceSnapshot();
    await party(id(), 'CUSTOMER').expect(404);
    expect(await sourceSnapshot()).toEqual(before);
  });
});
