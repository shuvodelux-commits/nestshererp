/*
 * MOD-006 T04 — Bank and MFS reconciliations must never treat a lender
 * liability or any physical/nonphysical CASH account as a bank statement.
 * RED-first opt-in Nest/PostgreSQL16. No direct journal fixture writes.
 *
 * @covers endpoint:POST /api/v1/money/accounts
 * @covers endpoint:POST /api/v1/money/reconciliations
 * @covers endpoint:GET /api/v1/money/reconciliations
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

const sentinel = 'MOD006_T04_RECON_TYPE_DISPOSABLE_20261113';
const dbName = 'hisabiq_mod006_recon_type_t04_20261113';
const dbPort = '55727';
const clock = new SystemClock();
const suite = process.env['MOD006_T04_RECON_TYPE_TEST_ONLY'] === sentinel
  ? describe : describe.skip;

let app: INestApplication;
let pool: pg.Pool;
let tenant: SeededTenant;
let bearerToken: string;

function assertDisposable(): void {
  if (process.env['MOD006_T04_RECON_TYPE_TEST_ONLY'] !== sentinel) {
    throw new Error('Missing T04 account-type test opt-in');
  }
  for (const field of ['DATABASE_URL', 'TEST_DATABASE_URL', 'ADMIN_DATABASE_URL']) {
    const raw = process.env[field];
    if (!raw) throw new Error('Missing test DB URL: ' + field);
    const url = new URL(raw);
    const expectedRole = field === 'ADMIN_DATABASE_URL' ? 'postgres' : 'sher_app';
    if (url.protocol !== 'postgres:' || url.hostname !== '127.0.0.1' ||
        url.port !== dbPort || url.pathname !== '/' + dbName ||
        url.username !== expectedRole) {
      throw new Error('Refusing non-disposable DB: ' + field);
    }
  }
}

const api = () => request(app.getHttpServer());
async function createAccount(type: 'BANK' | 'MFS' | 'CASH' | 'LOAN'): Promise<string> {
  const created = await api().post('/api/v1/money/accounts')
    .set('Authorization', 'Bearer ' + bearerToken)
    .send({
      name: 'T04 ' + type + ' source', type,
      holderName: null, reference: null, isDrawer: false,
      openingAmountMinor: 0, openingDate: null, operationId: Ulid.generate(clock),
    });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.data.id as string;
}
function postRecon(accountId: string) {
  return api().post('/api/v1/money/reconciliations')
    .set('Authorization', 'Bearer ' + bearerToken)
    .send({
      accountId, fromDate: '2026-08-01', toDate: '2026-08-31',
      operationId: Ulid.generate(clock),
    });
}
async function footprint() {
  return asTenant(pool, tenant.tenantId, async (db) => {
    const counts = await db.query(
      'SELECT (SELECT count(*)::int FROM journal_entries) AS journal_entries,' +
      ' (SELECT count(*)::int FROM journal_lines) AS journal_lines,' +
      ' (SELECT count(*)::int FROM cash_sessions) AS cash_sessions,' +
      ' (SELECT count(*)::int FROM account_reconciliations) AS reconciliations',
    );
    return counts.rows[0] as {
      journal_entries: number; journal_lines: number;
      cash_sessions: number; reconciliations: number;
    };
  });
}

suite('MOD-006 T04 bank/MFS-only reconciliation account controls', () => {
  beforeAll(async () => {
    assertDisposable();
    pool = testPool();
    await prepareTestDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AppErrorFilter());
    await app.init();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    tenant = await seedTenant(pool, {
      name: 'MOD006 T04 account type shop',
      permissions: [
        Permission.BANK_ACCOUNT_VIEW, Permission.BANK_ACCOUNT_MANAGE,
        Permission.CASH_ACCOUNT_VIEW, Permission.CASH_ACCOUNT_MANAGE,
        Permission.LOAN_ACCOUNT_MANAGE,
        Permission.RECONCILIATION_VIEW, Permission.RECONCILIATION_PERFORM,
      ],
    });
    bearerToken = signToken(tenant, TEST_JWT_SECRET);
  });

  afterEach(async () => {
    await assertGoldenInvariants(pool, tenant.tenantId);
  });

  it('permits BANK statement reconciliation with no physical cash day or journal mutation', async () => {
    const accountId = await createAccount('BANK');
    const response = await postRecon(accountId);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.data.accountId).toBe(accountId);
    expect(response.body.data.accountType).toBe('BANK');
    expect(await footprint()).toEqual({
      journal_entries: 0, journal_lines: 0, cash_sessions: 0, reconciliations: 1,
    });
  });

  it('permits MFS statement reconciliation as a distinct account, without a cash session', async () => {
    const accountId = await createAccount('MFS');
    const response = await postRecon(accountId);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.data.accountId).toBe(accountId);
    expect(response.body.data.accountType).toBe('MFS');
    expect(await footprint()).toEqual({
      journal_entries: 0, journal_lines: 0, cash_sessions: 0, reconciliations: 1,
    });
  });

  it('rejects LOAN lender liabilities as bank statements without misclassifying loan as BANK', async () => {
    const accountId = await createAccount('LOAN');
    const before = await footprint();
    const response = await postRecon(accountId);
    // RED-first: the current source excludes CASH only and casts LOAN as BANK.
    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(response.body.error?.code).toBe('VALIDATION_FAILED');
    expect(await footprint()).toEqual(before);
  });

  it('rejects ordinary non-drawer CASH accounts, not only the physical till', async () => {
    const accountId = await createAccount('CASH');
    const before = await footprint();
    const response = await postRecon(accountId);
    expect(response.status).toBe(400);
    expect(await footprint()).toEqual(before);
  });

  it('rejecting a lender leaves an unrelated BANK account free to reconcile', async () => {
    const loan = await createAccount('LOAN');
    const bank = await createAccount('BANK');
    const refused = await postRecon(loan);
    expect(refused.status).toBe(400);
    const accepted = await postRecon(bank);
    expect(accepted.status).toBe(201);
    const list = await api().get('/api/v1/money/reconciliations')
      .set('Authorization', 'Bearer ' + bearerToken);
    expect(list.status).toBe(200);
    expect(list.body.rows.map((r: { accountId: string }) => r.accountId)).toEqual([bank]);
    expect(await footprint()).toEqual({
      journal_entries: 0, journal_lines: 0, cash_sessions: 0, reconciliations: 1,
    });
  });

  it('concurrent starts for the same BANK account produce one draft and no internal error', async () => {
    const bank = await createAccount('BANK');
    const attempts = await Promise.all(Array.from({ length: 5 }, () => postRecon(bank)));
    const statusCodes = attempts.map((r) => r.status);
    expect(statusCodes.filter((status) => status === 201)).toHaveLength(1);
    expect(statusCodes.filter((status) => status === 400)).toHaveLength(4);
    expect(await footprint()).toEqual({
      journal_entries: 0, journal_lines: 0, cash_sessions: 0, reconciliations: 1,
    });
  });
});
