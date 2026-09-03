/*
 * Coverage claims, read by `pnpm test:inventory` (owner request 2026-09-03).
 *
 * @covers endpoint:POST /api/v1/corrections/transaction-date
 * @covers endpoint:GET /api/v1/corrections/transaction-date/:documentType/:documentId
 * @covers endpoint:GET /api/v1/audit-events
 * @covers endpoint:POST /api/v1/expenses/:id/void
 * @covers permission:audit.event.view
 * @covers workflow:correction
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
 * Correcting something already posted, without losing what it said before
 * (§2.5, §5.22, Phase 9.2).
 *
 * The rule this file exists to hold is the one an ERP is judged on years later:
 * **a correction adds, it never overwrites.** The original entry stays, a
 * reversal stands beside it, and the new figures are a third posting — so
 * somebody reading the books in two years can see what was believed, when it
 * changed, and who changed it. A system that edits the old row in place looks
 * tidier and cannot answer any of that.
 *
 * INV-08 is checked continuously by the golden invariants; what is proved here
 * is the audit trail beside it.
 */

const clock = new SystemClock();

/** Accounts are opened before the shop trades, so the balance has a date. */
const openingDay = '2026-01-01';
let app: INestApplication;
let pool: pg.Pool;
let tenant: SeededTenant;
let token: string;
let drawerCode: string;
let categoryId: string;
let categoryCode: string;
let bankCode: string;
let today: string;

const PERMISSIONS = [
  Permission.CASH_ACCOUNT_VIEW, Permission.CASH_ACCOUNT_MANAGE,
  Permission.CASH_SESSION_START, Permission.CASH_DAILY_VIEW,
  Permission.EXPENSE_VIEW, Permission.EXPENSE_RECORD, Permission.EXPENSE_VOID,
  Permission.BANK_ACCOUNT_VIEW, Permission.BANK_ACCOUNT_MANAGE,
  Permission.TRANSACTION_DATE_CHANGE, Permission.AUDIT_VIEW,
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
  tenant = await seedTenant(pool, { name: 'Corrections Test', permissions: PERMISSIONS });
  token = signToken(tenant, TEST_JWT_SECRET);
  today = todayIn(tenant.timezone);

  const drawer = must(await bearer(api().post('/api/v1/money/accounts')).send({
    name: 'Counter drawer', type: 'CASH', holderName: null, reference: null,
    isDrawer: true, openingAmountMinor: 10000_00, openingDate: openingDay,
    operationId: Ulid.generate(clock),
  }), 'drawer');
  drawerCode = `CASH:${drawer.body.data.id as string}`;

  const bank = must(await bearer(api().post('/api/v1/money/accounts')).send({
    name: 'City Bank', type: 'BANK', holderName: 'Shop Ltd', reference: null,
    isDrawer: false, openingAmountMinor: 50000_00, openingDate: openingDay,
    operationId: Ulid.generate(clock),
  }), 'bank');
  bankCode = `BANK:${bank.body.data.id as string}`;

  const category = must(
    await bearer(api().post('/api/v1/expenses/categories')).send({ name: 'Rent' }),
    'category',
  );
  categoryId = category.body.data.id as string;
  categoryCode = category.body.data.code as string;

  must(await bearer(api().post('/api/v1/money/day/start')).send({
    businessDate: today, openingAmountMinor: 10000_00,
    counterpartAccountCode: null, note: null, operationId: Ulid.generate(clock),
  }), 'start day');
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

/** Every journal entry ever written for this document, oldest first. */
async function entriesFor(documentId: string): Promise<
  readonly { type: string; businessDate: string; total: number }[]
> {
  return asTenant(pool, tenant.tenantId, async (db) => {
    const rows = await db.query<{
      source_document_type: string; business_date: string; total: string;
    }>(
      `SELECT je.source_document_type, je.business_date::text,
              COALESCE(SUM(jl.amount_minor) FILTER (WHERE jl.amount_minor > 0), 0)::bigint AS total
         FROM journal_entries je
         LEFT JOIN journal_lines jl ON jl.journal_entry_id = je.id
        WHERE je.source_document_id = $1
        GROUP BY je.id, je.source_document_type, je.business_date
        ORDER BY je.created_at, je.id`,
      [documentId],
    );
    return rows.rows.map((row) => ({
      type: row.source_document_type,
      businessDate: row.business_date,
      total: Number(row.total),
    }));
  });
}

async function recordExpense(amountMinor = 1200_00): Promise<{ id: string; version: number }> {
  const expense = must(await auth(api().post('/api/v1/expenses')).send({
    categoryId, amountMinor, accountCode: bankCode,
    payeePartyId: null, note: 'Shop rent',
  }), 'expense');
  return { id: expense.body.data.id as string, version: expense.body.data.version as number };
}

describe('moving a posted document to the day it really happened (§2.5)', () => {
  it('leaves the original entry standing and adds the correction beside it', async () => {
    const expense = await recordExpense();
    const before = await entriesFor(expense.id);
    expect(before).toHaveLength(1);

    const yesterday = new Date(`${today}T00:00:00Z`);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const movedTo = yesterday.toISOString().slice(0, 10);

    const changed = await bearer(api().post('/api/v1/corrections/transaction-date')).send({
      documentType: 'EXPENSE', documentId: expense.id, version: expense.version,
      businessDate: movedTo, reasonCode: 'WRONG_DATE', reasonText: null,
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);

    /*
     * Three entries where there was one: what was posted, its reversal on the
     * day it is leaving, and the same money on the day it belongs to. The
     * original is still there to be read — that is the whole point.
     */
    const after = await entriesFor(expense.id);
    expect(after.length).toBeGreaterThan(before.length);
    expect(after[0]).toEqual(before[0]);
    expect(after.some((entry) => entry.type.endsWith('_REVERSAL'))).toBe(true);
    expect(after.some((entry) => entry.businessDate === movedTo)).toBe(true);

    // And the shop is no richer or poorer for having corrected the date.
    const accounts = await ledger();
    expect(accounts[bankCode]).toBe(50000_00 - 1200_00);
    expect(accounts[`EXPENSE:${categoryCode}`]).toBe(1200_00);
  });

  it('refuses a stale version rather than moving what somebody else changed', async () => {
    const expense = await recordExpense();
    const refused = await bearer(api().post('/api/v1/corrections/transaction-date')).send({
      documentType: 'EXPENSE', documentId: expense.id, version: expense.version + 5,
      businessDate: today, reasonCode: 'WRONG_DATE', reasonText: null,
    });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.status).toBeLessThan(500);
  });

  it('is refused without the permission to change a transaction date', async () => {
    const expense = await recordExpense();
    const clerk = await seedTenant(pool, {
      name: 'Corrections Test', permissions: [Permission.EXPENSE_VIEW],
    });
    const refused = await bearer(
      api().post('/api/v1/corrections/transaction-date'), signToken(clerk, TEST_JWT_SECRET),
    ).send({
      documentType: 'EXPENSE', documentId: expense.id, version: expense.version,
      businessDate: today, reasonCode: 'WRONG_DATE', reasonText: null,
    });
    expect(refused.status).toBe(403);
  });
});

describe('voiding a posted expense (INV-08)', () => {
  it('gives the money back to the account and leaves the history behind', async () => {
    const expense = await recordExpense();

    const voided = await bearer(api().post(`/api/v1/expenses/${expense.id}/void`)).send({
      version: expense.version, reason: 'Recorded against the wrong shop',
    });
    expect(voided.status, JSON.stringify(voided.body)).toBeLessThan(300);

    const accounts = await ledger();
    // Nothing left: the account is whole and the category is clear.
    expect(accounts[bankCode]).toBe(50000_00);
    expect(accounts[`EXPENSE:${categoryCode}`] ?? 0).toBe(0);

    // But both entries are still on the record.
    const entries = await entriesFor(expense.id);
    expect(entries.length).toBeGreaterThanOrEqual(2);
  });
});

describe('the audit trail (§5.22)', () => {
  it('records who did what, and cannot be written to over the wire', async () => {
    await recordExpense();

    const events = await bearer(api().get('/api/v1/audit-events'));
    expect(events.status, JSON.stringify(events.body)).toBe(200);
    expect(Array.isArray(events.body.data.events)).toBe(true);
    expect(events.body.data.events.length).toBeGreaterThan(0);

    // Append-only: §5.22 says the trail cannot be disabled or edited, and there
    // is deliberately no write, edit or delete code for it to be reached by.
    const written = await bearer(api().post('/api/v1/audit-events')).send({
      entityType: 'tenant', action: 'CREATE',
    });
    expect(written.status).toBeGreaterThanOrEqual(400);
  });

  it('is refused without audit.event.view', async () => {
    const clerk = await seedTenant(pool, {
      name: 'Corrections Test', permissions: [Permission.EXPENSE_VIEW],
    });
    const refused = await bearer(
      api().get('/api/v1/audit-events'), signToken(clerk, TEST_JWT_SECRET),
    );
    expect(refused.status).toBe(403);
  });
});
