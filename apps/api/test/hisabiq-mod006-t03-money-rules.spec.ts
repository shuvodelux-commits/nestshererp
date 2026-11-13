/*
 * MOD-006 T03 Super Build — isolated signed Nest/PostgreSQL16 money-rule audit.
 * The accepted v1 contract makes LOAN a lender liability, never cash or an
 * asset. Misclassified movement directions are RED-first acceptance tests.
 *
 * This spec never connects to retained databases and never injects journals.
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
  asTenant, prepareTestDatabase, resetDatabase, seedTenant, testPool, todayIn,
} from './support/database';
import { assertGoldenInvariants } from './support/invariants';

const clock = new SystemClock();
const dbName = 'hisabiq_mod006_t03_rules_20261113';
const port = '55731';
const sentinel = 'MOD006_T03_RULES_DISPOSABLE_ONLY_20261113';
const suite = process.env['MOD006_T03_RULES_TEST_ONLY'] === sentinel ? describe : describe.skip;
let app: INestApplication;
let pool: pg.Pool;
let tenant: SeededTenant;
let token: string;
let day: string;
let bank: string;
let mfs: string;
let loan: string;
const api = (): ReturnType<typeof request> => request(app.getHttpServer());
const signed = (r: request.Test): request.Test =>
  r.set('Authorization', 'Bearer ' + token);
const op = (): string => Ulid.generate(clock);

function assertOnlyDisposable(): void {
  if (process.env['MOD006_T03_RULES_TEST_ONLY'] !== sentinel) {
    throw new Error('T03 rules require a unique test-only sentinel');
  }
  for (const key of ['DATABASE_URL', 'TEST_DATABASE_URL', 'ADMIN_DATABASE_URL']) {
    const raw = process.env[key];
    if (!raw) throw new Error('Missing explicit test URL: ' + key);
    const url = new URL(raw);
    if (url.protocol !== 'postgres:' || url.hostname !== '127.0.0.1' ||
        url.port !== port || url.pathname !== '/' + dbName ||
        url.username !== (key === 'ADMIN_DATABASE_URL' ? 'postgres' : 'sher_app')) {
      throw new Error('Refusing any non-disposable database or role');
    }
  }
}

type Kind = 'TRANSFER' | 'OWNER_INJECTION' | 'OWNER_WITHDRAWAL' |
  'LOAN_RECEIVED' | 'LOAN_REPAYMENT';
function movement(
  kind: Kind, fromAccountCode: string, toAccountCode: string,
  amountMinor: number, operationId = op(),
): request.Test {
  return signed(api().post('/api/v1/money/movements')).send({
    kind, fromAccountCode, toAccountCode, amountMinor,
    businessDate: day, reference: null, note: 'T03 business-rule test', operationId,
  });
}
async function create(name: string, type: 'BANK' | 'MFS' | 'LOAN', amount: number): Promise<string> {
  const r = await signed(api().post('/api/v1/money/accounts')).send({
    name, type, isDrawer: false, holderName: null, reference: null,
    openingAmountMinor: amount, openingDate: amount > 0 ? '2026-01-01' : null,
    operationId: op(),
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return (type + ':' + r.body.data.id) as string;
}
async function state(): Promise<{
  totals: Record<string, number>; movementCount: number; journalCount: number;
  auditCount: number; sessionCount: number;
}> {
  return asTenant(pool, tenant.tenantId, async (db) => {
    const rows = await db.query<{ account_code: string; total: string }>(
      'SELECT account_code, SUM(amount_minor)::bigint AS total ' +
      'FROM journal_lines GROUP BY account_code',
    );
    const counts = await db.query<{
      movement_count: number; journal_count: number; audit_count: number; session_count: number;
    }>(
      'SELECT (SELECT COUNT(*)::int FROM cash_movements) AS movement_count, ' +
      '(SELECT COUNT(*)::int FROM journal_entries) AS journal_count, ' +
      '(SELECT COUNT(*)::int FROM audit_events) AS audit_count, ' +
      '(SELECT COUNT(*)::int FROM cash_sessions) AS session_count',
    );
    const count = counts.rows[0]!;
    return {
      totals: Object.fromEntries(rows.rows.map(x => [x.account_code, Number(x.total)])),
      movementCount: count.movement_count, journalCount: count.journal_count,
      auditCount: count.audit_count, sessionCount: count.session_count,
    };
  });
}

suite('MOD-006 T03: trading money, owner funds and lender liabilities', () => {
  beforeAll(async () => {
    assertOnlyDisposable(); // Run BEFORE schema, fixture or accounting writes.
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
      name: 'T03 rules synthetic shop',
      permissions: [
        Permission.CASH_ACCOUNT_VIEW, Permission.CASH_ACCOUNT_MANAGE,
        Permission.BANK_ACCOUNT_VIEW, Permission.BANK_ACCOUNT_MANAGE,
        Permission.LOAN_ACCOUNT_MANAGE, Permission.LOAN_MOVEMENT_RECORD,
        Permission.CASH_MOVEMENT_RECORD, Permission.CASH_MOVEMENT_VOID,
        Permission.OWNER_CAPITAL_RECORD, Permission.SETTING_TOGGLE,
      ],
    });
    token = signToken(tenant, TEST_JWT_SECRET);
    day = todayIn(tenant.timezone);
    const enabled = await signed(api().post('/api/v1/settings/value'))
      .send({ key: 'bank_accounts_enabled', value: 'on' });
    expect(enabled.status, JSON.stringify(enabled.body)).toBe(201);
    bank = await create('Operating bank', 'BANK', 200_000);
    mfs = await create('Mobile wallet', 'MFS', 20_000);
    loan = await create('Loan from lender', 'LOAN', 0);
  });
  afterEach(async () => {
    if (tenant?.tenantId) await assertGoldenInvariants(pool, tenant.tenantId);
  });

  it('moves bank funds to MFS without a cash session or profit-and-loss posting', async () => {
    const start = await state();
    const r = await movement('TRANSFER', bank, mfs, 35_000);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const after = await state();
    expect(after.totals[bank]).toBe(165_000);
    expect(after.totals[mfs]).toBe(55_000);
    expect(after.totals.SALES ?? 0).toBe(0);
    expect(after.totals.CASH_SHORT_OVER ?? 0).toBe(0);
    expect(after.movementCount).toBe(start.movementCount + 1);
    expect(after.journalCount).toBe(start.journalCount + 1);
    expect(after.sessionCount).toBe(0);
    const linked = await asTenant(pool, tenant.tenantId, db =>
      db.query<{ session_id: string | null }>('SELECT session_id FROM cash_movements'));
    expect(linked.rows).toEqual([{ session_id: null }]);
  });

  it('rejects invalid movement shape, identity, date and family with zero writes', async () => {
    const bad = [
      () => movement('TRANSFER', bank, bank, 500),
      () => movement('TRANSFER', bank, mfs, 0),
      () => movement('TRANSFER', bank, mfs, -5),
      () => movement('TRANSFER', 'OWNER_CURRENT_ACCOUNT', bank, 100),
      () => movement('TRANSFER', loan, bank, 100),
      () => movement('TRANSFER', 'EXPENSE:RENT', bank, 100),
    ];
    const before = await state();
    for (const attempt of bad) {
      const r = await attempt();
      expect(r.status, JSON.stringify(r.body)).toBe(400);
      expect(await state()).toEqual(before);
    }
  });

  it('separates owner injection and withdrawal from revenue and expense', async () => {
    const injected = await movement('OWNER_INJECTION', 'OWNER_CURRENT_ACCOUNT', bank, 60_000);
    expect(injected.status, JSON.stringify(injected.body)).toBe(201);
    const withdrawn = await movement('OWNER_WITHDRAWAL', bank, 'OWNER_CURRENT_ACCOUNT', 12_000);
    expect(withdrawn.status, JSON.stringify(withdrawn.body)).toBe(201);
    const snapshot = await state();
    expect(snapshot.totals[bank]).toBe(248_000);
    expect(snapshot.totals.OWNER_CURRENT_ACCOUNT).toBe(-48_000);
    expect(snapshot.totals.SALES ?? 0).toBe(0);
    expect(snapshot.totals['EXPENSE:RENT'] ?? 0).toBe(0);
    expect(snapshot.sessionCount).toBe(0);
  });

  it('keeps a lender loan negative as a liability through receipt and principal repayment', async () => {
    const received = await movement('LOAN_RECEIVED', loan, bank, 80_000);
    expect(received.status, JSON.stringify(received.body)).toBe(201);
    const repaid = await movement('LOAN_REPAYMENT', bank, loan, 30_000);
    expect(repaid.status, JSON.stringify(repaid.body)).toBe(201);
    const snapshot = await state();
    expect(snapshot.totals[loan]).toBe(-50_000);
    expect(snapshot.totals[bank]).toBe(250_000);
    expect(snapshot.totals.SALES ?? 0).toBe(0);
    expect(snapshot.sessionCount).toBe(0);
    const accounts = await signed(api().get('/api/v1/money/accounts'));
    expect(accounts.status).toBe(200);
    expect(accounts.body.totalLoanMinor).toBe(50_000);
    expect(accounts.body.totalBankMinor).toBe(250_000);
  });

  it('replays an identical transfer once and refuses changed-body reuse', async () => {
    const operationId = op();
    const first = await movement('TRANSFER', bank, mfs, 500, operationId);
    expect(first.status).toBe(201);
    const before = await state();
    const retry = await movement('TRANSFER', bank, mfs, 500, operationId);
    expect(retry.status).toBe(201);
    expect(retry.body.data.id).toBe(first.body.data.id);
    expect(await state()).toEqual(before);
    const tampered = await movement('TRANSFER', bank, mfs, 600, operationId);
    expect(tampered.status).toBeGreaterThanOrEqual(400);
    expect(tampered.body.error?.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await state()).toEqual(before);
  });

  it('RED: prevents reversing loan receipt direction into a lender asset', async () => {
    const before = await state();
    const wrong = await movement('LOAN_RECEIVED', bank, loan, 12_000);
    expect(wrong.status, JSON.stringify(wrong.body)).toBe(400);
    expect(await state()).toEqual(before);
  });

  it('RED: refuses principal repayment greater than the outstanding lender debt', async () => {
    const receipt = await movement('LOAN_RECEIVED', loan, bank, 20_000);
    expect(receipt.status).toBe(201);
    const before = await state();
    const excess = await movement('LOAN_REPAYMENT', bank, loan, 20_001);
    expect(excess.status, JSON.stringify(excess.body)).toBe(400);
    expect(await state()).toEqual(before);
  });
});
