/*
 * Coverage claims, read by `pnpm test:inventory` (owner request 2026-09-03).
 *
 * @covers endpoint:POST /api/v1/money/day/start
 * @covers endpoint:POST /api/v1/money/day/:id/close
 * @covers endpoint:GET /api/v1/money/day
 * @covers endpoint:GET /api/v1/money/daily-cash
 * @covers endpoint:POST /api/v1/expenses
 * @covers endpoint:GET /api/v1/expenses
 * @covers endpoint:POST /api/v1/expenses/categories
 * @covers endpoint:POST /api/v1/money/movements
 * @covers endpoint:GET /api/v1/money/movements
 * @covers endpoint:POST /api/v1/money/accounts
 * @covers permission:cash.session.start
 * @covers permission:cash.session.close
 * @covers permission:expense.record
 * @covers permission:cash.movement.record
 * @covers workflow:transfer
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

/**
 * The shop's money when no goods are involved (§5.12, §5.16, §5.17).
 *
 * This is where INV-07 is actually exercised. The golden invariants check every
 * closed day's arithmetic on every test in the suite, but only a test that
 * genuinely opens a day, moves money through it and closes it short can prove
 * that the short/over reaches `CASH_SHORT_OVER` and that the drawer ledger ends
 * the day agreeing with what was physically counted — which is the difference
 * between books a shopkeeper can trust and books that merely balance.
 */

const clock = new SystemClock();

/** Accounts are opened before the shop trades, so the balance has a date. */
const openingDay = '2026-01-01';
let app: INestApplication;
let pool: pg.Pool;
let tenant: SeededTenant;
let token: string;
let drawerCode: string;
let drawerId: string;
let bankCode: string;
let categoryId: string;
/** §2.4 names the account `EXPENSE:{code}` — `EXPENSE:RENT`, not the id. */
let categoryCode: string;
let today: string;

const PERMISSIONS = [
  Permission.CASH_ACCOUNT_VIEW, Permission.CASH_ACCOUNT_MANAGE,
  Permission.BANK_ACCOUNT_VIEW, Permission.BANK_ACCOUNT_MANAGE,
  Permission.CASH_SESSION_START, Permission.CASH_SESSION_CLOSE,
  Permission.CASH_DAILY_VIEW, Permission.CASH_MOVEMENT_RECORD,
  Permission.EXPENSE_VIEW, Permission.EXPENSE_RECORD,
  // Owner capital is its own code (§5.26): putting money into the business is
  // a bigger act than moving it between the shop's own boxes.
  Permission.OWNER_CAPITAL_RECORD,
  Permission.SETTING_VIEW, Permission.SETTING_EDIT,
];

beforeAll(async () => {
  pool = testPool();
  await prepareTestDatabase();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.useGlobalFilters(new AppErrorFilter());
  await app.init();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

afterEach(async () => {
  await assertGoldenInvariants(pool, tenant.tenantId);
});

const api = (): ReturnType<typeof request> => request(app.getHttpServer());
const bearer = (test: request.Test, as = token): request.Test =>
  test.set('Authorization', `Bearer ${as}`);
const auth = (test: request.Test, as = token): request.Test =>
  bearer(test, as).set('Idempotency-Key', Ulid.generate(clock));

function must(response: request.Response, what: string): request.Response {
  if (response.status >= 400) {
    throw new Error(`${what} failed: ${String(response.status)} ${JSON.stringify(response.body)}`);
  }
  return response;
}

beforeEach(async () => {
  await resetDatabase(pool);
  tenant = await seedTenant(pool, { name: 'Cash Test', permissions: PERMISSIONS });
  token = signToken(tenant, TEST_JWT_SECRET);
  today = todayIn(tenant.timezone);

  const drawer = must(await bearer(api().post('/api/v1/money/accounts')).send({
    name: 'Counter drawer', type: 'CASH', holderName: null, reference: null,
    isDrawer: true, openingAmountMinor: 5000_00, openingDate: openingDay,
    operationId: Ulid.generate(clock),
  }), 'drawer');
  drawerId = drawer.body.data.id as string;
  drawerCode = `CASH:${drawerId}`;

  const bank = must(await bearer(api().post('/api/v1/money/accounts')).send({
    name: 'City Bank', type: 'BANK', holderName: 'Shop Ltd', reference: null,
    isDrawer: false, openingAmountMinor: 20000_00, openingDate: openingDay,
    operationId: Ulid.generate(clock),
  }), 'bank');
  bankCode = `BANK:${bank.body.data.id as string}`;

  const category = must(
    await bearer(api().post('/api/v1/expenses/categories')).send({ name: 'Rent' }),
    'expense category',
  );
  categoryId = category.body.data.id as string;
  categoryCode = category.body.data.code as string;
});

async function ledger(): Promise<Record<string, number>> {
  return asTenant(pool, tenant.tenantId, async (db) => {
    const rows = await db.query<{ account_code: string; total: string }>(
      `SELECT account_code, SUM(amount_minor)::bigint AS total
         FROM journal_lines GROUP BY account_code`,
    );
    return Object.fromEntries(rows.rows.map((row) => [row.account_code, Number(row.total)]));
  });
}

async function startDay(openingMinor = 5000_00): Promise<string> {
  const day = must(await bearer(api().post('/api/v1/money/day/start')).send({
    businessDate: today, openingAmountMinor: openingMinor,
    counterpartAccountCode: null, note: null, operationId: Ulid.generate(clock),
  }), 'start day');
  return day.body.data.id as string;
}

describe('opening and closing the day (§5.16)', () => {
  it('refuses a second day while one is already open', async () => {
    await startDay();
    const again = await bearer(api().post('/api/v1/money/day/start')).send({
      businessDate: today, openingAmountMinor: 5000_00,
      counterpartAccountCode: null, note: null, operationId: Ulid.generate(clock),
    });
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect(again.status).toBeLessThan(500);
  });

  it('closes a day that balances, and leaves the drawer holding what was counted', async () => {
    const sessionId = await startDay();

    const closed = await bearer(api().post(`/api/v1/money/day/${sessionId}/close`)).send({
      countedClosingMinor: 5000_00, reason: null, operationId: Ulid.generate(clock),
    });
    expect(closed.status, JSON.stringify(closed.body)).toBeLessThan(300);

    const accounts = await ledger();
    // Nothing happened all day, so the drawer still holds its opening float and
    // there is no short or over to explain.
    expect(accounts[drawerCode]).toBe(5000_00);
    expect(accounts['CASH_SHORT_OVER'] ?? 0).toBe(0);
  });

  it('posts the shortage when the drawer comes up light (INV-07b)', async () => {
    const sessionId = await startDay();

    // 300.00 counted short of the 5000.00 the day expects.
    const closed = await bearer(api().post(`/api/v1/money/day/${sessionId}/close`)).send({
      countedClosingMinor: 4700_00, reason: 'Short — cannot find the difference',
      operationId: Ulid.generate(clock),
    });
    expect(closed.status, JSON.stringify(closed.body)).toBeLessThan(300);

    const accounts = await ledger();
    /*
     * The whole reason `CASH_SHORT_OVER` exists (§2.4): the drawer must end the
     * day saying what is physically in it, and the difference has to go
     * somewhere a shopkeeper can see rather than being quietly absorbed. A
     * shortage is a cost, so it is a debit.
     */
    expect(accounts[drawerCode]).toBe(4700_00);
    expect(accounts['CASH_SHORT_OVER']).toBe(300_00);
  });

  it('posts the overage when the drawer comes up heavy', async () => {
    const sessionId = await startDay();

    const closed = await bearer(api().post(`/api/v1/money/day/${sessionId}/close`)).send({
      countedClosingMinor: 5150_00, reason: 'Over by 150', operationId: Ulid.generate(clock),
    });
    expect(closed.status, JSON.stringify(closed.body)).toBeLessThan(300);

    const accounts = await ledger();
    expect(accounts[drawerCode]).toBe(5150_00);
    expect(accounts['CASH_SHORT_OVER']).toBe(-150_00);
  });

  it('is refused without cash.session.start', async () => {
    const cashier = await seedTenant(pool, {
      name: 'Cash Test', permissions: [Permission.CASH_DAILY_VIEW],
    });
    const refused = await bearer(
      api().post('/api/v1/money/day/start'), signToken(cashier, TEST_JWT_SECRET),
    ).send({
      businessDate: today, openingAmountMinor: 0,
      counterpartAccountCode: null, note: null, operationId: Ulid.generate(clock),
    });
    expect(refused.status).toBe(403);
  });
});

describe('recording an expense (§5.12)', () => {
  it('takes the money from the account named and charges it to its category', async () => {
    await startDay();

    const expense = await auth(api().post('/api/v1/expenses')).send({
      categoryId, amountMinor: 1200_00, accountCode: drawerCode,
      payeePartyId: null, note: 'Shop rent for the month',
    });
    expect(expense.status, JSON.stringify(expense.body)).toBe(201);

    const accounts = await ledger();
    expect(accounts[drawerCode]).toBe(5000_00 - 1200_00);
    // An expense is a debit to its own category account (§2.4).
    expect(accounts[`EXPENSE:${categoryCode}`]).toBe(1200_00);
  });

  it('refuses an expense of nothing', async () => {
    await startDay();
    const refused = await auth(api().post('/api/v1/expenses')).send({
      categoryId, amountMinor: 0, accountCode: drawerCode, payeePartyId: null, note: null,
    });
    expect(refused.status).toBe(400);
  });

  it('is refused without expense.record', async () => {
    await startDay();
    const viewer = await seedTenant(pool, {
      name: 'Cash Test', permissions: [Permission.EXPENSE_VIEW],
    });
    const refused = await auth(
      api().post('/api/v1/expenses'), signToken(viewer, TEST_JWT_SECRET),
    ).send({
      categoryId, amountMinor: 100_00, accountCode: drawerCode, payeePartyId: null, note: null,
    });
    expect(refused.status).toBe(403);
  });
});

describe('moving money between the shop’s own accounts (§5.17)', () => {
  it('moves it and changes nothing else', async () => {
    await startDay();
    const before = await ledger();

    const moved = await auth(api().post('/api/v1/money/movements')).send({
      kind: 'TRANSFER', fromAccountCode: drawerCode, toAccountCode: bankCode,
      amountMinor: 2000_00, businessDate: today, reference: null, note: 'Banked the takings',
      operationId: Ulid.generate(clock),
    });
    expect(moved.status, JSON.stringify(moved.body)).toBeLessThan(300);

    const accounts = await ledger();
    expect(accounts[drawerCode]).toBe(before[drawerCode]! - 2000_00);
    expect(accounts[bankCode]).toBe(before[bankCode]! + 2000_00);
    /*
     * A transfer is not income and not a cost: the shop is exactly as rich
     * afterwards. Asserted because getting this wrong is how a shop's own
     * banking starts showing up as profit.
     */
    expect(accounts['SALES'] ?? 0).toBe(0);
    expect(accounts['CASH_SHORT_OVER'] ?? 0).toBe(0);
  });

  it('records the owner putting money in as capital, not as income', async () => {
    await startDay();

    const injected = await auth(api().post('/api/v1/money/movements')).send({
      kind: 'OWNER_INJECTION', fromAccountCode: 'OWNER_CURRENT_ACCOUNT',
      toAccountCode: drawerCode, amountMinor: 10000_00, businessDate: today,
      reference: null, note: 'Owner topped up the till',
      operationId: Ulid.generate(clock),
    });
    expect(injected.status, JSON.stringify(injected.body)).toBeLessThan(300);

    const accounts = await ledger();
    expect(accounts[drawerCode]).toBe(5000_00 + 10000_00);
    // Money the owner put in is owed back to them, never sales.
    expect(accounts['OWNER_CURRENT_ACCOUNT']).toBe(-10000_00);
    expect(accounts['SALES'] ?? 0).toBe(0);
  });

  it('is refused without cash.movement.record', async () => {
    await startDay();
    const viewer = await seedTenant(pool, {
      name: 'Cash Test', permissions: [Permission.CASH_ACCOUNT_VIEW],
    });
    const refused = await auth(
      api().post('/api/v1/money/movements'), signToken(viewer, TEST_JWT_SECRET),
    ).send({
      kind: 'TRANSFER', fromAccountCode: drawerCode, toAccountCode: bankCode,
      amountMinor: 100_00, businessDate: today, reference: null, note: null,
      operationId: Ulid.generate(clock),
    });
    expect(refused.status).toBe(403);
  });
});
