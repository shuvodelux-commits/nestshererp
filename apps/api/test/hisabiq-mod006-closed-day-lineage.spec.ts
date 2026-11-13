/*
 * MOD-006 T05 — RED-first historical drawer-session source acceptance.
 *
 * TEST ONLY: opt-in with a fresh, explicitly named disposable PostgreSQL16.
 * Uses genuine authenticated Nest endpoints. Never directly creates journals.
 *
 * Accounting hazard under review: after a physical day closes, an account
 * can cease being the current isDrawer=true box. Cancelling or correcting
 * its originally session-linked transfer *on the closed business date*
 * must not silently restate the completed cash count.
 *
 * No inventory coverage claims until independently verified.
 */
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import type { SettingsRepository } from '@sher/core-application';
import { Test } from '@nestjs/testing';
import { Permission } from '@sher/core-contracts';
import { SystemClock, Ulid } from '@sher/shared-utils';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import { AppErrorFilter } from '../src/common/app-error.filter';
import { SETTINGS_REPOSITORY } from '../src/infrastructure/tokens';
import { signToken, TEST_JWT_SECRET } from './support/auth';
import type { SeededTenant } from './support/database';
import {
  asTenant, prepareTestDatabase, resetDatabase, seedTenant, testPool, todayIn,
} from './support/database';
import { assertGoldenInvariants } from './support/invariants';

const clock = new SystemClock();
const sentinel = 'MOD006_T05_DISPOSABLE_CLOSED_DAY_20261113';
const dbName = 'hisabiq_mod006_closed_day_t05_20261113';
const dbPort = '55712';
const suite = process.env['MOD006_T05_TEST_ONLY'] === sentinel ? describe : describe.skip;
const openingDate = '2026-01-01';
const originalAmountMinor = 25_000;
const openingCashMinor = 100_000;
const bankOpeningMinor = 50_000;

let app: INestApplication;
let pool: pg.Pool;
let tenant: SeededTenant;
let token: string;
let day: string;
let cashId: string;
let cashVersion: number;
let bankId: string;
let movementId: string;
let sessionId: string;

function requireDisposable(): void {
  if (process.env['MOD006_T05_TEST_ONLY'] !== sentinel) {
    throw new Error('T05 requires the unique test-only sentinel');
  }
  for (const key of ['DATABASE_URL', 'TEST_DATABASE_URL', 'ADMIN_DATABASE_URL']) {
    const raw = process.env[key];
    if (!raw) throw new Error('Missing isolated PostgreSQL URL: ' + key);
    const url = new URL(raw);
    const username = key === 'ADMIN_DATABASE_URL' ? 'postgres' : 'sher_app';
    if (url.protocol !== 'postgres:' ||
        url.hostname !== '127.0.0.1' ||
        url.port !== dbPort ||
        url.pathname !== '/' + dbName ||
        url.username !== username) {
      throw new Error('Refusing a URL outside the dedicated T05 database');
    }
  }
}

const api = (): ReturnType<typeof request> => request(app.getHttpServer());
const signed = (r: request.Test): request.Test =>
  r.set('Authorization', 'Bearer ' + token);

function expectStatus(r: request.Response, status: number): void {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
}

interface CloseSnapshot {
  readonly accounts: unknown[];
  readonly sessions: unknown[];
  readonly closes: unknown[];
  readonly movements: unknown[];
  readonly entries: unknown[];
  readonly lines: unknown[];
}

async function snapshot(): Promise<CloseSnapshot> {
  return asTenant(pool, tenant.tenantId, async (db) => {
    const accounts = await db.query(
      'SELECT id, type, is_drawer, status, version FROM accounts ORDER BY id',
    );
    const sessions = await db.query(
      'SELECT id, account_id, status, business_date, version FROM cash_sessions ORDER BY id',
    );
    const closes = await db.query(
      'SELECT id, session_id, status, cash_in_minor::text, cash_out_minor::text, ' +
      'expected_closing_minor::text, counted_closing_minor::text FROM cash_session_closes ORDER BY id',
    );
    const movements = await db.query(
      'SELECT id, status, session_id, amount_minor::text, business_date, version ' +
      'FROM cash_movements ORDER BY id',
    );
    const entries = await db.query(
      'SELECT id, business_date, source_document_type, source_document_id ' +
      'FROM journal_entries ORDER BY id',
    );
    const lines = await db.query(
      'SELECT id, journal_entry_id, account_code, amount_minor::text ' +
      'FROM journal_lines ORDER BY id',
    );
    return {
      accounts: accounts.rows,
      sessions: sessions.rows,
      closes: closes.rows,
      movements: movements.rows,
      entries: entries.rows,
      lines: lines.rows,
    };
  });
}

async function requireMovementVersion(): Promise<number> {
  return asTenant(pool, tenant.tenantId, async (db) => {
    const rows = await db.query<{version: number; session_id: string | null}>(
      'SELECT version, session_id FROM cash_movements WHERE id = $1', [movementId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.session_id).toBe(sessionId);
    return rows.rows[0]!.version;
  });
}

async function removeDrawerFlag(): Promise<void> {
  const updated = await signed(api().patch('/api/v1/money/accounts/' + cashId)).send({
    name: 'Original counted till', type: 'CASH',
    holderName: null, reference: null,
    isDrawer: false,
    openingAmountMinor: openingCashMinor, openingDate, version: cashVersion,
  });
  expectStatus(updated, 200);
  expect(updated.body.data.isDrawer).toBe(false);
}

async function voidOriginal(): Promise<request.Response> {
  return signed(api().post('/api/v1/money/movements/' + movementId + '/void')).send({
    version: await requireMovementVersion(),
    reason: 'Correct an error after the physical drawer was counted',
  });
}

async function correctOriginal(): Promise<request.Response> {
  return signed(api().patch('/api/v1/money/movements/' + movementId)).send({
    kind: 'TRANSFER',
    fromAccountCode: 'CASH:' + cashId,
    toAccountCode: 'BANK:' + bankId,
    amountMinor: 10_000,
    businessDate: day,
    reference: null,
    note: 'Backdated correction after counted close',
    version: await requireMovementVersion(),
    reason: 'Original amount entered incorrectly',
  });
}

suite('MOD-006 T05: a closed counted day cannot be silently restated', () => {
  beforeAll(async () => {
    requireDisposable(); // Before migration, fixture reset or accounting writes.
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
      name: 'T05 isolated historic closing shop',
      permissions: [
        Permission.CASH_ACCOUNT_VIEW, Permission.CASH_ACCOUNT_MANAGE,
        Permission.BANK_ACCOUNT_VIEW, Permission.BANK_ACCOUNT_MANAGE,
        Permission.CASH_SESSION_START, Permission.CASH_SESSION_CLOSE,
        Permission.CASH_DAILY_VIEW, Permission.CASH_MOVEMENT_RECORD,
        Permission.CASH_MOVEMENT_VOID,
      ],
    });
    token = signToken(tenant, TEST_JWT_SECRET);
    day = todayIn(tenant.timezone);

    const drawer = await signed(api().post('/api/v1/money/accounts')).send({
      name: 'Original counted till', type: 'CASH',
      holderName: null, reference: null, isDrawer: true,
      openingAmountMinor: openingCashMinor, openingDate,
      operationId: Ulid.generate(clock),
    });
    expectStatus(drawer, 201);
    cashId = drawer.body.data.id as string;
    cashVersion = drawer.body.data.version as number;

    const bank = await signed(api().post('/api/v1/money/accounts')).send({
      name: 'Bank', type: 'BANK',
      holderName: null, reference: null, isDrawer: false,
      openingAmountMinor: bankOpeningMinor, openingDate,
      operationId: Ulid.generate(clock),
    });
    expectStatus(bank, 201);
    bankId = bank.body.data.id as string;

    const start = await signed(api().post('/api/v1/money/day/start')).send({
      businessDate: day, openingAmountMinor: openingCashMinor,
      counterpartAccountCode: null, note: null,
      operationId: Ulid.generate(clock),
    });
    expectStatus(start, 201);
    sessionId = start.body.data.id as string;

    const transfer = await signed(api().post('/api/v1/money/movements')).send({
      kind: 'TRANSFER',
      fromAccountCode: 'CASH:' + cashId,
      toAccountCode: 'BANK:' + bankId,
      amountMinor: originalAmountMinor, businessDate: day,
      reference: null, note: 'Cash transferred on counted day',
      operationId: Ulid.generate(clock),
    });
    expectStatus(transfer, 201);
    movementId = transfer.body.data.id as string;
    await requireMovementVersion();

    const closed = await signed(api().post('/api/v1/money/day/' + sessionId + '/close')).send({
      countedClosingMinor: openingCashMinor - originalAmountMinor,
      reason: null,
      operationId: Ulid.generate(clock),
    });
    expectStatus(closed, 201);
    expect(closed.body.data.status).toBe('CLOSED');
    expect(closed.body.data.closes[0]?.cashOutMinor).toBe(originalAmountMinor);
    expect(closed.body.data.closes[0]?.countedClosingMinor)
      .toBe(openingCashMinor - originalAmountMinor);
  });

  afterEach(async () => {
    await assertGoldenInvariants(pool, tenant.tenantId);
  });

  it('control: denies same-day cancellation while the closed day still owns its drawer', async () => {
    const before = await snapshot();
    const response = await voidOriginal();
    expectStatus(response, 400);
    expect(await snapshot()).toEqual(before);
  });

  it('RED: denies same-date void after removing the OLD drawer designation', async () => {
    await removeDrawerFlag(); // Legitimate after close; its counted history must persist.
    const before = await snapshot();
    const response = await voidOriginal();
    // A 201 here silently adds an opposite entry to a *closed and counted* day.
    expect(response.status, JSON.stringify({
      response: response.body,
      journalCountBefore: before.entries.length,
      journalCountAfter: (await snapshot()).entries.length,
    })).toBe(400);
    expect(await snapshot()).toEqual(before);
  });

  it('RED: denies a NEW same-day transfer from the former drawer after close', async () => {
    await removeDrawerFlag();
    const before = await snapshot();
    const response = await signed(api().post('/api/v1/money/movements')).send({
      kind: 'TRANSFER',
      fromAccountCode: 'CASH:' + cashId,
      toAccountCode: 'BANK:' + bankId,
      amountMinor: 5_000, businessDate: day,
      reference: null, note: 'After physical day counted; must not restate',
      operationId: Ulid.generate(clock),
    });
    // No new same-day drawer journal may be created behind a CLOSED count.
    expect(response.status, JSON.stringify({
      response: response.body,
      journalCountBefore: before.entries.length,
      journalCountAfter: (await snapshot()).entries.length,
    })).toBe(400);
    expect(await snapshot()).toEqual(before);
  });

  it('RED: denies same-date correction after removing the OLD drawer designation', async () => {
    await removeDrawerFlag();
    const before = await snapshot();
    const response = await correctOriginal();
    // A 200 here rewrites the standing movement/session association and adds
    // reversing/reposting journals under the date that has already been counted.
    expect(response.status, JSON.stringify({
      response: response.body,
      journalCountBefore: before.entries.length,
      journalCountAfter: (await snapshot()).entries.length,
    })).toBe(400);
    expect(await snapshot()).toEqual(before);
  });

  it.each(['close-first', 'movement-first'] as const)(
    'serializes %s: no movement may race a physical cash-day close',
    async (first) => {
      // The regular fixture has a physical close. Reopen only today's day,
      // retaining the superseded historical close for audit.
      const reopened = await signed(api().post('/api/v1/money/day/' + sessionId + '/reopen'))
        .send({
          reason: 'Correctly re-count before concurrent activity',
          operationId: Ulid.generate(clock),
        });
      expectStatus(reopened, 201);
      expect(reopened.body.data.status).toBe('OPEN');

      const settings = app.get<SettingsRepository>(SETTINGS_REPOSITORY);
      const actualLock = settings.lockTenant.bind(settings);
      let lockAcquired = false;
      let unlock = (): void => {};
      const gate = new Promise<void>((resolve) => { unlock = resolve; });
      const spy = vi.spyOn(settings, 'lockTenant').mockImplementation(async (...args) => {
        const result = await actualLock(...args);
        if (!lockAcquired) {
          lockAcquired = true;
          await gate; // lock remains held by the first Nest UoW
        }
        return result;
      });

      const postMove = (): Promise<request.Response> =>
        signed(api().post('/api/v1/money/movements')).send({
          kind: 'TRANSFER',
          fromAccountCode: 'CASH:' + cashId,
          toAccountCode: 'BANK:' + bankId,
          amountMinor: 5_000,
          businessDate: day,
          reference: null,
          note: 'Concurrent transfer vs physical close',
          operationId: Ulid.generate(clock),
        }).then((r) => r);
      const postClose = (): Promise<request.Response> =>
        signed(api().post('/api/v1/money/day/' + sessionId + '/close')).send({
          countedClosingMinor: first === 'close-first' ? 75_000 : 70_000,
          reason: null,
          operationId: Ulid.generate(clock),
        }).then((r) => r);

      const leading = first === 'close-first' ? postClose() : postMove();
      let following: Promise<request.Response> | undefined;
      try {
        await vi.waitFor(() => expect(lockAcquired).toBe(true), { timeout: 10_000 });
        following = first === 'close-first' ? postMove() : postClose();
        // Prove the second UoW actually waits for the same tenant-row lock,
        // instead of merely assuming request ordering from Promise creation.
        await vi.waitFor(async () => {
          const waiting = await pool.query<{n: number}>(
            "SELECT COUNT(*)::int AS n FROM pg_stat_activity " +
            "WHERE wait_event_type = 'Lock' AND query ILIKE '%for update%'",
          );
          expect(waiting.rows[0]?.n ?? 0).toBeGreaterThan(0);
        }, { timeout: 10_000 });
      } finally {
        unlock();
        await Promise.allSettled([leading, following]);
        spy.mockRestore();
      }

      const winner = await leading;
      const second = await following;
      if (first === 'close-first') {
        expectStatus(winner, 201);
        expectStatus(second, 400);
      } else {
        expectStatus(winner, 201);
        expectStatus(second, 201);
      }

      const close = await asTenant(pool, tenant.tenantId, (db) =>
        db.query<{ counted_closing_minor: string; status: string }>(
          "SELECT counted_closing_minor::text, status FROM cash_session_closes " +
          "WHERE session_id = $1 AND status = 'ACTIVE'",
          [sessionId],
        ));
      expect(close.rows).toHaveLength(1);
      expect(Number(close.rows[0]?.counted_closing_minor))
        .toBe(first === 'close-first' ? 75_000 : 70_000);
    },
  );

});
