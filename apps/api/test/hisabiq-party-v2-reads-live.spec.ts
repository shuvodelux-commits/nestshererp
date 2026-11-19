/**
 * MOD-004 T23-QA (#361): real React V2 Party trading-role reads through signed
 * Nest HTTP and disposable PG16/nonowner RLS. Opt-in; no simulated success.
 */
import 'reflect-metadata';

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Permission, SettingKey } from '@sher/core-contracts';
import { SystemClock, Ulid } from '@sher/shared-utils';
import type pg from 'pg';
import request from 'supertest';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { AppErrorFilter } from '../src/common/app-error.filter';
import { signToken, TEST_JWT_SECRET } from './support/auth';
import type { SeededTenant } from './support/database';
import { asTenant, prepareTestDatabase, resetDatabase, seedTenant, testPool } from './support/database';

type Role = 'CUSTOMER' | 'SUPPLIER' | 'VENDOR';
interface RolePartyProjection {
  id: string;
  readRole: Role;
  roles: Role[];
  profile: { state: 'WITHHELD' | 'VISIBLE'; data?: { nid: string | null } };
  globalHistory: { state: 'WITHHELD' | 'VISIBLE'; hasLedgerEntries?: boolean };
  balance: { netMinor: number };
}
interface RolePartyList {
  data: RolePartyProjection[];
  summary: { total: number };
}
interface RolePartyDetail { data: RolePartyProjection }
interface RoleLedgerRead {
  partyId: string;
  closingBalance: { netMinor: number };
  rows: Array<{ account: string; sourceDocumentType: string }>;
}
interface RoleOpeningRead {
  data: null | { role: Role; direction: 'RECEIVABLE' | 'PAYABLE'; amountMinor: number };
}
type ListReader = (token: string, role: Role, query?: Record<string, unknown>) => Promise<RolePartyList>;
type DetailReader = (token: string, id: string, role: Role) => Promise<RolePartyDetail>;
type LedgerReader = (token: string, id: string, role: Role, query?: Record<string, unknown>) => Promise<RoleLedgerRead>;
type OpeningReader = (token: string, id: string, role: Role) => Promise<RoleOpeningRead>;

const reactRoot = process.env['HISABIQ_REACT_SOURCE_DIR'];
const run = reactRoot ? describe : describe.skip;
const expectedReactHead = '016462d7a7d2164db343a2b8641ade2ec2d99f14';
const clock = new SystemClock();
const id = () => Ulid.generate(clock);
const grantAll = [
  Permission.CUSTOMER_VIEW, Permission.CUSTOMER_CREATE, Permission.SUPPLIER_VIEW,
  Permission.SUPPLIER_CREATE, Permission.VENDOR_VIEW,
  // Private fixture fields are written only by the signed source API while
  // the test actor holds the explicit profile grant; reads revoke it below.
  Permission.PARTY_PROFILE_VIEW,
  Permission.SETTING_VIEW, Permission.SETTING_EDIT, Permission.SETTING_TOGGLE,
];
const profileGrant = Permission.PARTY_PROFILE_VIEW;
const historyGrant = Permission.PARTY_HISTORY_GLOBAL_VIEW;
let list: ListReader, detail: DetailReader, ledger: LedgerReader, opening: OpeningReader;
let app: INestApplication, pool: pg.Pool, tenant: SeededTenant, token: string;
let originalFetch: typeof fetch, originalLocation: PropertyDescriptor | undefined;
let origin = '';
let requests: Array<{ path: string; method: string; auth: string | null }> = [];

function requireDisposableDatabase(): void {
  const a = process.env['ADMIN_DATABASE_URL'];
  const u = process.env['DATABASE_URL'];
  if (!a || !u || u !== process.env['TEST_DATABASE_URL'])
    throw new Error('Explicit disposable nonowner DATABASE_URL = TEST_DATABASE_URL required');
  const admin = new URL(a), user = new URL(u);
  if (admin.protocol !== 'postgres:' || user.protocol !== 'postgres:' ||
      admin.hostname !== '127.0.0.1' || user.hostname !== admin.hostname ||
      !admin.port || user.port !== admin.port ||
      admin.pathname !== '/sher_test' || user.pathname !== '/sher_test' ||
      admin.username !== 'postgres' || user.username !== 'sher_app')
    throw new Error('Only task-owned localhost PG16 sher_test is supported');
}
async function restrict(grants: readonly string[], who = tenant): Promise<void> {
  await asTenant(pool, who.tenantId, async client => {
    await client.query('DELETE FROM role_permissions WHERE tenant_id=$1 AND role_id=$2',
      [who.tenantId, who.roleId]);
    for (const p of grants) {
      await client.query(
        'INSERT INTO role_permissions (id,tenant_id,role_id,permission_code,created_at,updated_at,created_by,updated_by,version) VALUES ($1,$2,$3,$4,$5,$5,$6,$6,1)',
        [id(), who.tenantId, who.roleId, p, clock.now(), who.userId],
      );
    }
  });
}
const auth = (jwt = token) => ({ Authorization: 'Bearer ' + jwt });

async function enablePrivateFields(): Promise<void> {
  for (const key of [
    SettingKey.CUSTOMER_FIELD_ADDRESS_VISIBLE, SettingKey.CUSTOMER_FIELD_GUARDIAN_VISIBLE,
    SettingKey.CUSTOMER_FIELD_NID_VISIBLE, SettingKey.CUSTOMER_FIELD_EMAIL_VISIBLE,
    SettingKey.CUSTOMER_FIELD_NOTES_VISIBLE,
  ]) {
    await request(app.getHttpServer()).post('/api/v1/settings/value')
      .set(auth()).send({ key, value: 'on' }).expect(201);
  }
}
async function createShared(): Promise<string> {
  await enablePrivateFields();
  const created = await request(app.getHttpServer())
    .post('/api/v2/parties').set(auth()).set('Idempotency-Key', id())
    .send({
      selectedRole: 'CUSTOMER', roles: ['CUSTOMER', 'SUPPLIER'],
      name: 'T23 Shared Party', phone: '01712345678',
      address: 'Private Natore address', guardianName: 'Private guardian',
      nid: 'T23-PRIVATE-NID', email: 'private-t23@example.test', notes: 'T23 notes',
      customerGroupId: null, creditLimitMinor: null,
    }).expect(201);
  const partyId = created.body.data.id as string;
  await request(app.getHttpServer()).post('/api/v1/parties/' + partyId + '/opening')
    .set(auth()).set('Idempotency-Key', id())
    .send({
      role: 'SUPPLIER', direction: 'PAYABLE', amountMinor: 315_000,
      businessDate: clock.businessDate('Asia/Dhaka'),
    }).expect(201);
  return partyId;
}
async function nonPostingSnapshot() {
  return asTenant(pool, tenant.tenantId, async client => {
    const c = async (table: string) => {
      const {rows} = await client.query<{n:number}>(
        'SELECT count(*)::int AS n FROM ' + table + ' WHERE tenant_id=$1',
        [tenant.tenantId],
      );
      return rows[0]!.n;
    };
    return {
      entries: await c('journal_entries'),
      lines: await c('journal_lines'),
      cash: await c('cash_movements'),
      stock: await c('stock_movements'),
      outbox: await c('outbox'),
      openings: await c('party_openings'),
    };
  });
}

run('MOD-004 T23-QA signed actual React trading-role reads', () => {
  beforeAll(async () => {
    if (!reactRoot || !isAbsolute(reactRoot) ||
        !existsSync(join(reactRoot, 'src/integration/party-reads.ts')))
      throw new Error('Require exact absolute React checkout for opt-in cross-repo test');
    const actualHead = execFileSync('git', ['-C', reactRoot, 'rev-parse', 'HEAD'],
      { encoding: 'utf8' }).trim();
    if (actualHead !== expectedReactHead) throw new Error('React source SHA mismatch');
    requireDisposableDatabase();
    const actual = await import(
      /* @vite-ignore */ pathToFileURL(join(reactRoot, 'src/integration/party-reads.ts')).href
    );
    list = actual.readTradingParties as ListReader;
    detail = actual.readTradingParty as DetailReader;
    ledger = actual.readTradingPartyLedger as LedgerReader;
    opening = actual.readHistoricalPartyOpening as OpeningReader;
    if ([list, detail, ledger, opening].some(fn => typeof fn !== 'function'))
      throw new Error('Missing actual merged React Party read transport');

    pool = testPool();
    await prepareTestDatabase();
    const proof = await pool.query<{ actor: string; elevated: boolean; pg: string }>(
      "SELECT current_user AS actor,rolsuper AS elevated,current_setting('server_version_num') AS pg FROM pg_roles WHERE rolname=current_user",
    );
    expect(proof.rows[0]?.actor).toBe('sher_app');
    expect(proof.rows[0]?.elevated).toBe(false);
    expect(Number(proof.rows[0]?.pg)).toBeGreaterThanOrEqual(160000);
    expect(Number(proof.rows[0]?.pg)).toBeLessThan(170000);

    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalFilters(new AppErrorFilter());
    await app.listen(0, '127.0.0.1');
    origin = await app.getUrl();
    originalFetch = globalThis.fetch;
    originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
    Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin } });
    globalThis.fetch = async (url, init) => {
      const target = new URL(String(url));
      const h = new Headers(init?.headers);
      expect(target.origin).toBe(origin);
      expect(target.pathname.startsWith('/api/v2/parties')).toBe(true);
      expect(init?.method).toBe('GET');
      expect(init?.credentials).toBe('omit');
      expect(init?.redirect).toBe('error');
      expect(h.get('Authorization')).toMatch(/^Bearer /);
      expect(h.get('Idempotency-Key')).toBeNull();
      expect(target.searchParams.has('tenantId')).toBe(false);
      requests.push({ path: target.pathname + target.search, method: 'GET', auth: h.get('Authorization') });
      return originalFetch(url, init);
    };
  }, 90_000);
  afterAll(async () => {
    if (originalFetch) globalThis.fetch = originalFetch;
    if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation);
    else Reflect.deleteProperty(globalThis, 'location');
    if (app) await app.close();
    if (pool) await pool.end();
  });
  beforeEach(async () => {
    await resetDatabase(pool);
    tenant = await seedTenant(pool, { name: 'T23 QA Tenant A', permissions: grantAll });
    token = signToken(tenant, TEST_JWT_SECRET);
    requests = [];
  });

  it('Customer VIEW alone returns selected-role list/detail with withheld profile, history and Supplier payable', async () => {
    const partyId = await createShared();
    await restrict([Permission.CUSTOMER_VIEW]);
    const before = await nonPostingSnapshot();
    const page = await list(token, 'CUSTOMER');
    expect(page.data).toHaveLength(1);
    expect(page.data[0]).toMatchObject({
      id: partyId, readRole: 'CUSTOMER', roles: ['CUSTOMER'],
      profile: { state: 'WITHHELD' }, globalHistory: { state: 'WITHHELD' },
      balance: { netMinor: 0 },
    });
    expect(page.summary.total).toBe(1);
    const one = await detail(token, partyId, 'CUSTOMER');
    expect(one.data).toMatchObject({
      id: partyId, roles: ['CUSTOMER'], balance: { netMinor: 0 },
      profile: { state: 'WITHHELD' }, globalHistory: { state: 'WITHHELD' },
    });
    expect(JSON.stringify([page, one])).not.toContain('T23-PRIVATE-NID');
    expect(JSON.stringify([page, one])).not.toContain('315000');
    expect(JSON.stringify([page, one])).not.toContain('SUPPLIER');
    expect(requests).toHaveLength(2);
    expect(await nonPostingSnapshot()).toEqual(before);
  }, 90_000);

  it('PROFILE and HISTORY grants are independent; no grant is an implicit Supplier VIEW', async () => {
    const partyId = await createShared();
    await restrict([Permission.CUSTOMER_VIEW, profileGrant]);
    const profile = await detail(token, partyId, 'CUSTOMER');
    expect(profile.data.profile).toMatchObject({ state: 'VISIBLE', data: { nid: 'T23-PRIVATE-NID' } });
    expect(profile.data.globalHistory).toEqual({ state: 'WITHHELD' });
    await restrict([Permission.CUSTOMER_VIEW, historyGrant]);
    const history = await detail(token, partyId, 'CUSTOMER');
    expect(history.data.profile).toEqual({ state: 'WITHHELD' });
    expect(history.data.globalHistory).toEqual({ state: 'VISIBLE', hasLedgerEntries: true });
    await restrict([profileGrant, historyGrant]);
    await expect(detail(token, partyId, 'CUSTOMER')).rejects.toMatchObject({ kind: 'http', status: 403 });
    await restrict([Permission.CUSTOMER_VIEW, profileGrant, historyGrant]);
    await expect(detail(token, partyId, 'SUPPLIER')).rejects.toMatchObject({ kind: 'http', status: 403 });
    expect(requests).toHaveLength(4);
  }, 90_000);

  it('Supplier posted opening and AP ledger are role-scoped; Customer has null source/zero net', async () => {
    const partyId = await createShared();
    await restrict([Permission.CUSTOMER_VIEW]);
    const before = await nonPostingSnapshot();
    const absent = await opening(token, partyId, 'CUSTOMER');
    expect(absent).toEqual({ data: null });
    const customer = await ledger(token, partyId, 'CUSTOMER');
    expect(customer.rows).toEqual([]);
    expect(customer.closingBalance.netMinor).toBe(0);
    await expect(opening(token, partyId, 'SUPPLIER'))
      .rejects.toMatchObject({ kind: 'http', status: 403 });
    await restrict([Permission.SUPPLIER_VIEW]);
    const source = await opening(token, partyId, 'SUPPLIER');
    expect(source.data).toMatchObject({
      role: 'SUPPLIER', direction: 'PAYABLE', amountMinor: 315_000,
    });
    const supplier = await ledger(token, partyId, 'SUPPLIER');
    expect(supplier.partyId).toBe(partyId);
    expect(supplier.closingBalance.netMinor).toBe(-315_000);
    expect(supplier.rows).toHaveLength(1);
    expect(supplier.rows[0]).toMatchObject({
      account: 'AP', sourceDocumentType: 'OPENING_BALANCE',
    });
    expect(JSON.stringify([source, supplier])).not.toContain('T23-PRIVATE-NID');
    expect(await nonPostingSnapshot()).toEqual(before);
  }, 90_000);

  it('different signed tenant and revoked role cannot read the identity or infer hidden roles', async () => {
    const partyId = await createShared();
    const other = await seedTenant(pool, {
      name: 'T23 QA Tenant B', permissions: [Permission.CUSTOMER_VIEW, Permission.SUPPLIER_VIEW],
    });
    const otherToken = signToken(other, TEST_JWT_SECRET);
    await restrict([Permission.CUSTOMER_VIEW]);
    const otherPage = await list(otherToken, 'CUSTOMER');
    expect(otherPage.data).toEqual([]);
    await expect(detail(otherToken, partyId, 'CUSTOMER'))
      .rejects.toMatchObject({ kind: 'http', status: 404 });
    await expect(detail(token, partyId, 'SUPPLIER'))
      .rejects.toMatchObject({ kind: 'http', status: 403 });
    await restrict([]);
    await expect(list(token, 'CUSTOMER')).rejects.toMatchObject({ kind: 'http', status: 403 });
    expect(requests.every(c => c.path.startsWith('/api/v2/parties'))).toBe(true);
  }, 90_000);

  it('Client rejects Supplier-only group and invalid ledger dates before HTTP; vendor OFF is refused', async () => {
    const partyId = await createShared();
    await restrict([Permission.SUPPLIER_VIEW, Permission.VENDOR_VIEW]);
    const before = requests.length;
    await expect(list(token, 'SUPPLIER', { groupId: id() })).rejects.toMatchObject({ kind: 'protocol' });
    await expect(list(token, 'SUPPLIER', { sort: 'creditLimit' })).rejects.toMatchObject({ kind: 'protocol' });
    await expect(ledger(token, partyId, 'SUPPLIER', { fromDate: 'not-a-date' }))
      .rejects.toMatchObject({ kind: 'protocol' });
    expect(requests).toHaveLength(before);
    await expect(list(token, 'VENDOR')).rejects.toMatchObject({ kind: 'http', status: 403 });
    expect(requests).toHaveLength(before + 1);
  }, 90_000);
});
