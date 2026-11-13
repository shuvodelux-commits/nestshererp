/*
 * MOD-006 T03 RED-first cash mode acceptance. TEST ONLY, never production.
 * @covers endpoint:POST /api/v1/money/movements
 * @covers endpoint:POST /api/v1/money/accounts
 * @covers endpoint:POST /api/v1/settings/value
 * @covers workflow:transfer
 *
 * Opt-in only against an explicitly named, disposable PostgreSQL16 instance.
 * The OFF-mode assertion intentionally fails until its owning writer is fixed.
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
const requiredName = 'hisabiq_mod006_cashoff_t03_20261113';
const requiredPort = '55692';
const sentinel = 'MOD006_T03_ONLY_DISPOSABLE_20261113';
const enabled = process.env['MOD006_T03_TEST_ONLY'] === sentinel;
const suite = enabled ? describe : describe.skip;
const openingDate = '2026-01-01';

let app: INestApplication;
let pool: pg.Pool;
let tenant: SeededTenant;
let token: string;
let cash: string;
let bank: string;
let day: string;

const permissions = [
  Permission.CASH_ACCOUNT_VIEW, Permission.CASH_ACCOUNT_MANAGE,
  Permission.BANK_ACCOUNT_VIEW, Permission.BANK_ACCOUNT_MANAGE,
  Permission.CASH_SESSION_START, Permission.CASH_DAILY_VIEW,
  Permission.CASH_MOVEMENT_RECORD,
  Permission.SETTING_VIEW, Permission.SETTING_TOGGLE,
];

function assertDisposable(): void {
  if (process.env['MOD006_T03_TEST_ONLY'] !== sentinel) throw new Error('Opt-in required');
  for (const key of ['DATABASE_URL', 'TEST_DATABASE_URL', 'ADMIN_DATABASE_URL'] as const) {
    const value = process.env[key];
    if (!value) throw new Error('Missing dedicated DB URL: ' + key);
    const url = new URL(value);
    if (url.protocol !== 'postgres:' || url.hostname !== '127.0.0.1' ||
        url.port !== requiredPort || url.pathname !== '/' + requiredName)
      throw new Error('Refusing any DB other than the exact disposable T03 database');
    const expectedUser = key === 'ADMIN_DATABASE_URL' ? 'postgres' : 'sher_app';
    if (url.username !== expectedUser) throw new Error('Refusing DB role for ' + key);
  }
}
const api = (): ReturnType<typeof request> => request(app.getHttpServer());
const authenticated = (r: request.Test): request.Test =>
  r.set('Authorization', 'Bearer ' + token);
function expectCreated(r: request.Response): void {
  expect(r.status, JSON.stringify(r.body)).toBe(201);
}
async function createAccount(name: string, type: 'CASH' | 'BANK',
  isDrawer: boolean, openingAmountMinor: number): Promise<string> {
  const r = await authenticated(api().post('/api/v1/money/accounts')).send({
    name, type, holderName: null, reference: null, isDrawer,
    openingAmountMinor, openingDate, operationId: Ulid.generate(clock),
  });
  expectCreated(r);
  return r.body.data.id as string;
}
async function toggle(value: 'on' | 'off'): Promise<void> {
  const r = await authenticated(api().post('/api/v1/settings/value'))
    .send({ key: 'cash_session_enabled', value });
  expectCreated(r);
}
function movement(from: string, to: string, operationId = Ulid.generate(clock)): request.Test {
  return authenticated(api().post('/api/v1/money/movements')).send({
    kind: 'TRANSFER', fromAccountCode: from, toAccountCode: to,
    amountMinor: 25_000, businessDate: day,
    reference: null, note: 'Disposable MOD006 cash mode acceptance', operationId,
  });
}
async function snapshot(): Promise<{
  totals: Record<string, number>;
  movementCount: number;
  sessionCount: number;
  journalCount: number;
}> {
  return asTenant(pool, tenant.tenantId, async (db) => {
    const journal = await db.query<{account_code: string; total: string}>(
      'SELECT account_code, SUM(amount_minor)::bigint AS total FROM journal_lines GROUP BY account_code',
    );
    const transfers = await db.query<{n: string}>('SELECT COUNT(*)::text AS n FROM cash_movements');
    const sessions = await db.query<{n: string}>('SELECT COUNT(*)::text AS n FROM cash_sessions');
    const entries = await db.query<{n: string}>('SELECT COUNT(*)::text AS n FROM journal_entries');
    return {
      totals: Object.fromEntries(journal.rows.map((r) => [r.account_code, Number(r.total)])),
      movementCount: Number(transfers.rows[0]?.n ?? 0),
      sessionCount: Number(sessions.rows[0]?.n ?? 0),
      journalCount: Number(entries.rows[0]?.n ?? 0),
    };
  });
}

suite('MOD-006 T03: designated drawer money transfers in ON and OFF modes', () => {
  beforeAll(async () => {
    assertDisposable(); // BEFORE migration, reset, tenant seed or journal write
    pool = testPool();
    await prepareTestDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AppErrorFilter());
    await app.init();
  }, 60000);
  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });
  beforeEach(async () => {
    await resetDatabase(pool); // guard above already validated exact fresh DB
    tenant = await seedTenant(pool, { name: 'T03 disposable shop', permissions });
    token = signToken(tenant, TEST_JWT_SECRET);
    day = todayIn(tenant.timezone);
    cash = 'CASH:' + await createAccount('Tracked counter', 'CASH', true, 100_000);
    bank = 'BANK:' + await createAccount('Current bank', 'BANK', false, 60_000);
  });
  afterEach(async () => {
    await assertGoldenInvariants(pool, tenant.tenantId);
  });

  it('ON: rejects drawer transfer without eligible OPEN day and changes no journal', async () => {
    const before = await snapshot();
    const attempted = await movement(cash, bank);
    expect(attempted.status).toBe(400);
    expect(attempted.body.error?.code).toBe('VALIDATION_FAILED');
    expect(await snapshot()).toEqual(before);
  });

  it('ON: accepts designated drawer transfer when the same day is OPEN', async () => {
    const started = await authenticated(api().post('/api/v1/money/day/start')).send({
      businessDate: day, openingAmountMinor: 100_000,
      counterpartAccountCode: null, note: null, operationId: Ulid.generate(clock),
    });
    expectCreated(started);
    const transferred = await movement(cash, bank);
    expectCreated(transferred);
    const state = await snapshot();
    expect(state.totals[cash]).toBe(75_000);
    expect(state.totals[bank]).toBe(85_000);
    expect(state.movementCount).toBe(1);
    const row = await asTenant(pool, tenant.tenantId, (db) =>
      db.query<{session_id: string | null}>('SELECT session_id FROM cash_movements'));
    expect(row.rows[0]?.session_id).toBe(started.body.data.id);
  });

  it('OFF: posts exact balanced drawer transfer with NULL session and idempotent retry', async () => {
    await toggle('off');
    const before = await snapshot();
    expect(before.sessionCount).toBe(0);
    const operationId = Ulid.generate(clock);
    const result = await movement(cash, bank, operationId);
    // RED first: current CashMovementService requires an OPEN session even with feature OFF.
    expect(result.status, JSON.stringify(result.body)).toBe(201);
    const retry = await movement(cash, bank, operationId);
    expectCreated(retry);
    expect(retry.body.data?.id).toBe(result.body.data?.id);
    const after = await snapshot();
    expect(after.totals[cash]).toBe(75_000);
    expect(after.totals[bank]).toBe(85_000);
    expect(after.movementCount).toBe(1);
    expect(after.sessionCount).toBe(0);
    expect(after.journalCount).toBe(before.journalCount + 1);
    const rows = await asTenant(pool, tenant.tenantId, (db) =>
      db.query<{session_id: string | null}>('SELECT session_id FROM cash_movements'));
    expect(rows.rows).toEqual([{ session_id: null }]);
  });

  it('ON: ordinary bank-to-bank transfer remains session independent', async () => {
    const otherBank = 'BANK:' + await createAccount('Savings bank', 'BANK', false, 40_000);
    const before = await snapshot();
    const response = await movement(bank, otherBank);
    expectCreated(response);
    const after = await snapshot();
    expect(after.totals[bank]).toBe(35_000);
    expect(after.totals[otherBank]).toBe(65_000);
    expect(after.movementCount).toBe(1);
    expect(after.sessionCount).toBe(0);
    expect(after.journalCount).toBe(before.journalCount + 1);
  });
});
