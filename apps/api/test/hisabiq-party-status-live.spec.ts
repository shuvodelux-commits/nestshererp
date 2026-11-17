/**
 * MOD-004 T21-QA (#347): actual HisabIQ React V2 status adapter -> signed
 * Nest HTTP -> disposable PostgreSQL16/nonowner RLS. Opt-in source-pinned.
 *
 * This is real HTTP and PostgreSQL, not a mocked response or mounted browser UI.
 * Leave V1 Party privacy lockdown and React seven-role UI out of this test.
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
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { AppErrorFilter } from '../src/common/app-error.filter';
import { signToken, TEST_JWT_SECRET } from './support/auth';
import type { SeededTenant } from './support/database';
import { asTenant, prepareTestDatabase, resetDatabase, seedTenant, testPool } from './support/database';

const reactRoot = process.env['HISABIQ_REACT_SOURCE_DIR'];
const run = reactRoot ? describe : describe.skip;
const exactReactSha = 'b0def73a13ce507b2b9951947e0552f4c729ab61';
const clock = new SystemClock();
const idempotencyKey = () => Ulid.generate(clock);
const testGrants = [
  Permission.CUSTOMER_CREATE, Permission.SUPPLIER_CREATE,
  Permission.CUSTOMER_VIEW, Permission.SUPPLIER_VIEW,
  Permission.CUSTOMER_DEACTIVATE, Permission.SUPPLIER_DEACTIVATE,
];
type TradingRole = 'CUSTOMER' | 'SUPPLIER' | 'VENDOR';
type PartyStatus = 'ACTIVE' | 'INACTIVE';
interface StatusInput {
  selectedRole: TradingRole;
  version: number;
  status: PartyStatus;
}
interface StatusReceipt {
  data: { id: string; version: number; selectedRole: TradingRole; status: PartyStatus };
}
type ReactStatusWriter = (
  accessToken: string, partyId: string, input: StatusInput,
  signal?: AbortSignal, timeoutMs?: number,
) => Promise<StatusReceipt>;
let reactStatus: ReactStatusWriter;
let app: INestApplication;
let pool: pg.Pool;
let tenant: SeededTenant;
let ownerToken: string;
let signedToken: string;
let originalFetch: typeof fetch | undefined;
let originalLocation: PropertyDescriptor | undefined;
let origin = '';
let requests: Array<{ path: string; method: string | undefined }> = [];
let loseAcknowledgement = false;

function requireLocalDisposableDatabase(): void {
  const admin = process.env['ADMIN_DATABASE_URL'];
  const user = process.env['DATABASE_URL'];
  const testUrl = process.env['TEST_DATABASE_URL'];
  if (!admin || !user || !testUrl || user !== testUrl)
    throw new Error('Dedicated DATABASE_URL and TEST_DATABASE_URL are required');
  const a = new URL(admin);
  const u = new URL(user);
  if (a.protocol !== 'postgres:' || u.protocol !== 'postgres:' ||
    a.hostname !== '127.0.0.1' || u.hostname !== a.hostname ||
    a.port === '' || u.port !== a.port ||
    a.pathname !== '/sher_test' || u.pathname !== '/sher_test' ||
    a.username !== 'postgres' || u.username !== 'sher_app')
    throw new Error('Only explicit loopback disposable PostgreSQL sher_test is permitted');
}

async function restrict(permissions: readonly string[]): Promise<void> {
  await asTenant(pool, tenant.tenantId, async client => {
    await client.query('DELETE FROM role_permissions WHERE tenant_id=$1 AND role_id=$2',
      [tenant.tenantId, tenant.roleId]);
    for (const code of permissions) {
      await client.query(
        'INSERT INTO role_permissions (id,tenant_id,role_id,permission_code,created_at,updated_at,created_by,updated_by,version) VALUES ($1,$2,$3,$4,$5,$5,$6,$6,1)',
        [idempotencyKey(), tenant.tenantId, tenant.roleId, code, clock.now(), tenant.userId],
      );
    }
  });
}
async function newParty(roles: TradingRole[] = ['CUSTOMER']): Promise<string> {
  const res = await request(app.getHttpServer()).post('/api/v2/parties')
    .set({ Authorization: 'Bearer ' + ownerToken })
    .set('Idempotency-Key', idempotencyKey())
    .send({
      selectedRole: roles[0], name: 'Synthetic T21 Party',
      roles, phone: '01712345678',
      address: null, guardianName: null, nid: null, email: null, notes: null,
      customerGroupId: null, creditLimitMinor: null,
    }).expect(201);
  expect(res.body.data).toEqual({
    id: expect.any(String), version: 1, selectedRole: roles[0], status: 'ACTIVE',
  });
  return res.body.data.id as string;
}
async function row(partyId: string, who = tenant) {
  return asTenant(pool, who.tenantId, async client => {
    const result = await client.query<{status:string;version:number}>(
      'SELECT status,version FROM parties WHERE tenant_id=$1 AND id=$2',
      [who.tenantId, partyId],
    );
    return result.rows[0] ?? null;
  });
}
async function effects(who = tenant) {
  return asTenant(pool, who.tenantId, async client => {
    const count = async (table: string, where = '') => {
      const q = await client.query<{n:number}>(
        'SELECT count(*)::int AS n FROM ' + table + ' WHERE tenant_id=$1' + where,
        [who.tenantId],
      );
      return q.rows[0]!.n;
    };
    return {
      audit: await count('audit_events',
        " AND entity_type='party' AND action IN ('ACTIVATE','DEACTIVATE')"),
      outbox: await count('outbox', " AND event_type='party.status_changed'"),
      journals: await count('journal_entries'),
      journalLines: await count('journal_lines'),
      stock: await count('stock_movements'),
      cash: await count('cash_movements'),
    };
  });
}
const deactivate = (partyId: string, version: number, status: PartyStatus = 'INACTIVE',
  selectedRole: TradingRole = 'CUSTOMER', token = signedToken) =>
  reactStatus(token, partyId, { selectedRole, version, status });

run('MOD-004 T21-QA actual React status -> signed Nest -> PG16', () => {
  beforeAll(async () => {
    if (!reactRoot || !isAbsolute(reactRoot) ||
      !existsSync(join(reactRoot, 'src/integration/party-v2-status.ts')))
      throw new Error('HISABIQ_REACT_SOURCE_DIR must be an absolute React source checkout');
    const actualSha = execFileSync('git', ['-C', reactRoot, 'rev-parse', 'HEAD'],
      { encoding: 'utf8' }).trim();
    if (actualSha !== exactReactSha)
      throw new Error('Unpinned React source SHA; expected ' + exactReactSha);

    requireLocalDisposableDatabase();
    const reactModule = await import(
      /* @vite-ignore */
      pathToFileURL(join(reactRoot, 'src/integration/party-v2-status.ts')).href
    );
    if (typeof reactModule.setTradingPartyStatusV2 !== 'function')
      throw new Error('Real React status writer export missing');
    reactStatus = reactModule.setTradingPartyStatusV2 as ReactStatusWriter;

    pool = testPool();
    await prepareTestDatabase();
    const verification = await pool.query<{user_name:string;is_super:boolean;v:string}>(
      "SELECT current_user AS user_name, r.rolsuper AS is_super, current_setting('server_version_num') AS v FROM pg_roles r WHERE r.rolname = current_user",
    );
    expect(verification.rows[0]?.user_name).toBe('sher_app');
    expect(verification.rows[0]?.is_super).toBe(false);
    expect(Number(verification.rows[0]?.v)).toBeGreaterThanOrEqual(160000);
    expect(Number(verification.rows[0]?.v)).toBeLessThan(170000);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AppErrorFilter());
    await app.listen(0, '127.0.0.1');
    origin = await app.getUrl();

    originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
    Object.defineProperty(globalThis, 'location', {
      configurable: true, value: { origin },
    });
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe(origin);
      expect(url.pathname).toMatch(/^\/api\/v2\/parties\/[0-7][0-9A-HJKMNP-TV-Z]{25}\/status$/);
      expect(init?.method).toBe('POST');
      expect(init?.credentials).toBe('omit');
      expect(init?.redirect).toBe('error');
      const headers = new Headers(init?.headers);
      expect(headers.get('Idempotency-Key')).toBeNull();
      expect(headers.get('Authorization')).toMatch(/^Bearer /);
      expect(JSON.parse(String(init?.body))).toEqual({
        selectedRole: expect.stringMatching(/^(CUSTOMER|SUPPLIER|VENDOR)$/),
        version: expect.any(Number), status: expect.stringMatching(/^(ACTIVE|INACTIVE)$/),
      });
      requests.push({ path: url.pathname, method: init?.method });
      const response = await originalFetch!(input, init); // ACTUAL loopback HTTP, not a mock.
      if (loseAcknowledgement) {
        loseAcknowledgement = false;
        throw new TypeError('Synthetic lost ACK after server committed');
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
    tenant = await seedTenant(pool, { name: 'T21 PG16 test tenant A', permissions: testGrants });
    ownerToken = signToken(tenant, TEST_JWT_SECRET);
    signedToken = ownerToken;
    requests = [];
    loseAcknowledgement = false;
  });

  it('role-only Customer deactivates and reactivates over real HTTP without profile/history/VIEW', async () => {
    const partyId = await newParty();
    const before = await effects();
    await restrict([Permission.CUSTOMER_DEACTIVATE]);
    const inactive = await deactivate(partyId, 1);
    expect(inactive).toEqual({
      data: { id: partyId, version: 2, selectedRole: 'CUSTOMER', status: 'INACTIVE' },
    });
    expect(JSON.stringify(inactive)).not.toContain('Synthetic T21 Party');
    expect(await row(partyId)).toEqual({ status: 'INACTIVE', version: 2 });
    expect(await effects()).toEqual({ ...before, audit: before.audit + 1, outbox: before.outbox + 1 });
    const active = await deactivate(partyId, 2, 'ACTIVE');
    expect(active.data.version).toBe(3);
    expect(active.data.status).toBe('ACTIVE');
    expect(await effects()).toEqual({ ...before, audit: before.audit + 2, outbox: before.outbox + 2 });
    expect(requests).toHaveLength(2);
  }, 90_000);

  it('same-state no-op, stale-version conflict and concurrency never double-post', async () => {
    const partyId = await newParty();
    await restrict([Permission.CUSTOMER_DEACTIVATE]);
    const before = await effects();
    expect((await deactivate(partyId, 1, 'ACTIVE')).data.version).toBe(1);
    expect(await effects()).toEqual(before);
    const [a, b] = await Promise.allSettled([
      deactivate(partyId, 1), deactivate(partyId, 1),
    ]);
    const successes = [a, b].filter(x => x.status === 'fulfilled');
    const failures = [a, b].filter(x => x.status === 'rejected');
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ reason: { kind: 'http', status: 409 } });
    expect(await row(partyId)).toEqual({ status: 'INACTIVE', version: 2 });
    expect(await effects()).toEqual({ ...before, audit: before.audit + 1, outbox: before.outbox + 1 });
    await expect(deactivate(partyId, 1)).rejects.toMatchObject({ kind: 'http', status: 409 });
    expect((await deactivate(partyId, 2)).data.version).toBe(2);
    expect(await effects()).toEqual({ ...before, audit: before.audit + 1, outbox: before.outbox + 1 });
    expect(requests).toHaveLength(5);
  }, 90_000);

  it('shared Customer + Supplier identity requires both destructive grants without leaking Supplier role', async () => {
    const partyId = await newParty(['CUSTOMER', 'SUPPLIER']);
    const before = await effects();
    await restrict([Permission.CUSTOMER_DEACTIVATE]);
    await expect(deactivate(partyId, 1)).rejects.toMatchObject({ kind: 'http', status: 404 });
    expect(await row(partyId)).toEqual({ status: 'ACTIVE', version: 1 });
    expect(await effects()).toEqual(before);
    await restrict([Permission.CUSTOMER_DEACTIVATE, Permission.SUPPLIER_DEACTIVATE]);
    const changed = await deactivate(partyId, 1);
    expect(changed).toEqual({
      data: { id: partyId, version: 2, selectedRole: 'CUSTOMER', status: 'INACTIVE' },
    });
    expect(JSON.stringify(changed)).not.toContain('SUPPLIER');
    expect(await effects()).toEqual({ ...before, audit: before.audit + 1, outbox: before.outbox + 1 });
    expect(requests).toHaveLength(2);
  }, 90_000);

  it('signed other tenant, revoked grant and wrong selected relationship fail without mutations', async () => {
    const partyId = await newParty();
    const before = await effects();
    const second = await seedTenant(pool, {
      name: 'T21 PG16 test tenant B', permissions: [Permission.CUSTOMER_DEACTIVATE],
    });
    const secondToken = signToken(second, TEST_JWT_SECRET);
    expect(await row(partyId, second)).toBeNull();
    await expect(deactivate(partyId, 1, 'INACTIVE', 'CUSTOMER', secondToken))
      .rejects.toMatchObject({ kind: 'http', status: 404 });
    await restrict([]);
    await expect(deactivate(partyId, 1)).rejects.toMatchObject({ kind: 'http', status: 403 });
    await restrict([Permission.SUPPLIER_DEACTIVATE]);
    await expect(deactivate(partyId, 1, 'INACTIVE', 'SUPPLIER'))
      .rejects.toMatchObject({ kind: 'http', status: 404 });
    expect(await row(partyId)).toEqual({ status: 'ACTIVE', version: 1 });
    expect(await effects()).toEqual(before);
    expect(await effects(second)).toEqual({
      audit: 0, outbox: 0, journals: 0, journalLines: 0, stock: 0, cash: 0,
    });
    expect(requests).toHaveLength(3);
  }, 90_000);

  it('lost response after real server commit is unknown to client and must never auto-retry', async () => {
    const partyId = await newParty();
    const before = await effects();
    await restrict([Permission.CUSTOMER_DEACTIVATE, Permission.CUSTOMER_VIEW]);
    loseAcknowledgement = true;
    await expect(deactivate(partyId, 1)).rejects.toMatchObject({ kind: 'network' });
    expect(requests).toHaveLength(1);
    expect(await row(partyId)).toEqual({ status: 'INACTIVE', version: 2 });
    expect(await effects()).toEqual({ ...before, audit: before.audit + 1, outbox: before.outbox + 1 });
    // The only permitted recovery is an explicit authorized V2 fresh read.
    const fresh = await request(app.getHttpServer())
      .get('/api/v2/parties/' + partyId + '?role=CUSTOMER')
      .set({ Authorization: 'Bearer ' + signedToken }).expect(200);
    expect(fresh.body.data.status).toBe('INACTIVE');
    expect(fresh.body.data.version).toBe(2);
    expect(requests).toHaveLength(1);
  }, 90_000);
});
