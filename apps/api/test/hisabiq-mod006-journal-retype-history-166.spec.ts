/*
 * MOD-006 T01/T04 #166 — RED-first posted-journal account classification.
 * One new test-only file, real signed Nest APIs + disposable PostgreSQL16 RLS.
 * No direct account/journal fixture writes or production service changes.
 *
 * @covers endpoint:POST /api/v1/money/accounts
 * @covers endpoint:PATCH /api/v1/money/accounts/:id
 * @covers endpoint:GET /api/v1/money/accounts/:id/statement
 */
import 'reflect-metadata';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Permission } from '@sher/core-contracts';
import { SystemClock, Ulid } from '@sher/shared-utils';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import { AppErrorFilter } from '../src/common/app-error.filter';
import { MONEY_REPOSITORY } from '../src/infrastructure/tokens';
import type { MoneyRepository } from '@sher/core-application';
import { signToken, TEST_JWT_SECRET } from './support/auth';
import type { SeededTenant } from './support/database';
import { asTenant, prepareTestDatabase, resetDatabase, seedTenant, testPool } from './support/database';
import { assertGoldenInvariants } from './support/invariants';

const clock = new SystemClock();
const expectedDb = 'hisabiq_mod006_journal_retype_166_20261114';
const expectedPort = '55816';
const sentinel = 'MOD006_166_DISPOSABLE_JOURNAL_RETYPE_ONLY_20261114';
const suite = process.env['MOD006_166_JOURNAL_RETYPE_TEST_ONLY'] === sentinel
  ? describe : describe.skip;
const historicalDate = '2026-01-01';
const openingMinor = 100_000;
type AccountType = 'CASH' | 'BANK' | 'MFS' | 'LOAN';
interface AccountInput {
  name: string;
  type: AccountType;
  holderName: string | null;
  reference: string | null;
  isDrawer: boolean;
  openingAmountMinor: number;
  openingDate: string | null;
}

const fullPermission = [
  Permission.CASH_ACCOUNT_VIEW, Permission.CASH_ACCOUNT_MANAGE,
  Permission.BANK_ACCOUNT_VIEW, Permission.BANK_ACCOUNT_MANAGE,
  Permission.LOAN_ACCOUNT_MANAGE,
  Permission.CASH_MOVEMENT_RECORD,
  Permission.EXPENSE_RECORD, Permission.EXPENSE_VIEW,
];
let app: INestApplication;
let pool: pg.Pool;
let tenant: SeededTenant;
let auth: string;
let money: MoneyRepository;

const api = (): ReturnType<typeof request> => request(app.getHttpServer());
const signed = (req: request.Test, token = auth): request.Test =>
  req.set('Authorization', 'Bearer ' + token);
const op = (): string => Ulid.generate(clock);
const input = (
  type: AccountType, amountMinor = openingMinor, name = 'Existing posted money',
): AccountInput => ({
  name, type, holderName: null, reference: null, isDrawer: false,
  openingAmountMinor: amountMinor,
  openingDate: amountMinor > 0 ? historicalDate : null,
});
const create = (data: AccountInput, operationId = op(), token = auth): request.Test =>
  signed(api().post('/api/v1/money/accounts'), token).send({ ...data, operationId });
const update = (id: string, data: AccountInput, version: number, token = auth): request.Test =>
  signed(api().patch('/api/v1/money/accounts/' + id), token)
    .send({ ...data, version });

function guardIsolatedDatabase(): void {
  if (process.env['MOD006_166_JOURNAL_RETYPE_TEST_ONLY'] !== sentinel) {
    throw new Error('#166 requires explicit disposable PG16 sentinel');
  }
  for (const key of ['DATABASE_URL', 'TEST_DATABASE_URL', 'ADMIN_DATABASE_URL']) {
    const raw = process.env[key];
    if (!raw) throw new Error('#166 missing database URL: ' + key);
    const url = new URL(raw);
    const role = key === 'ADMIN_DATABASE_URL' ? 'postgres' : 'sher_app';
    if (url.protocol !== 'postgres:' || url.hostname !== '127.0.0.1' ||
        url.port !== expectedPort || url.pathname !== '/' + expectedDb ||
        url.username !== role) {
      throw new Error('#166 refuses non-isolated database, role, port or host: ' + key);
    }
  }
}

interface JournalLine { readonly account_code: string; readonly amount_minor: string; }
async function ledgerSnapshot(accountId: string) {
  return asTenant(pool, tenant.tenantId, async db => {
    const lines = await db.query<JournalLine>(
      'SELECT account_code, amount_minor::text FROM journal_lines ORDER BY id',
    );
    const account = await db.query<{ type: AccountType; version: number }>(
      'SELECT type, version FROM accounts WHERE tenant_id = $1 AND id = $2',
      [tenant.tenantId, accountId],
    );
    const sessions = await db.query<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM cash_sessions',
    );
    const recon = await db.query<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM account_reconciliations',
    );
    return {
      journal: lines.rows, accountType: account.rows[0]?.type,
      version: account.rows[0]?.version,
      cashSessions: sessions.rows[0]?.count ?? -1,
      reconciliations: recon.rows[0]?.count ?? -1,
    };
  });
}

suite('MOD-006 #166 — posted journals must survive account-type metadata changes', () => {
  beforeAll(async () => {
    guardIsolatedDatabase(); // Refuse before any schema/reset/fixture write.
    pool = testPool();
    await prepareTestDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    money = moduleRef.get<MoneyRepository>(MONEY_REPOSITORY, { strict: false });
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AppErrorFilter());
    await app.init();
  }, 60_000);

  afterAll(async () => { await app?.close(); await pool?.end(); });
  beforeEach(async () => {
    await resetDatabase(pool);
    tenant = await seedTenant(pool, {
      name: 'MOD006 posted journal integrity shop', permissions: fullPermission,
    });
    auth = signToken(tenant, TEST_JWT_SECRET);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    if (tenant?.tenantId) await assertGoldenInvariants(pool, tenant.tenantId);
  });

  it.each([
    ['BANK', 'LOAN'],
    ['CASH', 'BANK'],
    ['LOAN', 'BANK'],
  ] as const)(
    'RED-first: changing posted %s opening into %s cannot orphan account ledger balance',
    async (from, to) => {
      const original = input(from);
      const made = await create(original);
      expect(made.status, JSON.stringify(made.body)).toBe(201);
      const accountId = made.body.data.id as string;
      const version = made.body.data.version as number;
      const before = await ledgerSnapshot(accountId);
      // The create response is the authoritative account projection. The
      // account list intentionally hides BANK/MFS when the bank feature is OFF:
      // using it here would test visibility, not journal classification.
      expect(Math.abs(Number(made.body.data.balanceMinor))).toBe(openingMinor);
      expect(before.journal).toHaveLength(2);
      expect(before.cashSessions).toBe(0);
      expect(before.reconciliations).toBe(0);
      const postedCode = from + ':' + accountId;
      const originalLine = before.journal.find(line => line.account_code === postedCode);
      expect(Math.abs(Number(originalLine?.amount_minor))).toBe(openingMinor);
      expect(before.journal.reduce((sum, line) => sum + Number(line.amount_minor), 0)).toBe(0);

      const attempt = await update(accountId, { ...original, type: to }, version);
      // Either reject retyping after immutable journal posting or implement a
      // separately authorized source-owned reversal/reposting of history.
      expect([200, 400]).toContain(attempt.status);
      const after = await ledgerSnapshot(accountId);
      expect(after.cashSessions).toBe(0);
      expect(after.reconciliations).toBe(0);
      expect(after.journal.reduce((sum, line) => sum + Number(line.amount_minor), 0)).toBe(0);
      if (attempt.status === 400) {
        expect(after.accountType).toBe(from);
        expect(after.journal).toEqual(before.journal);
      } else {
        expect(after.accountType).toBe(to);
        // A signed PATCH which returns a zero balance for a still-funded
        // account has silently lost its original journal-code projection.
        expect(Math.abs(Number(attempt.body.data.balanceMinor))).toBe(openingMinor);
        // If reclassification was allowed, an approved source-owned
        // reversal/repost must exist; renaming the account type is not enough.
        expect(after.journal.length).toBeGreaterThan(before.journal.length);
        expect(after.journal).toContainEqual(originalLine!);
        expect(after.journal.some(line => line.account_code === to + ':' + accountId)).toBe(true);
      }
    },
  );

  it('blocks MFS to BANK after a posted opening even though both share BANK journal codes', async () => {
    const original = input('MFS');
    const made = await create(original);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const accountId = made.body.data.id as string;
    const before = await ledgerSnapshot(accountId);
    expect(before.journal.some(line => line.account_code === 'BANK:' + accountId)).toBe(true);
    const changed = await update(accountId, { ...original, type: 'BANK' },
      made.body.data.version as number);
    expect(changed.status, JSON.stringify(changed.body)).toBe(400);
    expect(await ledgerSnapshot(accountId)).toEqual(before);
  });

  it('blocks retyping a fully settled BANK account with zero net but nonzero journal lineage', async () => {
    const original = input('BANK', 25_000);
    const made = await create(original);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const accountId = made.body.data.id as string;
    const other = await create(input('BANK', 0, 'Other bank'));
    expect(other.status, JSON.stringify(other.body)).toBe(201);
    const movement = await signed(api().post('/api/v1/money/movements')).send({
      kind: 'TRANSFER',
      fromAccountCode: 'BANK:' + accountId,
      toAccountCode: 'BANK:' + (other.body.data.id as string),
      amountMinor: 25_000,
      businessDate: historicalDate,
      reference: null,
      note: 'Fully settle test bank account while preserving its journal',
      operationId: op(),
    });
    expect(movement.status, JSON.stringify(movement.body)).toBe(201);
    const before = await ledgerSnapshot(accountId);
    const lineSum = before.journal.filter(line => line.account_code === 'BANK:' + accountId)
      .reduce((sum, line) => sum + Number(line.amount_minor), 0);
    expect(lineSum).toBe(0);
    expect(before.journal.filter(line => line.account_code === 'BANK:' + accountId)).toHaveLength(2);
    const changed = await update(accountId, { ...original, type: 'LOAN' },
      made.body.data.version as number);
    expect(changed.status, JSON.stringify(changed.body)).toBe(400);
    expect(await ledgerSnapshot(accountId)).toEqual(before);
  });

  it('serializes first expense posting vs unused-account type PATCH without orphaning BANK journals', async () => {
    const original = input('BANK', 0, 'Never-used race bank');
    const made = await create(original);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const accountId = made.body.data.id as string;
    const category = await signed(api().post('/api/v1/expenses/categories'))
      .send({ name: 'Race expense' });
    expect(category.status, JSON.stringify(category.body)).toBe(201);

    let wake!: () => void;
    let resume!: () => void;
    const reached = new Promise<void>(resolve => { wake = resolve; });
    const hold = new Promise<void>(resolve => { resume = resolve; });
    const originalFind = money.findAccountById.bind(money);
    let heldOnce = false;
    const spy = vi.spyOn(money, 'findAccountById').mockImplementation(async (...args) => {
      const row = await originalFind(...args);
      if (!heldOnce && args[2] === accountId && row?.type === 'BANK') {
        heldOnce = true;
        wake();
        await hold;
      }
      return row;
    });

    const pendingExpense = signed(api().post('/api/v1/expenses'))
      .set('Idempotency-Key', op()).send({
        categoryId: category.body.data.id, amountMinor: 2000,
        accountCode: 'BANK:' + accountId, payeePartyId: null, note: 'First posting race',
      }).then(response => response);
    let patchPromise: Promise<request.Response> | undefined;
    try {
      const first = await Promise.race([
        reached.then(() => ({ kind: 'paused' })),
        pendingExpense.then(response => ({
          kind: 'ended-before-account-read', status: response.status, body: response.body,
        })),
        new Promise<{ kind: string }>(resolve =>
          setTimeout(() => resolve({ kind: 'never-reached-account-read' }), 8000)),
      ]);
      expect(first, JSON.stringify(first)).toEqual({ kind: 'paused' });
      // A concurrently started update must be serialized with first posting.
      // Before the fix, the PATCH commits against an empty journal while the
      // expense is already holding the stale BANK account type in memory.
      patchPromise = update(accountId, { ...original, type: 'LOAN' },
        made.body.data.version as number).then(response => response);
      await Promise.race([
        patchPromise.then(() => undefined),
        new Promise<void>(resolve => setTimeout(resolve, 600)),
      ]);
    } finally {
      resume();
    }
    const expense = await pendingExpense;
    const changed = await patchPromise!;
    spy.mockRestore();
    expect([201, 400]).toContain(expense.status);
    expect([200, 400]).toContain(changed.status);

    const after = await ledgerSnapshot(accountId);
    // Policy A: an accepted first BANK posting locks classification forever.
    // If an unused account was legitimately changed first, stale BANK-based
    // posting must be rejected and leave journal history untouched.
    const bankLines = after.journal.filter(line => line.account_code === 'BANK:' + accountId);
    if (after.accountType === 'LOAN') {
      expect(changed.status).toBe(200);
      expect(expense.status).toBe(400);
      expect(bankLines).toHaveLength(0);
    } else {
      expect(after.accountType).toBe('BANK');
      expect(expense.status).toBe(201);
      expect(changed.status).toBe(400);
      expect(bankLines).toHaveLength(1);
    }
  }, 45_000);

  it('rejects a stale BANK payment code after an unused account was retyped to LOAN', async () => {
    const original = input('BANK', 0, 'Stale client bank');
    const made = await create(original);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const accountId = made.body.data.id as string;
    const changed = await update(accountId, { ...original, type: 'LOAN' },
      made.body.data.version as number);
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    const category = await signed(api().post('/api/v1/expenses/categories'))
      .send({ name: 'Stale category' });
    expect(category.status, JSON.stringify(category.body)).toBe(201);
    const attempt = await signed(api().post('/api/v1/expenses'))
      .set('Idempotency-Key', op()).send({
        categoryId: category.body.data.id, amountMinor: 1000,
        accountCode: 'BANK:' + accountId, payeePartyId: null,
        note: 'Must not silently debit retyped LOAN account',
      });
    expect(attempt.status, JSON.stringify(attempt.body)).toBe(400);
    const after = await ledgerSnapshot(accountId);
    expect(after.accountType).toBe('LOAN');
    expect(after.journal).toHaveLength(0);
  });

  it('preserves existing MFS alias payments by normalizing MFS code to the BANK journal family', async () => {
    const made = await create(input('MFS', 0, 'Mobile wallet'));
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const accountId = made.body.data.id as string;
    const category = await signed(api().post('/api/v1/expenses/categories'))
      .send({ name: 'Wallet test expense' });
    expect(category.status, JSON.stringify(category.body)).toBe(201);
    const expense = await signed(api().post('/api/v1/expenses'))
      .set('Idempotency-Key', op()).send({
        categoryId: category.body.data.id, amountMinor: 500,
        accountCode: 'MFS:' + accountId, payeePartyId: null,
        note: 'Preserve previously supported MFS alias',
      });
    expect(expense.status, JSON.stringify(expense.body)).toBe(201);
    expect(expense.body.data.accountCode).toBe('BANK:' + accountId);
    const journal = await ledgerSnapshot(accountId);
    expect(journal.accountType).toBe('MFS');
    expect(journal.journal.some(line => line.account_code === 'BANK:' + accountId)).toBe(true);
  });

  it('permits a same-type name change without altering the posted opening', async () => {
    const original = input('BANK');
    const made = await create(original);
    expect(made.status).toBe(201);
    const accountId = made.body.data.id as string;
    const before = await ledgerSnapshot(accountId);
    const changed = await update(accountId, { ...original, name: 'Renamed bank' },
      made.body.data.version as number);
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body.data.balanceMinor).toBe(openingMinor);
    expect(changed.body.data.name).toBe('Renamed bank');
    const after = await ledgerSnapshot(accountId);
    expect(after.journal).toEqual(before.journal);
    expect(after.cashSessions).toBe(0);
  });

  it('permits an unused zero-balance bank account to change its type', async () => {
    const original = input('BANK', 0);
    const made = await create(original);
    expect(made.status).toBe(201);
    const accountId = made.body.data.id as string;
    const before = await ledgerSnapshot(accountId);
    expect(before.journal).toHaveLength(0);
    const changed = await update(accountId, { ...original, type: 'LOAN' },
      made.body.data.version as number);
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body.data.type).toBe('LOAN');
    expect(changed.body.data.balanceMinor).toBe(0);
    const after = await ledgerSnapshot(accountId);
    expect(after.journal).toHaveLength(0);
    expect(after.cashSessions).toBe(0);
  });

  it('keeps create-idempotency journal and identity stable on identical replay', async () => {
    const original = input('BANK');
    const operationId = op();
    const first = await create(original, operationId);
    expect(first.status).toBe(201);
    const accountId = first.body.data.id as string;
    const before = await ledgerSnapshot(accountId);
    const replay = await create(original, operationId);
    expect(replay.status).toBe(201);
    expect(replay.body.data.id).toBe(accountId);
    const after = await ledgerSnapshot(accountId);
    expect(after).toEqual(before);
    expect(after.journal).toHaveLength(2);
  });

  it('forbids cross-tenant account changes and unauthorised account creation', async () => {
    const original = input('BANK');
    const made = await create(original);
    expect(made.status).toBe(201);
    const accountId = made.body.data.id as string;
    const before = await ledgerSnapshot(accountId);
    const outsider = await seedTenant(pool, {
      name: 'Other tenant', permissions: fullPermission,
    });
    const viewer = await seedTenant(pool, {
      name: 'View-only operator', permissions: [Permission.BANK_ACCOUNT_VIEW],
    });
    const otherUpdate = await update(accountId, { ...original, type: 'LOAN' },
      made.body.data.version as number, signToken(outsider, TEST_JWT_SECRET));
    expect(otherUpdate.status).toBe(404);
    const foreignRead = await signed(
      api().get('/api/v1/money/accounts/' + accountId + '/statement'),
      signToken(outsider, TEST_JWT_SECRET),
    );
    expect(foreignRead.status).toBe(404);
    const noManage = await create(input('BANK', 0), op(), signToken(viewer, TEST_JWT_SECRET));
    expect(noManage.status).toBe(403);
    expect(await ledgerSnapshot(accountId)).toEqual(before);
    await assertGoldenInvariants(pool, outsider.tenantId);
    await assertGoldenInvariants(pool, viewer.tenantId);
  });
});
