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
import type { SettingsRepository } from '@sher/core-application';
import { Permission } from '@sher/core-contracts';
import { FixedClock, SystemClock, Ulid } from '@sher/shared-utils';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import { signToken as signTokenAt } from '../src/auth/jwt';
import { AppErrorFilter } from '../src/common/app-error.filter';
import { CLOCK, SETTINGS_REPOSITORY } from '../src/infrastructure/tokens';
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
  Permission.SETTING_VIEW, Permission.SETTING_EDIT, Permission.SETTING_TOGGLE,
];

beforeAll(async () => {
  pool = testPool();
  await prepareTestDatabase();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(CLOCK).useValue(clock).compile();
  app = moduleRef.createNestApplication();
  app.useGlobalFilters(new AppErrorFilter());
  await app.init();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await assertGoldenInvariants(pool, tenant.tenantId);
});

describe('cash-session settings safeguard (Issue #14)', () => {
  const toggle = (value: string, as = token): request.Test => bearer(api().post('/api/v1/settings/value'), as)
    .send({ key: 'cash_session_enabled', value });
  const start = (businessDate = today): request.Test => bearer(api().post('/api/v1/money/day/start')).send({
    businessDate, openingAmountMinor: 5000_00, counterpartAccountCode: null,
    note: null, operationId: Ulid.generate(clock),
  });
  const snapshot = async (): Promise<unknown> => asTenant(pool, tenant.tenantId, async (db) => ({
    settings: (await db.query('SELECT id, value, version FROM settings ORDER BY id')).rows,
    sessions: (await db.query('SELECT id, status, version FROM cash_sessions ORDER BY id')).rows,
    closes: (await db.query('SELECT id, expected_closing_minor, counted_closing_minor, difference_minor FROM cash_session_closes ORDER BY id')).rows,
    audit: (await db.query('SELECT id, before_json, after_json FROM audit_events ORDER BY id')).rows,
    journal: (await db.query('SELECT id, account_code, amount_minor FROM journal_lines ORDER BY id')).rows,
  }));

  it('refuses OFF for an open earlier day without changing settings, audit, sessions or journal', async () => {
    await startDay();
    vi.spyOn(clock, 'now').mockReturnValue(new FixedClock('2099-08-16T06:00:00Z').now());
    token = signTokenAt(tenant, TEST_JWT_SECRET, clock);
    const before = await snapshot();
    const refused = await toggle('off');
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('VALIDATION_FAILED');
    expect(await snapshot()).toEqual(before);
  });

  it('permits OFF after a counted close and preserves that immutable close', async () => {
    const sessionId = await startDay();
    must(await bearer(api().post(`/api/v1/money/day/${sessionId}/close`)).send({
      countedClosingMinor: 5000_00, reason: null, operationId: Ulid.generate(clock),
    }), 'close');
    const before = await asTenant(pool, tenant.tenantId, (db) => db.query(
      'SELECT id, expected_closing_minor, counted_closing_minor, difference_minor, status FROM cash_session_closes',
    ));
    expect((await toggle('off')).status).toBe(201);
    expect((await bearer(api().get('/api/v1/money/day'))).body.enabled).toBe(false);
    const after = await asTenant(pool, tenant.tenantId, (db) => db.query(
      'SELECT id, expected_closing_minor, counted_closing_minor, difference_minor, status FROM cash_session_closes',
    ));
    expect(after.rows).toEqual(before.rows);
    expect(after.rows[0].expected_closing_minor).toBe(5000_00);
    expect(after.rows[0].counted_closing_minor).toBe(5000_00);
  });

  it.each([
    ['2099-08-15T18:00:00Z', 201],
    ['2099-08-15T18:00:01Z', 400],
  ] as const)('handles an OFF interval ending at %s (day-two Start Day status %i)', async (enableAt, status) => {
    const now = vi.spyOn(clock, 'now').mockReturnValue(new FixedClock('2099-08-15T17:59:59Z').now());
    token = signTokenAt({ ...tenant, timezone: 'UTC' }, TEST_JWT_SECRET, clock);
    expect((await toggle('off')).status).toBe(201);
    now.mockReturnValue(new FixedClock(enableAt).now());
    expect((await toggle('on')).status).toBe(201);
    expect((await start('2099-08-15')).status).toBe(400);
    const dayTwo = await start('2099-08-16');
    expect(dayTwo.status, JSON.stringify(dayTwo.body)).toBe(status);
    if (status === 201) {
      expect(dayTwo.body.data.cashInMinor).toBe(0);
      expect(dayTwo.body.data.cashOutMinor).toBe(0);
      expect(dayTwo.body.data.expectedClosingMinor).toBe(5000_00);
    }
  });

  it('rejects backdated OFF dates with no transition event that day, then allows the first fully enabled date', async () => {
    const now = vi.spyOn(clock, 'now').mockReturnValue(new FixedClock('2099-08-15T06:00:00Z').now());
    token = signTokenAt(tenant, TEST_JWT_SECRET, clock);
    expect((await toggle('off')).status).toBe(201);
    now.mockReturnValue(new FixedClock('2099-08-18T06:00:00Z').now());
    token = signTokenAt(tenant, TEST_JWT_SECRET, clock);
    expect((await toggle('on')).status).toBe(201);
    for (const date of ['2099-08-15', '2099-08-16', '2099-08-17', '2099-08-18']) {
      expect((await start(date)).status).toBe(400);
    }
    now.mockReturnValue(new FixedClock('2099-08-19T06:00:00Z').now());
    token = signTokenAt(tenant, TEST_JWT_SECRET, clock);
    expect((await start('2099-08-19')).status).toBe(201);
  });

  it('does not let one tenant’s open session block another tenant’s OFF request', async () => {
    await startDay();
    const other = await seedTenant(pool, { name: 'Other shop', permissions: [Permission.SETTING_TOGGLE] });
    expect((await toggle('off', signToken(other, TEST_JWT_SECRET))).status).toBe(201);
    const own = await bearer(api().get('/api/v1/money/day'));
    expect(own.body.enabled).toBe(true);
    expect(own.body.todaySession.status).toBe('OPEN');
  });

  it('does not apply another tenant’s OFF history to Start Day', async () => {
    const other = await seedTenant(pool, { name: 'Other shop', permissions: [Permission.SETTING_TOGGLE] });
    expect((await toggle('off', signToken(other, TEST_JWT_SECRET))).status).toBe(201);
    expect((await start()).status).toBe(201);
  });

  it('keeps toggle and Start Day permissions enforced', async () => {
    const viewer = await seedTenant(pool, { name: 'Viewer', permissions: [Permission.SETTING_VIEW] });
    const viewerToken = signToken(viewer, TEST_JWT_SECRET);
    expect((await toggle('off', viewerToken)).status).toBe(403);
    const refused = await bearer(api().post('/api/v1/money/day/start'), viewerToken).send({
      businessDate: today, openingAmountMinor: 0, operationId: Ulid.generate(clock),
    });
    expect(refused.status).toBe(403);
  });

  it.each(['start', 'off', 'reopen'] as const)('serializes a leading %s with the opposing setting/session request', async (first) => {
    let sessionId = '';
    if (first === 'reopen') {
      sessionId = await startDay();
      must(await bearer(api().post(`/api/v1/money/day/${sessionId}/close`)).send({
        countedClosingMinor: 5000_00, operationId: Ulid.generate(clock),
      }), 'close');
    }
    const repository = app.get<SettingsRepository>(SETTINGS_REPOSITORY);
    const original = repository.lockTenant.bind(repository);
    let acquired = false;
    let calls = 0;
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(repository, 'lockTenant').mockImplementation(async (...args) => {
      const call = ++calls;
      const row = await original(...args);
      if (call === 1) { acquired = true; await gate; }
      return row;
    });
    const leading = (first === 'off' ? toggle('off') : first === 'start' ? start() :
      bearer(api().post(`/api/v1/money/day/${sessionId}/reopen`)).send({
        reason: 'Closed by mistake', operationId: Ulid.generate(clock),
      })).then((response) => response);
    let following: Promise<request.Response> | undefined;
    try {
      await vi.waitFor(() => expect(acquired).toBe(true), { timeout: 5000 });
      following = (first === 'off' ? start() : toggle('off')).then((response) => response);
      await vi.waitFor(async () => {
        const waiting = await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%for update%'");
        expect(waiting.rows[0].n).toBe(1);
      }, { timeout: 5000 });
    } finally {
      release();
      // A failed assertion must not leave live requests in the next test's reset.
      await Promise.all([leading, following]);
    }
    const winner = await leading;
    const loser = await following;
    expect(winner.status, JSON.stringify(winner.body)).toBe(201);
    expect(loser?.status).toBe(first === 'off' ? 403 : 400);
    const state = await bearer(api().get('/api/v1/money/day'));
    expect(state.body.enabled).toBe(first !== 'off');
    if (first !== 'off') expect(state.body.todaySession.status).toBe('OPEN');
  });
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

/**
 * M5 P0: cash-day replay identity is an accounting invariant. These are
 * genuine Nest HTTP + PostgreSQL assertions, not mocked service responses.
 */
describe('cash-session idempotency and immutable close/reopen audit', () => {
  const start = (operationId: string, note: string | null): request.Test =>
    bearer(api().post('/api/v1/money/day/start')).send({
      businessDate: today, openingAmountMinor: 5000_00,
      counterpartAccountCode: null, note, operationId,
    });
  const close = (id: string, operationId: string, reason: string): request.Test =>
    bearer(api().post(`/api/v1/money/day/${id}/close`)).send({
      countedClosingMinor: 4950_00, reason, operationId,
    });
  const reopen = (id: string, operationId: string, reason: string): request.Test =>
    bearer(api().post(`/api/v1/money/day/${id}/reopen`)).send({
      reason, operationId,
    });
  const ledgerState = (): Promise<{ journal: number; lines: number; closes: number; audit: number }> =>
    asTenant(pool, tenant.tenantId, async (db) => {
      const r = await db.query(
        `SELECT (SELECT count(*)::int FROM journal_entries) AS journal,
                (SELECT count(*)::int FROM journal_lines) AS lines,
                (SELECT count(*)::int FROM cash_session_closes) AS closes,
                (SELECT count(*)::int FROM audit_events) AS audit`,
      );
      return r.rows[0] as { journal: number; lines: number; closes: number; audit: number };
    });

  it('Start returns its original response for an identical operationId and payload', async () => {
    const op = Ulid.generate(clock);
    const first = await start(op, 'Opening count verified');
    expect(first.status).toBe(201);
    const before = await ledgerState();
    const replay = await start(op, 'Opening count verified');
    expect(replay.status).toBe(201);
    expect(replay.body.data).toEqual(first.body.data);
    expect(await ledgerState()).toEqual(before);
  });

  it('Start refuses a different note for the same operationId without changing state', async () => {
    const op = Ulid.generate(clock);
    const first = await start(op, 'Original note');
    expect(first.status).toBe(201);
    const before = await ledgerState();
    const changed = await start(op, 'Changed after acknowledgement loss');
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await ledgerState()).toEqual(before);
  });

  it('Close refuses an altered shortage reason after the same operationId was committed', async () => {
    const id = await startDay();
    const op = Ulid.generate(clock);
    const first = await close(id, op, 'Cashier counted fifty short');
    expect(first.status).toBe(201);
    const before = await ledgerState();
    const changed = await close(id, op, 'Replaced explanation');
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const original = first.body.data.closes[0];
    const latest = (await bearer(api().get('/api/v1/money/day'))).body.todaySession.closes[0];
    expect(latest.id).toBe(original.id);
    expect(latest.differenceReason).toBe('Cashier counted fifty short');
    expect(await ledgerState()).toEqual(before);
  });

  it('Close returns its immutable first response without a second adjustment', async () => {
    const id = await startDay();
    const op = Ulid.generate(clock);
    const first = await close(id, op, 'Exact same shortage reason');
    expect(first.status).toBe(201);
    const before = await ledgerState();
    const replay = await close(id, op, 'Exact same shortage reason');
    expect(replay.status).toBe(201);
    expect(replay.body.data).toEqual(first.body.data);
    expect(await ledgerState()).toEqual(before);
  });

  it('Reopen replays the same committed operationId and response once, even after session is OPEN', async () => {
    const id = await startDay();
    expect((await close(id, Ulid.generate(clock), 'Close entered incorrectly')).status).toBe(201);
    const op = Ulid.generate(clock);
    const first = await reopen(id, op, 'Correcting the counted close');
    expect(first.status).toBe(201);
    expect(first.body.data.status).toBe('OPEN');
    expect(first.body.data.closes[0].status).toBe('SUPERSEDED');
    const before = await ledgerState();
    const replay = await reopen(id, op, 'Correcting the counted close');
    expect(replay.status).toBe(201);
    expect(replay.body.data).toEqual(first.body.data);
    expect(await ledgerState()).toEqual(before);
    expect((await ledger())['CASH_SHORT_OVER'] ?? 0).toBe(0);
  });

  it('Reopen refuses changing its reason with the original operationId', async () => {
    const id = await startDay();
    expect((await close(id, Ulid.generate(clock), 'Miscounted')).status).toBe(201);
    const op = Ulid.generate(clock);
    expect((await reopen(id, op, 'Mistaken close')).status).toBe(201);
    const before = await ledgerState();
    const changed = await reopen(id, op, 'Entirely different reason');
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await ledgerState()).toEqual(before);
  });

  it('Reopen rejects the same operationId against a foreign tenant session without disclosure', async () => {
    const id = await startDay();
    expect((await close(id, Ulid.generate(clock), 'Wrong count')).status).toBe(201);
    const foreign = await seedTenant(pool, {
      name: 'Unrelated tenant', permissions: [Permission.CASH_DAILY_VIEW, Permission.CASH_SESSION_REOPEN],
    });
    const before = await ledgerState();
    const denied = await bearer(
      api().post(`/api/v1/money/day/${id}/reopen`), signToken(foreign, TEST_JWT_SECRET),
    ).send({ reason: 'Foreign replay', operationId: Ulid.generate(clock) });
    expect(denied.status).toBe(404);
    expect(await ledgerState()).toEqual(before);
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
