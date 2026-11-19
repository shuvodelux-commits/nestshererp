/**
 * MOD-004 T22-QA (#356): opt-in actual React V2 Party CREATE + PATCH
 * transports → live signed Nest HTTP → isolated PostgreSQL16/nonowner RLS.
 * No mocked successful API, production DB, V1 Party fallback or UI mounting.
 */
import 'reflect-metadata';

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Permission } from '@sher/core-contracts';
import { SystemClock, Ulid } from '@sher/shared-utils';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { AppErrorFilter } from '../src/common/app-error.filter';
import { signToken, TEST_JWT_SECRET } from './support/auth';
import type { SeededTenant } from './support/database';
import { asTenant, prepareTestDatabase, resetDatabase, seedTenant, testPool } from './support/database';

type TradingRole = 'CUSTOMER' | 'SUPPLIER' | 'VENDOR';
interface CreateInput {
  selectedRole: TradingRole;
  name: string;
  roles: TradingRole[];
  phone: string | null;
  address: string | null;
  guardianName: string | null;
  nid: string | null;
  email: string | null;
  notes: string | null;
  customerGroupId: string | null;
  creditLimitMinor: number | null;
}
interface EditInput { selectedRole: TradingRole; version: number; name: string; phone: string | null }
interface Receipt {
  data: { id: string; version: number; selectedRole: TradingRole; status: 'ACTIVE' | 'INACTIVE' };
}
type CreateClient = (
  token: string, operationId: string, input: CreateInput,
  signal?: AbortSignal, timeoutMs?: number,
) => Promise<Receipt>;
type EditClient = (
  token: string, partyId: string, input: EditInput,
  signal?: AbortSignal, timeoutMs?: number,
) => Promise<Receipt>;

const reactRoot = process.env['HISABIQ_REACT_SOURCE_DIR'];
const run = reactRoot ? describe : describe.skip;
const exactReactSha = '016462d7a7d2164db343a2b8641ade2ec2d99f14';
const clock = new SystemClock();
const newId = () => Ulid.generate(clock);
const grants = [
  Permission.CUSTOMER_CREATE, Permission.CUSTOMER_EDIT, Permission.CUSTOMER_VIEW,
  Permission.SUPPLIER_CREATE, Permission.SUPPLIER_EDIT, Permission.SUPPLIER_VIEW,
  Permission.PARTY_PROFILE_VIEW,
];
let createReact: CreateClient;
let editReact: EditClient;
let app: INestApplication;
let pool: pg.Pool;
let tenant: SeededTenant;
let token: string;
let originalFetch: typeof fetch | undefined;
let originalLocation: PropertyDescriptor | undefined;
let origin = '';
let calls: Array<{ path: string; method: string; key: string | null }> = [];
let loseAck = false;

const input = (roles: TradingRole[] = ['CUSTOMER'], name = 'QA Customer'): CreateInput => ({
  selectedRole: roles[0]!,
  name, roles, phone: '01712345678',
  address: null, guardianName: null, nid: null, email: null, notes: null,
  customerGroupId: null, creditLimitMinor: null,
});
const edit = (version: number, name: string, selectedRole: TradingRole = 'CUSTOMER'): EditInput => ({
  selectedRole, version, name, phone: '01712345678',
});

function testDbOnly(): void {
  const admin = process.env['ADMIN_DATABASE_URL'];
  const db = process.env['DATABASE_URL'];
  if (!admin || !db || process.env['TEST_DATABASE_URL'] !== db) {
    throw new Error('Requires a dedicated nonowner DATABASE_URL and TEST_DATABASE_URL');
  }
  const a = new URL(admin), u = new URL(db);
  if (a.protocol !== 'postgres:' || u.protocol !== 'postgres:' ||
      a.hostname !== '127.0.0.1' || u.hostname !== '127.0.0.1' ||
      a.port === '' || u.port !== a.port ||
      a.pathname !== '/sher_test' || u.pathname !== '/sher_test' ||
      a.username !== 'postgres' || u.username !== 'sher_app') {
    throw new Error('Only explicit task-owned loopback PG16 sher_test is permitted');
  }
}
async function restrict(codes: readonly string[], who = tenant): Promise<void> {
  await asTenant(pool, who.tenantId, async client => {
    await client.query('DELETE FROM role_permissions WHERE tenant_id=$1 AND role_id=$2',
      [who.tenantId, who.roleId]);
    const now = clock.now();
    for (const code of codes) {
      await client.query(
        'INSERT INTO role_permissions (id,tenant_id,role_id,permission_code,created_at,updated_at,created_by,updated_by,version) VALUES ($1,$2,$3,$4,$5,$5,$6,$6,1)',
        [newId(), who.tenantId, who.roleId, code, now, who.userId],
      );
    }
  });
}
async function counts(who = tenant) {
  return asTenant(pool, who.tenantId, async client => {
    const count = async (table: string, suffix = '') => {
      const { rows } = await client.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM ' + table + ' WHERE tenant_id=$1' + suffix, [who.tenantId],
      );
      return rows[0]!.n;
    };
    return {
      parties: await count('parties'),
      created: await count('audit_events', " AND entity_type='party' AND action='CREATE'"),
      edited: await count('audit_events', " AND entity_type='party' AND action='UPDATE'"),
      outbox: await count('outbox'),
      intents: await count('idempotency_keys'),
      journals: await count('journal_entries'),
      openings: await count('party_openings'),
      cash: await count('cash_movements'),
      stock: await count('stock_movements'),
    };
  });
}
async function stored(partyId: string, who = tenant) {
  return asTenant(pool, who.tenantId, async client => {
    const party = await client.query<{
      name: string; phone: string | null; nid: string | null;
      address: string | null; credit_limit_minor: string | null; version: number;
    }>(
      'SELECT name,phone,nid,address,credit_limit_minor,version FROM parties WHERE tenant_id=$1 AND id=$2',
      [who.tenantId, partyId],
    );
    const rows = await client.query<{ role: TradingRole }>(
      'SELECT role FROM party_roles WHERE tenant_id=$1 AND party_id=$2 ORDER BY role',
      [who.tenantId, partyId],
    );
    return { party: party.rows[0] ?? null, roles: rows.rows.map(row => row.role) };
  });
}
function exactReceipt(value: Receipt, selected: TradingRole, version: number): string {
  expect(Object.keys(value)).toEqual(['data']);
  expect(Object.keys(value.data).sort()).toEqual(['id', 'selectedRole', 'status', 'version']);
  expect(value.data.id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  expect(value.data.version).toBe(version);
  expect(value.data.status).toBe('ACTIVE');
  expect(value.data.selectedRole).toBe(selected);
  expect(JSON.stringify(value)).not.toMatch(/QA Customer|QA_NID|address|phone|balance|roles|globalHistory/);
  return value.data.id;
}
const own = () => token;
async function party(record: CreateInput = input(), op = newId(), jwt = own()): Promise<Receipt> {
  return createReact(jwt, op, record);
}
async function update(id: string, record: EditInput, jwt = own()): Promise<Receipt> {
  return editReact(jwt, id, record);
}

run('MOD-004 T22-QA: actual React Party V2 CREATE/PATCH + signed Nest + PG16 RLS', () => {
  beforeAll(async () => {
    if (!reactRoot || !isAbsolute(reactRoot) ||
        !existsSync(join(reactRoot, 'src/integration/party-v2-create.ts')) ||
        !existsSync(join(reactRoot, 'src/integration/party-v2-edit.ts'))) {
      throw new Error('A pinned absolute React source checkout is required');
    }
    const actual = execFileSync('git', ['-C', reactRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    if (actual !== exactReactSha) throw new Error('React source mismatch: ' + actual);
    testDbOnly();
    const createModule = await import(
      /* @vite-ignore */ pathToFileURL(join(reactRoot, 'src/integration/party-v2-create.ts')).href
    );
    const editModule = await import(
      /* @vite-ignore */ pathToFileURL(join(reactRoot, 'src/integration/party-v2-edit.ts')).href
    );
    createReact = createModule.createTradingPartyV2 as CreateClient;
    editReact = editModule.editTradingPartyNamePhoneV2 as EditClient;
    if (typeof createReact !== 'function' || typeof editReact !== 'function') {
      throw new Error('Expected actual React Party writer modules');
    }
    pool = testPool();
    await prepareTestDatabase();
    const proof = await pool.query<{ username: string; superuser: boolean; version: string }>(
      "SELECT current_user AS username, r.rolsuper AS superuser, current_setting('server_version_num') AS version FROM pg_roles r WHERE r.rolname=current_user",
    );
    expect(proof.rows[0]?.username).toBe('sher_app');
    expect(proof.rows[0]?.superuser).toBe(false);
    expect(Number(proof.rows[0]?.version)).toBeGreaterThanOrEqual(160000);
    expect(Number(proof.rows[0]?.version)).toBeLessThan(170000);

    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalFilters(new AppErrorFilter());
    await app.listen(0, '127.0.0.1');
    origin = await app.getUrl();
    originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
    Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin } });
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const target = new URL(String(url));
      expect(target.origin).toBe(origin);
      expect(init?.redirect).toBe('error');
      expect(init?.credentials).toBe('omit');
      const h = new Headers(init?.headers);
      expect(h.get('Authorization')).toMatch(/^Bearer /);
      expect(target.search).toBe('');
      if (target.pathname === '/api/v2/parties') {
        expect(init?.method).toBe('POST');
        expect(h.get('Idempotency-Key')).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
        expect(Object.keys(JSON.parse(String(init?.body))).sort()).toEqual(
          ['address','creditLimitMinor','customerGroupId','email','guardianName','name',
            'nid','notes','phone','roles','selectedRole'].sort(),
        );
      } else {
        expect(target.pathname).toMatch(/^\/api\/v2\/parties\/[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
        expect(init?.method).toBe('PATCH');
        expect(h.get('Idempotency-Key')).toBeNull();
        expect(Object.keys(JSON.parse(String(init?.body))).sort()).toEqual(
          ['selectedRole', 'version', 'name', 'phone'].sort(),
        );
      }
      calls.push({ path: target.pathname, method: init!.method!, key: h.get('Idempotency-Key') });
      const response = await originalFetch!(url, init); // REAL Nest HTTP success/failure, never mock.
      if (loseAck) {
        loseAck = false;
        throw new TypeError('Synthetic acknowledgement loss after server committed');
      }
      return response;
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
    tenant = await seedTenant(pool, { name: 'T22 QA tenant A', permissions: grants });
    token = signToken(tenant, TEST_JWT_SECRET);
    loseAck = false;
    calls = [];
  });

  it('role-only CREATE works without VIEW/private/history grants; returns a nonfinancial minimal receipt', async () => {
    await restrict([Permission.CUSTOMER_CREATE]);
    const before = await counts();
    const response = await party(input(), newId());
    const id = exactReceipt(response, 'CUSTOMER', 1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(await stored(id)).toMatchObject({
      party: { name: 'QA Customer', version: 1 }, roles: ['CUSTOMER'],
    });
    await expect(createReact(token, 'bad-key', input())).rejects.toMatchObject({ kind: 'protocol' });
    expect(calls).toHaveLength(1);
    expect(await counts()).toEqual({
      ...before, parties: before.parties + 1,
      created: before.created + 1, outbox: before.outbox + 1, intents: before.intents + 1,
    });
  }, 90_000);

  it('explicit same-key CREATE replay is single-posted; conflicting fingerprint and revoked role fail', async () => {
    await restrict([Permission.CUSTOMER_CREATE]);
    const key = newId(), record = input();
    const first = await party(record, key);
    const before = await counts();
    const again = await party(record, key);
    expect(again).toEqual(first);
    exactReceipt(again, 'CUSTOMER', 1);
    expect(await counts()).toEqual(before);
    await expect(party({ ...record, name: 'Changed fingerprint' }, key))
      .rejects.toMatchObject({ kind: 'http', status: 409 });
    await restrict([]);
    await expect(party(record, key)).rejects.toMatchObject({ kind: 'http', status: 403 });
    expect(await counts()).toEqual(before);
    expect(calls).toHaveLength(4);
  }, 90_000);

  it('shared Customer/Supplier needs both CREATE rights; Supplier-only EDIT preserves private stored state', async () => {
    const record = input(['CUSTOMER', 'SUPPLIER']);
    await restrict([Permission.CUSTOMER_CREATE]);
    const beforeDenied = await counts();
    await expect(party(record)).rejects.toMatchObject({ kind: 'http', status: 403 });
    expect(await counts()).toEqual(beforeDenied);
    await restrict([Permission.CUSTOMER_CREATE, Permission.SUPPLIER_CREATE]);
    const created = await party(record);
    const id = exactReceipt(created, 'CUSTOMER', 1);
    // Synthetic RLS-scoped *test fixture*: after the real create, populate
    // protected state solely to prove low-friction EDIT cannot clear it.
    // This does not claim that direct SQL is a supported production profile API.
    await asTenant(pool, tenant.tenantId, async client => {
      await client.query(
        'UPDATE parties SET nid=$1,address=$2,credit_limit_minor=$3 WHERE tenant_id=$4 AND id=$5',
        ['QA_NID_PRESERVE', 'QA private address', 4321, tenant.tenantId, id],
      );
    });
    const before = await counts();
    await restrict([Permission.SUPPLIER_EDIT]);
    const updated = await update(id, edit(1, 'Supplier name correction', 'SUPPLIER'));
    expect(exactReceipt(updated, 'SUPPLIER', 2)).toBe(id);
    expect(await stored(id)).toMatchObject({
      party: { name: 'Supplier name correction', nid: 'QA_NID_PRESERVE',
        address: 'QA private address', version: 2 },
      roles: ['CUSTOMER', 'SUPPLIER'],
    });
    expect(Number((await stored(id)).party?.credit_limit_minor)).toBe(4321);
    expect(await counts()).toEqual({
      ...before, edited: before.edited + 1, outbox: before.outbox + 1,
    });
    expect(calls.map(c => c.method)).toEqual(['POST', 'POST', 'PATCH']);
  }, 90_000);

  it('write-only EDIT enforces CAS, selected membership, revocation and foreign tenant isolation', async () => {
    const created = await party();
    const id = created.data.id;
    const other = await seedTenant(pool, {
      name: 'T22 QA tenant B', permissions: [Permission.CUSTOMER_EDIT],
    });
    const otherToken = signToken(other, TEST_JWT_SECRET);
    await restrict([Permission.CUSTOMER_EDIT]);
    const before = await counts();
    const changed = await update(id, edit(1, 'Renamed without read'));
    exactReceipt(changed, 'CUSTOMER', 2);
    await expect(update(id, edit(1, 'Stale overwrite')))
      .rejects.toMatchObject({ kind: 'http', status: 409 });
    await expect(update(id, edit(2, 'Wrong tenant'), otherToken))
      .rejects.toMatchObject({ kind: 'http', status: 404 });
    await restrict([Permission.SUPPLIER_EDIT]);
    await expect(update(id, edit(2, 'Wrong selected relation', 'SUPPLIER')))
      .rejects.toMatchObject({ kind: 'http', status: 404 });
    await restrict([]);
    await expect(update(id, edit(2, 'Revoked')))
      .rejects.toMatchObject({ kind: 'http', status: 403 });
    expect((await stored(id)).party?.name).toBe('Renamed without read');
    expect(await counts()).toEqual({
      ...before, edited: before.edited + 1, outbox: before.outbox + 1,
    });
    expect((await stored(id, other)).party).toBeNull();
    expect((await counts(other)).parties).toBe(0);
  }, 90_000);

  it('two actual React competing PATCH calls perform only one change and one 409', async () => {
    const created = await party();
    const id = created.data.id;
    await restrict([Permission.CUSTOMER_EDIT]);
    const before = await counts();
    const results = await Promise.allSettled([
      update(id, edit(1, 'First edit')), update(id, edit(1, 'Second edit')),
    ]);
    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ reason: { kind: 'http', status: 409 } });
    expect((await stored(id)).party?.version).toBe(2);
    expect(await counts()).toEqual({
      ...before, edited: before.edited + 1, outbox: before.outbox + 1,
    });
    expect(calls.filter(c => c.method === 'PATCH')).toHaveLength(2);
  }, 90_000);

  it('lost CREATE and EDIT acknowledgements are unknown, with no implicit retries or duplicate posting', async () => {
    await restrict([Permission.CUSTOMER_CREATE]);
    const key = newId(), record = input();
    const before = await counts();
    loseAck = true;
    await expect(party(record, key)).rejects.toMatchObject({ kind: 'network' });
    expect(calls).toHaveLength(1);
    expect(await counts()).toEqual({
      ...before, parties: before.parties + 1, created: before.created + 1,
      outbox: before.outbox + 1, intents: before.intents + 1,
    });
    // Explicit caller recovery with SAME key, never client auto-retry.
    const replay = await party(record, key);
    const id = exactReceipt(replay, 'CUSTOMER', 1);
    const afterCreate = await counts();
    await restrict([Permission.CUSTOMER_EDIT]);
    loseAck = true;
    await expect(update(id, edit(1, 'Committed despite lost ACK')))
      .rejects.toMatchObject({ kind: 'network' });
    expect(calls.filter(c => c.method === 'PATCH')).toHaveLength(1);
    expect((await stored(id)).party).toMatchObject({
      name: 'Committed despite lost ACK', version: 2,
    });
    await expect(update(id, edit(1, 'Forbidden silent retry')))
      .rejects.toMatchObject({ kind: 'http', status: 409 });
    expect(await counts()).toEqual({
      ...afterCreate, edited: afterCreate.edited + 1, outbox: afterCreate.outbox + 1,
    });
    expect(calls.map(c => c.method)).toEqual(['POST', 'POST', 'PATCH', 'PATCH']);
  }, 90_000);
});
