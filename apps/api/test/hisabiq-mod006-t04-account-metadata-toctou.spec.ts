/*
 * MOD-006 T04 / issue #135: RED-first account-type eligibility TOCTOU.
 * Only synthetic signed Nest API calls and disposable PostgreSQL16.
 * The pause is at the repository seam AFTER the application has already read
 * bank/MFS eligibility, BEFORE its account-row SELECT FOR UPDATE.
 * No direct account/journal SQL writes or production source modifications.
 *
 * @covers endpoint:POST /api/v1/money/accounts
 * @covers endpoint:PATCH /api/v1/money/accounts/:id
 * @covers endpoint:POST /api/v1/money/reconciliations
 */
import 'reflect-metadata';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { ReconciliationRepository } from '@sher/core-application';
import { Permission } from '@sher/core-contracts';
import { SystemClock, Ulid } from '@sher/shared-utils';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import { AppErrorFilter } from '../src/common/app-error.filter';
import { RECONCILIATION_REPOSITORY } from '../src/infrastructure/tokens';
import { signToken, TEST_JWT_SECRET } from './support/auth';
import type { SeededTenant } from './support/database';
import { asTenant, prepareTestDatabase, resetDatabase, seedTenant, testPool } from './support/database';
import { assertGoldenInvariants } from './support/invariants';

const sentinel = 'MOD006_T04_ACCOUNT_TOCTOU_DISPOSABLE_ONLY_20261114';
const dbName = 'hisabiq_mod006_t04_toctou_20261114';
const dbPort = '55763';
const clock = new SystemClock();
const suite = process.env['MOD006_T04_ACCOUNT_TOCTOU_TEST_ONLY'] === sentinel
  ? describe : describe.skip;

let app: INestApplication;
let pool: pg.Pool;
let tenant: SeededTenant;
let bearer: string;
let repo: ReconciliationRepository;

const api = (): ReturnType<typeof request> => request(app.getHttpServer());
const op = (): string => Ulid.generate(clock);
const signed = (req: request.Test, token = bearer): request.Test =>
  req.set('Authorization', 'Bearer ' + token);

function guardDisposableDatabase(): void {
  if (process.env['MOD006_T04_ACCOUNT_TOCTOU_TEST_ONLY'] !== sentinel) {
    throw new Error('T04 TOCTOU requires its explicit disposable-only sentinel');
  }
  for (const key of ['DATABASE_URL', 'TEST_DATABASE_URL', 'ADMIN_DATABASE_URL']) {
    const value = process.env[key];
    if (!value) throw new Error('Missing explicit isolated test connection: ' + key);
    const url = new URL(value);
    const expectedUser = key === 'ADMIN_DATABASE_URL' ? 'postgres' : 'sher_app';
    if (url.protocol !== 'postgres:' || url.hostname !== '127.0.0.1' ||
        url.port !== dbPort || url.pathname !== '/' + dbName ||
        url.username !== expectedUser) {
      throw new Error('Refusing non-disposable database, role, host or port: ' + key);
    }
  }
}

type AccountType = 'BANK' | 'MFS' | 'LOAN' | 'CASH';
function accountInput(type: AccountType) {
  return {
    name: 'T04 race account ' + type, type, holderName: null, reference: null,
    isDrawer: false, openingAmountMinor: 0, openingDate: null,
  };
}
async function createAccount(type: 'BANK' | 'MFS') {
  const res = await signed(api().post('/api/v1/money/accounts'))
    .send({ ...accountInput(type), operationId: op() });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { id: res.body.data.id as string, version: res.body.data.version as number };
}
const reconcile = (accountId: string) =>
  signed(api().post('/api/v1/money/reconciliations'))
    .send({ accountId, fromDate: '2026-08-01', toDate: '2026-08-31', operationId: op() });
const patchType = (id: string, version: number, type: AccountType) =>
  signed(api().patch('/api/v1/money/accounts/' + id))
    .send({ ...accountInput(type), version });

async function snapshot(accountId: string) {
  return asTenant(pool, tenant.tenantId, async db => {
    const rows = await db.query<{ type: AccountType }>(
      'SELECT type FROM accounts WHERE id = $1', [accountId],
    );
    const counts = await db.query<{
      reconciliations: number; journals: number; lines: number; sessions: number;
    }>(
      'SELECT (SELECT COUNT(*)::int FROM account_reconciliations) AS reconciliations, ' +
      '(SELECT COUNT(*)::int FROM journal_entries) AS journals, ' +
      '(SELECT COUNT(*)::int FROM journal_lines) AS lines, ' +
      '(SELECT COUNT(*)::int FROM cash_sessions) AS sessions',
    );
    return { type: rows.rows[0]?.type, ...counts.rows[0] };
  });
}

suite('MOD-006 T04: account eligibility cannot turn stale during reconciliation start', () => {
  beforeAll(async () => {
    guardDisposableDatabase(); // MUST run before schema/fixture activity.
    pool = testPool();
    await prepareTestDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    repo = moduleRef.get<ReconciliationRepository>(RECONCILIATION_REPOSITORY, { strict: false });
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AppErrorFilter());
    await app.init();
  }, 60_000);

  afterAll(async () => { await app?.close(); await pool?.end(); });
  beforeEach(async () => {
    await resetDatabase(pool);
    tenant = await seedTenant(pool, {
      name: 'TOCTOU test-only hardware shop',
      permissions: [
        Permission.BANK_ACCOUNT_VIEW, Permission.BANK_ACCOUNT_MANAGE,
        Permission.CASH_ACCOUNT_VIEW, Permission.CASH_ACCOUNT_MANAGE,
        Permission.LOAN_ACCOUNT_MANAGE,
        Permission.RECONCILIATION_VIEW, Permission.RECONCILIATION_PERFORM,
      ],
    });
    bearer = signToken(tenant, TEST_JWT_SECRET);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    if (tenant?.tenantId) await assertGoldenInvariants(pool, tenant.tenantId);
  });

  it.each([
    ['BANK', 'LOAN'],
    ['MFS', 'CASH'],
  ] as const)(
    'RED: rejects stale %s eligibility after authenticated account PATCH to %s',
    async (initial, changedType) => {
      const account = await createAccount(initial);
      const originalFind = repo.findDraftForAccount.bind(repo);
      let reachGap!: () => void;
      let resume!: () => void;
      const reached = new Promise<void>(resolve => { reachGap = resolve; });
      const hold = new Promise<void>(resolve => { resume = resolve; });
      // Pause ONLY the first invocation (reconciliation start). The account
      // PATCH uses the same repository locking method after the source fix;
      // pausing both would deadlock the test itself instead of modeling the race.
      let startPaused = false;
      const spy = vi.spyOn(repo, 'findDraftForAccount').mockImplementation(async (...args) => {
        if (args[2] === account.id && !startPaused) {
          startPaused = true;
          reachGap();
          await hold;
        }
        return originalFind(...args);
      });

      // A real authenticated request enters the application and reads BANK/MFS
      // BEFORE it calls the repository account-locking method.
      const pending = reconcile(account.id).then(response => response);
      try {
        await reached;
        // Account PATCH uses the real service/tenant lock and commits while
        // reconciliation is paused; no source or SQL mutation is faked.
        const changed = await patchType(account.id, account.version, changedType);
        expect(changed.status, JSON.stringify(changed.body)).toBe(200);
      } finally {
        resume(); // Never leave another request suspended after an assertion.
      }

      const attempt = await pending;
      spy.mockRestore();
      // A stale pre-lock BANK/MFS decision must not create a draft on a
      // newly non-reconcilable LOAN liability or CASH account.
      expect(attempt.status, JSON.stringify(attempt.body)).toBe(400);
      expect(await snapshot(account.id)).toEqual({
        type: changedType, reconciliations: 0, journals: 0, lines: 0, sessions: 0,
      });
    },
    40_000,
  );

  it.each([
    ['BANK', 'LOAN'],
    ['MFS', 'CASH'],
  ] as const)(
    'RED: forbids retyping %s to %s while its statement reconciliation is DRAFT',
    async (initial, changedType) => {
      const account = await createAccount(initial);
      const draft = await reconcile(account.id);
      expect(draft.status, JSON.stringify(draft.body)).toBe(201);

      const attempt = await patchType(account.id, account.version, changedType);
      expect(attempt.status, JSON.stringify(attempt.body)).toBe(400);
      expect(await snapshot(account.id)).toEqual({
        type: initial, reconciliations: 1, journals: 0, lines: 0, sessions: 0,
      });
    },
  );

  it('allows a harmless same-type metadata edit while bank reconciliation is DRAFT', async () => {
    const account = await createAccount('BANK');
    const draft = await reconcile(account.id);
    expect(draft.status).toBe(201);
    const changed = await patchType(account.id, account.version, 'BANK');
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(await snapshot(account.id)).toEqual({
      type: 'BANK', reconciliations: 1, journals: 0, lines: 0, sessions: 0,
    });
  });

  it('accepts an unchanged BANK account and does not post journals', async () => {
    const account = await createAccount('BANK');
    const res = await reconcile(account.id);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await snapshot(account.id)).toEqual({
      type: 'BANK', reconciliations: 1, journals: 0, lines: 0, sessions: 0,
    });
  });
});
