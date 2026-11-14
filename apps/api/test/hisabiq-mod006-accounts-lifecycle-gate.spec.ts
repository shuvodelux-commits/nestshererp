/*
 * MOD-006 T01 Super Build — real Nest + isolated PostgreSQL16 money-account
 * lifecycle / journal acceptance. One opt-in test file; no production edits.
 * This suite deliberately does not invent missing D08 or cheque contracts.
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
  asTenant, prepareTestDatabase, resetDatabase, seedTenant, testPool,
} from './support/database';
import { assertGoldenInvariants } from './support/invariants';

const clock = new SystemClock();
const expectedDb = 'hisabiq_mod006_t01_verify_20261113';
const expectedPort = '55724';
const sentinel = 'MOD006_T01_ONLY_DISPOSABLE_20261113';
const suite = process.env['MOD006_T01_TEST_ONLY'] === sentinel ? describe : describe.skip;
const openingDate = '2026-01-01';

let app: INestApplication;
let pool: pg.Pool;
let shop: SeededTenant;
let token: string;

const api = (): ReturnType<typeof request> => request(app.getHttpServer());
const signed = (test: request.Test, as = token): request.Test =>
  test.set('Authorization', 'Bearer ' + as);
const operationId = (): string => Ulid.generate(clock);

interface AccountInput {
  name: string;
  type: 'CASH' | 'BANK' | 'MFS' | 'LOAN';
  holderName: string | null;
  reference: string | null;
  isDrawer: boolean;
  openingAmountMinor: number;
  openingDate: string | null;
}
const input = (
  name: string,
  amountMinor = 0,
  changes: Partial<AccountInput> = {},
): AccountInput => ({
  name, type: 'CASH', holderName: null, reference: null, isDrawer: false,
  openingAmountMinor: amountMinor, openingDate: amountMinor > 0 ? openingDate : null,
  ...changes,
});
const create = (data: AccountInput, op = operationId(), as = token): request.Test =>
  signed(api().post('/api/v1/money/accounts'), as).send({ ...data, operationId: op });
const update = (id: string, data: AccountInput, version: number, as = token): request.Test =>
  signed(api().patch('/api/v1/money/accounts/' + id), as).send({ ...data, version });
const deactivate = (id: string, version: number): request.Test =>
  signed(api().post('/api/v1/money/accounts/' + id + '/deactivate')).send({ version });

function requirePrivateTestDatabase(): void {
  if (process.env['MOD006_T01_TEST_ONLY'] !== sentinel) {
    throw new Error('T01 refuses a missing opt-in sentinel');
  }
  for (const key of ['DATABASE_URL', 'TEST_DATABASE_URL', 'ADMIN_DATABASE_URL']) {
    const raw = process.env[key];
    if (!raw) throw new Error('T01 missing explicitly guarded URL: ' + key);
    const url = new URL(raw);
    const role = key === 'ADMIN_DATABASE_URL' ? 'postgres' : 'sher_app';
    if (url.protocol !== 'postgres:' || url.hostname !== '127.0.0.1' ||
        url.port !== expectedPort || url.pathname !== '/' + expectedDb ||
        url.username !== role) {
      throw new Error('T01 refuses a non-disposable database or unexpected database role');
    }
  }
}

async function accountingState(tenantId = shop.tenantId): Promise<{
  accounts: unknown[];
  openings: unknown[];
  journal: Array<{ id: string; account_code: string; amount_minor: string }>;
  sessions: unknown[];
  auditCount: number;
}> {
  return asTenant(pool, tenantId, async (db) => {
    const accounts = await db.query(
      'SELECT id, name, type, status, version, is_drawer FROM accounts ORDER BY id',
    );
    const openings = await db.query(
      'SELECT id, account_id, amount_minor::text, business_date FROM account_openings ORDER BY id',
    );
    const journal = await db.query<{
      id: string; account_code: string; amount_minor: string
    }>('SELECT id, account_code, amount_minor::text FROM journal_lines ORDER BY id');
    const sessions = await db.query('SELECT id, status FROM cash_sessions ORDER BY id');
    const audit = await db.query<{count: number}>(
      'SELECT COUNT(*)::int AS count FROM audit_events',
    );
    return {
      accounts: accounts.rows, openings: openings.rows, journal: journal.rows,
      sessions: sessions.rows, auditCount: audit.rows[0]?.count ?? 0,
    };
  });
}

suite('MOD-006 T01: account business rules / signed PostgreSQL journals', () => {
  beforeAll(async () => {
    requirePrivateTestDatabase(); // BEFORE fixture, migration, reset or journal write.
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
    shop = await seedTenant(pool, {
      name: 'T01 disposable finance shop',
      permissions: [
        Permission.CASH_ACCOUNT_VIEW, Permission.CASH_ACCOUNT_MANAGE,
        Permission.BANK_ACCOUNT_VIEW, Permission.BANK_ACCOUNT_MANAGE,
        Permission.LOAN_ACCOUNT_MANAGE,
      ],
    });
    token = signToken(shop, TEST_JWT_SECRET);
  });

  afterEach(async () => {
    if (shop?.tenantId) await assertGoldenInvariants(pool, shop.tenantId);
  });

  it('posts an exact 100000-poisha historical opening with balanced equity and no cash day', async () => {
    const response = await create(input('Till', 100_000));
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.data.balanceMinor).toBe(100_000);
    expect(response.body.data.openingDate).toBe(openingDate);
    const id = response.body.data.id as string;
    const rows = await asTenant(pool, shop.tenantId, async (db) =>
      db.query<{account_code: string; amount_minor: string}>(
        'SELECT account_code, amount_minor::text FROM journal_lines ORDER BY account_code',
      ));
    const signedLines = Object.fromEntries(rows.rows.map(r => [r.account_code, Number(r.amount_minor)]));
    expect(signedLines).toEqual({ ['CASH:' + id]: 100_000, OPENING_EQUITY: -100_000 });
    expect(rows.rows.reduce((sum, row) => sum + Number(row.amount_minor), 0)).toBe(0);
    const state = await accountingState();
    expect(state.accounts).toHaveLength(1);
    expect(state.openings).toHaveLength(1);
    expect(state.journal).toHaveLength(2);
    expect(state.sessions).toHaveLength(0);
  });

  it('refuses invalid historical openings atomically without creating accounts, journals or audit', async () => {
    const attempts = [
      input('Missing historical date', 9_500, { openingDate: null }),
      input('Negative opening', -1, { openingDate: openingDate }),
      input('Future opening', 4_000, { openingDate: '2099-01-01' }),
      input('Bank cannot be drawer', 0, { type: 'BANK', isDrawer: true }),
    ];
    const initial = await accountingState();
    for (const data of attempts) {
      const response = await create(data);
      expect(response.status, JSON.stringify(response.body)).toBe(400);
      expect(await accountingState()).toEqual(initial);
    }
  });

  it('replays a creation once and rejects an altered-body idempotency key without a duplicate journal', async () => {
    const op = operationId();
    const data = input('Safe account', 70_000);
    const first = await create(data, op);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const beforeReplay = await accountingState();
    const retry = await create(data, op);
    expect(retry.status, JSON.stringify(retry.body)).toBe(201);
    expect(retry.body.data.id).toBe(first.body.data.id);
    expect(await accountingState()).toEqual(beforeReplay);
    const altered = await create({ ...data, openingAmountMinor: 71_000 }, op);
    expect(altered.status).toBeGreaterThanOrEqual(400);
    expect(altered.body.error?.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await accountingState()).toEqual(beforeReplay);
  });

  it('retains the original opening journal, posts only a 50000 correction delta, and rejects stale edits', async () => {
    const initial = input('Opening corrected later', 100_000);
    const created = await create(initial);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.data.id as string;
    const initialVersion = created.body.data.version as number;
    const before = await accountingState();
    const revised = await update(id, { ...initial, openingAmountMinor: 150_000 }, initialVersion);
    expect(revised.status, JSON.stringify(revised.body)).toBe(200);
    expect(revised.body.data.balanceMinor).toBe(150_000);
    const after = await accountingState();
    for (const prior of before.journal) expect(after.journal).toContainEqual(prior);
    expect(after.journal).toHaveLength(before.journal.length + 2);
    const additions = after.journal.filter(line => !before.journal.some(old => old.id === line.id));
    expect(Object.fromEntries(additions.map(line => [line.account_code, Number(line.amount_minor)])))
      .toEqual({ ['CASH:' + id]: 50_000, OPENING_EQUITY: -50_000 });
    const stale = await update(id, { ...initial, name: 'Stale edit' }, initialVersion);
    expect(stale.status).toBe(409);
    expect(stale.body.error?.code).toBe('CONFLICT_STALE_VERSION');
    expect(await accountingState()).toEqual(after);
    const deleteOpening = await update(id, { ...initial, openingAmountMinor: 0, openingDate: null },
      revised.body.data.version as number);
    expect(deleteOpening.status).toBe(400);
    expect(await accountingState()).toEqual(after);
  });

  it('does not deactivate funded accounts, but soft-deactivates a zero-balance account', async () => {
    const funded = await create(input('Funded', 5_000));
    const empty = await create(input('Empty'));
    expect(funded.status).toBe(201);
    expect(empty.status).toBe(201);
    const before = await accountingState();
    const denied = await deactivate(funded.body.data.id as string, funded.body.data.version as number);
    expect(denied.status).toBe(400);
    expect(await accountingState()).toEqual(before);
    const closed = await deactivate(empty.body.data.id as string, empty.body.data.version as number);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body.data.status).toBe('INACTIVE');
    const after = await accountingState();
    expect(after.accounts).toHaveLength(2);
    expect(after.journal).toEqual(before.journal);
    const hidden = await signed(api().get('/api/v1/money/accounts'));
    expect(hidden.status).toBe(200);
    expect(hidden.body.accounts.map((row: {id: string}) => row.id))
      .not.toContain(empty.body.data.id);
    const included = await signed(api().get('/api/v1/money/accounts?includeInactive=true'));
    expect(included.status).toBe(200);
    expect(included.body.accounts.some((row: {id: string; status: string}) =>
      row.id === empty.body.data.id && row.status === 'INACTIVE')).toBe(true);
  });

  it('rejects another tenant and a view-only user without changing the owner tenant', async () => {
    const created = await create(input('Owner till', 2_000));
    expect(created.status).toBe(201);
    const other = await seedTenant(pool, {
      name: 'Foreign business', permissions: [
        Permission.CASH_ACCOUNT_MANAGE, Permission.CASH_ACCOUNT_VIEW,
      ],
    });
    const viewer = await seedTenant(pool, {
      name: 'View only', permissions: [Permission.CASH_ACCOUNT_VIEW],
    });
    const before = await accountingState();
    const id = created.body.data.id as string;
    const otherEdit = await update(id, input('Hijacked till'), created.body.data.version as number,
      signToken(other, TEST_JWT_SECRET));
    expect(otherEdit.status).toBe(404);
    const viewerCreate = await create(input('Cannot create'), operationId(),
      signToken(viewer, TEST_JWT_SECRET));
    expect(viewerCreate.status).toBe(403);
    const otherStatement = await signed(api().get('/api/v1/money/accounts/' + id + '/statement'),
      signToken(other, TEST_JWT_SECRET));
    expect(otherStatement.status).toBe(404);
    expect(await accountingState()).toEqual(before);
    await assertGoldenInvariants(pool, other.tenantId);
    await assertGoldenInvariants(pool, viewer.tenantId);
  });
});
