/*
 * MOD-006 #84 / T01 — RED-first, test-only opening-correction vs counted cash.
 * Opt-in; never point this suite at retained databases or disable its URL guard.
 * All business documents are created through signed Nest HTTP, not SQL fixtures.
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
const sentinel = 'MOD006_T01_OPENING_COUNTED_20261115';
const dbName = 'hisabiq_mod006_opening_counted_20261115';
const dbPort = '55796';
const suite = process.env['MOD006_T01_OPENING_COUNTED_TEST_ONLY'] === sentinel
  ? describe : describe.skip;
const openingDate = '2026-01-01';

let app: INestApplication;
let pool: pg.Pool;
let tenant: SeededTenant;
let token: string;
let cashId: string;
let cashVersion: number;
let bankId: string;
let bankVersion: number;
let day: string;
let sessionId: string;

function requireDisposable(): void {
  if (process.env['MOD006_T01_OPENING_COUNTED_TEST_ONLY'] !== sentinel) {
    throw new Error('Explicit one-use opening-correction test sentinel required');
  }
  for (const key of ['DATABASE_URL', 'TEST_DATABASE_URL', 'ADMIN_DATABASE_URL']) {
    const raw = process.env[key];
    if (!raw) throw new Error('Missing isolated ' + key);
    const url = new URL(raw);
    const requiredUser = key === 'ADMIN_DATABASE_URL' ? 'postgres' : 'sher_app';
    if (url.protocol !== 'postgres:' ||
        url.hostname !== '127.0.0.1' ||
        url.port !== dbPort ||
        url.pathname !== '/' + dbName ||
        url.username !== requiredUser) {
      throw new Error('Refusing non-disposable opening-correction database URL');
    }
  }
}

const api = (): ReturnType<typeof request> => request(app.getHttpServer());
const signed = (r: request.Test): request.Test =>
  r.set('Authorization', 'Bearer ' + token);
function expectStatus(r: request.Response, status: number): void {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
}

interface Snapshot {
  readonly cash: string;
  readonly sessions: unknown[];
  readonly closes: unknown[];
  readonly accounts: unknown[];
  readonly entries: unknown[];
  readonly lines: unknown[];
}

async function snapshot(): Promise<Snapshot> {
  return asTenant(pool, tenant.tenantId, async (db) => {
    const [accounts, sessions, closes, entries, lines, sum] = await Promise.all([
      db.query('SELECT id, type, is_drawer, status, version, opening_amount_minor::text, opening_date FROM accounts ORDER BY id'),
      db.query('SELECT id, account_id, status, business_date, version FROM cash_sessions ORDER BY id'),
      db.query('SELECT id, session_id, status, expected_closing_minor::text, counted_closing_minor::text FROM cash_session_closes ORDER BY id'),
      db.query('SELECT id, business_date, source_document_type, source_document_id FROM journal_entries ORDER BY id'),
      db.query('SELECT id, journal_entry_id, account_code, amount_minor::text FROM journal_lines ORDER BY id'),
      db.query<{ total: string }>(
        'SELECT COALESCE(SUM(jl.amount_minor), 0)::text AS total ' +
        'FROM journal_lines jl INNER JOIN journal_entries je ON je.id = jl.journal_entry_id ' +
        'WHERE jl.account_code = $1 AND je.business_date <= $2',
        ['CASH:' + cashId, day],
      ),
    ]);
    return {
      cash: sum.rows[0]?.total ?? '',
      sessions: sessions.rows, closes: closes.rows, accounts: accounts.rows,
      entries: entries.rows, lines: lines.rows,
    };
  });
}

function accountInput(type: 'CASH' | 'BANK', openingAmountMinor: number, isDrawer: boolean) {
  return {
    name: type === 'CASH' ? 'Original counted till' : 'Bank control',
    type, holderName: null, reference: null, isDrawer, openingAmountMinor, openingDate,
  };
}

suite('MOD-006 #84: historical account opening correction versus counted cash close', () => {
  beforeAll(async () => {
    requireDisposable(); // MUST precede migrations, reset or fixture writes.
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
      name: 'Opening correction historical count synthetic shop',
      permissions: [
        Permission.CASH_ACCOUNT_VIEW, Permission.CASH_ACCOUNT_MANAGE,
        Permission.BANK_ACCOUNT_VIEW, Permission.BANK_ACCOUNT_MANAGE,
        Permission.CASH_SESSION_START, Permission.CASH_SESSION_CLOSE,
        Permission.CASH_DAILY_VIEW, Permission.CASH_MOVEMENT_RECORD,
      ],
    });
    token = signToken(tenant, TEST_JWT_SECRET);
    day = todayIn(tenant.timezone);

    const cash = await signed(api().post('/api/v1/money/accounts')).send({
      ...accountInput('CASH', 100_000, true),
      operationId: Ulid.generate(clock),
    });
    expectStatus(cash, 201);
    cashId = cash.body.data.id as string;
    cashVersion = cash.body.data.version as number;

    const bank = await signed(api().post('/api/v1/money/accounts')).send({
      ...accountInput('BANK', 50_000, false),
      operationId: Ulid.generate(clock),
    });
    expectStatus(bank, 201);
    bankId = bank.body.data.id as string;
    bankVersion = bank.body.data.version as number;
  });

  afterEach(async () => {
    await assertGoldenInvariants(pool, tenant.tenantId);
  });

  it('CONTROL: historical CASH opening correction before any cash day is permitted without a session', async () => {
    const update = await signed(api().patch('/api/v1/money/accounts/' + cashId)).send({
      ...accountInput('CASH', 105_000, true), version: cashVersion,
    });
    expectStatus(update, 200);
    const after = await snapshot();
    expect(after.cash).toBe('105000');
    expect(after.sessions).toHaveLength(0);
    expect(after.closes).toHaveLength(0);
  });

  async function closeCountedDay(): Promise<void> {
    const started = await signed(api().post('/api/v1/money/day/start')).send({
      businessDate: day, openingAmountMinor: 100_000,
      counterpartAccountCode: null, note: null, operationId: Ulid.generate(clock),
    });
    expectStatus(started, 201);
    sessionId = started.body.data.id as string;

    const transferred = await signed(api().post('/api/v1/money/movements')).send({
      kind: 'TRANSFER', fromAccountCode: 'CASH:' + cashId,
      toAccountCode: 'BANK:' + bankId, amountMinor: 25_000,
      businessDate: day, reference: null, note: null, operationId: Ulid.generate(clock),
    });
    expectStatus(transferred, 201);

    const closed = await signed(api().post('/api/v1/money/day/' + sessionId + '/close')).send({
      countedClosingMinor: 75_000, reason: null, operationId: Ulid.generate(clock),
    });
    expectStatus(closed, 201);
    expect(closed.body.data.status).toBe('CLOSED');
  }

  it('RED: later counted CASH close cannot be restated by correcting an earlier opening date', async () => {
    await closeCountedDay();
    const before = await snapshot();
    expect(before.cash).toBe('75000');
    expect(before.closes).toHaveLength(1);

    const corrected = await signed(api().patch('/api/v1/money/accounts/' + cashId)).send({
      ...accountInput('CASH', 105_000, true), version: cashVersion,
    });

    // A valid alternative is an explicit approved later-dated correction,
    // but silently accepting an earlier-dated delta here is NOT acceptable.
    expectStatus(corrected, 400);
    expect(await snapshot()).toEqual(before);
  });

  it('CONTROL: correcting unrelated BANK opening does not restate counted CASH', async () => {
    await closeCountedDay();
    const before = await snapshot();
    expect(before.cash).toBe('75000');

    const corrected = await signed(api().patch('/api/v1/money/accounts/' + bankId)).send({
      ...accountInput('BANK', 55_000, false), version: bankVersion,
    });
    expectStatus(corrected, 200);

    const after = await snapshot();
    expect(after.cash).toBe('75000');
    expect(after.closes).toEqual(before.closes);
    expect(after.sessions).toEqual(before.sessions);
  });
});
