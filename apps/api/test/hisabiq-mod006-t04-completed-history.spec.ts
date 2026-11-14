/*
 * MOD-006 T04 #146 — RED-first historical reconciliation classification.
 * Test-only: real signed Nest account and reconciliation APIs, no direct
 * account/journal fixture writes, isolated disposable PostgreSQL16 + RLS.
 *
 * @covers endpoint:POST /api/v1/money/accounts
 * @covers endpoint:PATCH /api/v1/money/accounts/:id
 * @covers endpoint:POST /api/v1/money/reconciliations
 * @covers endpoint:POST /api/v1/money/reconciliations/:id/complete
 * @covers endpoint:POST /api/v1/money/reconciliations/:id/reopen
 * @covers endpoint:GET /api/v1/money/reconciliations/:id
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
import { asTenant, prepareTestDatabase, resetDatabase, seedTenant, testPool } from './support/database';
import { assertGoldenInvariants } from './support/invariants';

const sentinel = 'MOD006_T04_COMPLETED_HISTORY_TEST_ONLY_20261114';
const dbName = 'hisabiq_mod006_t04_completed_20261114';
const dbPort = '55794';
const clock = new SystemClock();
const suite = process.env['MOD006_T04_COMPLETED_HISTORY_ONLY'] === sentinel
  ? describe : describe.skip;

const fullPermissions = [
  Permission.BANK_ACCOUNT_VIEW,
  Permission.BANK_ACCOUNT_MANAGE,
  Permission.CASH_ACCOUNT_VIEW,
  Permission.CASH_ACCOUNT_MANAGE,
  Permission.LOAN_ACCOUNT_MANAGE,
  Permission.RECONCILIATION_VIEW,
  Permission.RECONCILIATION_PERFORM,
  Permission.RECONCILIATION_REOPEN,
];

let app: INestApplication;
let pool: pg.Pool;
let tenant: SeededTenant;
let bearer: string;

const api = () => request(app.getHttpServer());
const op = () => Ulid.generate(clock);
const signed = (req: request.Test, token = bearer) =>
  req.set('Authorization', 'Bearer ' + token);

function requireDisposableDatabase(): void {
  if (process.env['MOD006_T04_COMPLETED_HISTORY_ONLY'] !== sentinel) {
    throw new Error('Explicit T04 #146 disposable-only sentinel required');
  }
  for (const field of ['DATABASE_URL', 'TEST_DATABASE_URL', 'ADMIN_DATABASE_URL']) {
    const raw = process.env[field];
    if (!raw) throw new Error('Missing explicitly isolated DB URL: ' + field);
    const url = new URL(raw);
    const role = field === 'ADMIN_DATABASE_URL' ? 'postgres' : 'sher_app';
    if (url.protocol !== 'postgres:' ||
      url.hostname !== '127.0.0.1' || url.port !== dbPort ||
      url.pathname !== '/' + dbName || url.username !== role) {
      throw new Error('Refusing unapproved database/role/port: ' + field);
    }
  }
}

type AccountType = 'BANK' | 'MFS' | 'CASH' | 'LOAN';
function accountInput(type: AccountType, name = 'Historical statement account') {
  return {
    name, type, holderName: null, reference: null,
    isDrawer: false, openingAmountMinor: 0, openingDate: null,
  };
}
async function createAccount(type: 'BANK' | 'MFS') {
  const response = await signed(api().post('/api/v1/money/accounts'))
    .send({ ...accountInput(type), operationId: op() });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return {
    id: response.body.data.id as string,
    version: response.body.data.version as number,
    type,
  };
}
async function completeZeroActivity(accountId: string) {
  // The zero-activity statement certifies a known zero closing balance, with
  // no unmatched external or internal entries. Entirely source-owned APIs.
  const operationId = op();
  const started = await signed(api().post('/api/v1/money/reconciliations'))
    .send({ accountId, fromDate: '2026-09-01', toDate: '2026-09-30', operationId });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  const reconciliationId = started.body.data.id as string;
  const completed = await signed(
    api().post('/api/v1/money/reconciliations/' + reconciliationId + '/complete'),
  ).send({
    statementClosingBalanceMinor: 0,
    note: 'Confirmed zero-activity September statement',
    version: started.body.data.version,
  });
  expect(completed.status, JSON.stringify(completed.body)).toBe(200);
  expect(completed.body.data.status).toBe('COMPLETED');
  expect(completed.body.data.summary.differenceMinor).toBe(0);
  return { reconciliationId, operationId, version: completed.body.data.version as number };
}
const patchAccount = (
  accountId: string, version: number, type: AccountType, token = bearer,
  name = 'Historical statement account',
) => signed(api().patch('/api/v1/money/accounts/' + accountId), token)
  .send({ ...accountInput(type, name), version });
const readWorkspace = (reconciliationId: string, token = bearer) =>
  signed(api().get('/api/v1/money/reconciliations/' + reconciliationId), token);

async function footprint(accountId: string) {
  return asTenant(pool, tenant.tenantId, async client => {
    const account = await client.query<{ type: AccountType }>(
      'SELECT type FROM accounts WHERE tenant_id = $1 AND id = $2',
      [tenant.tenantId, accountId],
    );
    const counts = await client.query<{
      reconciliations: number; journals: number; lines: number; sessions: number;
    }>(
      'SELECT (SELECT count(*)::int FROM account_reconciliations) AS reconciliations,' +
      ' (SELECT count(*)::int FROM journal_entries) AS journals,' +
      ' (SELECT count(*)::int FROM journal_lines) AS lines,' +
      ' (SELECT count(*)::int FROM cash_sessions) AS sessions',
    );
    return { accountType: account.rows[0]?.type, ...counts.rows[0] };
  });
}

suite('MOD-006 T04 #146 — completed bank/MFS history must not be silently reclassified', () => {
  beforeAll(async () => {
    requireDisposableDatabase(); // Must run before any migrations or fixture writes.
    pool = testPool();
    await prepareTestDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AppErrorFilter());
    await app.init();
  }, 60_000);

  afterAll(async () => { await app?.close(); await pool?.end(); });
  beforeEach(async () => {
    await resetDatabase(pool);
    tenant = await seedTenant(pool, {
      name: 'Historical bank reconciliation test-only shop',
      permissions: fullPermissions,
    });
    bearer = signToken(tenant, TEST_JWT_SECRET);
  });
  afterEach(async () => {
    if (tenant?.tenantId) await assertGoldenInvariants(pool, tenant.tenantId);
  });

  it.each([
    ['BANK', 'LOAN'],
    ['MFS', 'CASH'],
  ] as const)(
    'RED-first: completed %s statement remains historically %s-independent after proposed %s retype',
    async (initial, nextType) => {
      const account = await createAccount(initial);
      const { reconciliationId } = await completeZeroActivity(account.id);
      const before = await readWorkspace(reconciliationId);
      expect(before.status).toBe(200);
      expect(before.body.accountType).toBe(initial);
      const changed = await patchAccount(account.id, account.version, nextType);
      // Either reject the reclassification, or preserve the certified
      // historical account identity in a separately approved immutable view.
      // Do not prescribe which policy to implement in this RED-first test.
      expect([200, 400]).toContain(changed.status);
      const after = await readWorkspace(reconciliationId);
      expect(after.status, JSON.stringify(after.body)).toBe(200);
      expect(after.body.accountType).toBe(initial);
      expect(after.body.status).toBe('COMPLETED');
      expect(after.body.summary.statementClosingMinor).toBe(0);
      expect(after.body.summary.differenceMinor).toBe(0);
      expect(after.body.accountId).toBe(account.id);
      const state = await footprint(account.id);
      expect(state).toMatchObject({
        reconciliations: 1, journals: 0, lines: 0, sessions: 0,
      });
      if (changed.status === 400) expect(state.accountType).toBe(initial);
    },
  );

  it('allows a same-type metadata update without changing a completed BANK sign-off', async () => {
    const account = await createAccount('BANK');
    const { reconciliationId } = await completeZeroActivity(account.id);
    const edited = await patchAccount(
      account.id, account.version, 'BANK', bearer, 'Renamed bank account',
    );
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    const history = await readWorkspace(reconciliationId);
    expect(history.status).toBe(200);
    expect(history.body.accountType).toBe('BANK');
    expect(history.body.status).toBe('COMPLETED');
    expect(await footprint(account.id)).toMatchObject({
      accountType: 'BANK', reconciliations: 1, journals: 0, lines: 0, sessions: 0,
    });
  });

  it('rejects account retype after reopening a completed reconciliation as DRAFT', async () => {
    const account = await createAccount('BANK');
    const { reconciliationId, version } = await completeZeroActivity(account.id);
    const reopened = await signed(
      api().post('/api/v1/money/reconciliations/' + reconciliationId + '/reopen'),
    ).send({ reason: 'Review historical statement', version });
    expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);
    expect(reopened.body.data.status).toBe('DRAFT');
    const retype = await patchAccount(account.id, account.version, 'LOAN');
    expect(retype.status, JSON.stringify(retype.body)).toBe(400);
    expect(await footprint(account.id)).toMatchObject({
      accountType: 'BANK', reconciliations: 1, journals: 0, lines: 0, sessions: 0,
    });
  });

  it('keeps another tenant from reading or retyping the completed account', async () => {
    const account = await createAccount('BANK');
    const { reconciliationId } = await completeZeroActivity(account.id);
    const other = await seedTenant(pool, {
      name: 'Another isolated shop', permissions: fullPermissions,
    });
    const otherToken = signToken(other, TEST_JWT_SECRET);
    const read = await readWorkspace(reconciliationId, otherToken);
    const change = await patchAccount(account.id, account.version, 'LOAN', otherToken);
    expect(read.status).toBe(404);
    expect(change.status).toBe(404);
    expect(await footprint(account.id)).toMatchObject({
      accountType: 'BANK', reconciliations: 1, journals: 0, lines: 0, sessions: 0,
    });
  });

  it('denies reconciliation reads without view permission', async () => {
    const account = await createAccount('BANK');
    const { reconciliationId } = await completeZeroActivity(account.id);
    const noAccess = await seedTenant(pool, {
      name: 'No reconciliation permission shop', permissions: [],
    });
    const refused = await readWorkspace(
      reconciliationId, signToken(noAccess, TEST_JWT_SECRET),
    );
    expect(refused.status).toBe(403);
  });
});
