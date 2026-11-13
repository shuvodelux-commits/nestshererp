/*
 * MOD-006 T04 RED-first drawer/account lifecycle acceptance. TEST ONLY.
 * @covers endpoint:POST /api/v1/money/accounts
 * @covers endpoint:PATCH /api/v1/money/accounts/:id
 * @covers endpoint:POST /api/v1/money/day/start
 * @covers permission:cash.account.manage
 * @covers workflow:cash-session
 *
 * Intentionally fails on the currently merged baseline until drawer-edit
 * guards serialize with the OPEN physical cash day. Opt in ONLY with a
 * purpose-built, disposable PostgreSQL 16 database and exact sentinel.
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
const sentinel = 'MOD006_T04_DISPOSABLE_DRAWER_20261113';
const dbName = 'hisabiq_mod006_drawer_t04_20261113';
const dbPort = '55702';
const enabled = process.env['MOD006_T04_TEST_ONLY'] === sentinel;
const suite = enabled ? describe : describe.skip;

let app: INestApplication;
let pool: pg.Pool;
let tenant: SeededTenant;
let bearerToken: string;
let drawerId: string;
let drawerAccount: {
  name: string; type: 'CASH'; holderName: null; reference: null;
  isDrawer: boolean; openingAmountMinor: number; openingDate: string;
  version: number;
};
let businessDate: string;

function assertDedicatedDatabase(): void {
  if (process.env['MOD006_T04_TEST_ONLY'] !== sentinel) {
    throw new Error('T04 opt-in guard missing');
  }
  for (const key of ['DATABASE_URL', 'TEST_DATABASE_URL', 'ADMIN_DATABASE_URL']) {
    const raw = process.env[key];
    if (!raw) throw new Error('Missing private T04 URL: ' + key);
    const url = new URL(raw);
    const expectedRole = key === 'ADMIN_DATABASE_URL' ? 'postgres' : 'sher_app';
    if (url.protocol !== 'postgres:' || url.hostname !== '127.0.0.1' ||
        url.port !== dbPort || url.pathname !== '/' + dbName ||
        url.username !== expectedRole) {
      throw new Error('Refusing non-disposable or mismatched PostgreSQL URL');
    }
  }
}

const api = (): ReturnType<typeof request> => request(app.getHttpServer());
const signed = (r: request.Test): request.Test =>
  r.set('Authorization', 'Bearer ' + bearerToken);

async function snapshot(): Promise<unknown> {
  return asTenant(pool, tenant.tenantId, async (db) => {
    const account = await db.query(
      'SELECT id, type, is_drawer, version FROM money_accounts ORDER BY id',
    );
    const days = await db.query(
      'SELECT id, account_id, status, business_date, version FROM cash_sessions ORDER BY id',
    );
    const entries = await db.query(
      'SELECT id, source_type, business_date FROM journal_entries ORDER BY id',
    );
    const lines = await db.query(
      'SELECT id, account_code, amount_minor FROM journal_lines ORDER BY id',
    );
    return { account: account.rows, days: days.rows, entries: entries.rows, lines: lines.rows };
  });
}

suite('MOD-006 T04: active cash day owns its drawer identity', () => {
  beforeAll(async () => {
    assertDedicatedDatabase(); // before migration, fixture write or reset
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
      name: 'MOD006 T04 disposable shop',
      permissions: [
        Permission.CASH_ACCOUNT_VIEW, Permission.CASH_ACCOUNT_MANAGE,
        Permission.CASH_SESSION_START, Permission.CASH_SESSION_CLOSE,
        Permission.CASH_DAILY_VIEW, Permission.CASH_MOVEMENT_RECORD,
      ],
    });
    bearerToken = signToken(tenant, TEST_JWT_SECRET);
    businessDate = todayIn(tenant.timezone);

    const created = await signed(api().post('/api/v1/money/accounts')).send({
      name: 'Counted till', type: 'CASH', holderName: null, reference: null,
      isDrawer: true, openingAmountMinor: 500_000, openingDate: '2026-01-01',
      operationId: Ulid.generate(clock),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    drawerId = created.body.data.id as string;
    drawerAccount = {
      name: 'Counted till', type: 'CASH', holderName: null, reference: null,
      isDrawer: true, openingAmountMinor: 500_000, openingDate: '2026-01-01',
      version: created.body.data.version as number,
    };

    const started = await signed(api().post('/api/v1/money/day/start')).send({
      businessDate, openingAmountMinor: 500_000, counterpartAccountCode: null,
      note: null, operationId: Ulid.generate(clock),
    });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
  });

  afterEach(async () => {
    await assertGoldenInvariants(pool, tenant.tenantId);
  });

  it('allows changing only the drawer display name during an OPEN day', async () => {
    const updated = await signed(api().patch('/api/v1/money/accounts/' + drawerId))
      .send({ ...drawerAccount, name: 'Renamed counted till' });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body.data.isDrawer).toBe(true);
    const after = await asTenant(pool, tenant.tenantId, (db) =>
      db.query<{ status: string; account_id: string }>(
        "SELECT status, account_id FROM cash_sessions WHERE status='OPEN'",
      ));
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0]?.account_id).toBe(drawerId);
  });

  it('rejects removing the tracked drawer flag while its physical day is OPEN', async () => {
    const before = await snapshot();
    const attempted = await signed(api().patch('/api/v1/money/accounts/' + drawerId))
      .send({ ...drawerAccount, isDrawer: false });
    // RED-first: the current account editor accepts this with HTTP 200.
    expect(attempted.status, JSON.stringify(attempted.body)).toBe(400);
    expect(attempted.body.error?.code).toBe('VALIDATION_FAILED');
    expect(await snapshot()).toEqual(before);
  });
});
