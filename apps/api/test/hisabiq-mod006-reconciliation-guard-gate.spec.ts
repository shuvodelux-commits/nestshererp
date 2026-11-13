/*
 * MOD-006 T04 — real Nest/PostgreSQL reconciliation isolation/identity gate.
 * RED-first: changing a reconciliation start request under the same operationId
 * must refuse the replay instead of silently returning the old workspace.
 *
 * @covers endpoint:GET /api/v1/money/reconciliations
 * @covers endpoint:GET /api/v1/money/reconciliations/:id
 * @covers endpoint:GET /api/v1/money/reconciliations/:id/statement/:fileId/file
 * @covers endpoint:POST /api/v1/money/reconciliations
 * @covers endpoint:POST /api/v1/money/reconciliations/:id/statement
 */
import 'reflect-metadata';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { asTenant, prepareTestDatabase, resetDatabase, seedTenant, testPool } from './support/database';
import { assertGoldenInvariants } from './support/invariants';

const sentinel = 'MOD006_T04_RECON_DISPOSABLE_20261113';
const database = 'hisabiq_mod006_recon_t04_20261113';
const port = '55720';
const clock = new SystemClock();
const suite = process.env['MOD006_T04_RECON_TEST_ONLY'] === sentinel ? describe : describe.skip;
const full = [
  Permission.BANK_ACCOUNT_VIEW, Permission.BANK_ACCOUNT_MANAGE,
  Permission.RECONCILIATION_VIEW, Permission.RECONCILIATION_PERFORM,
  Permission.RECONCILIATION_REOPEN,
];
const PDF = readFileSync(join(__dirname, 'support/fixtures/statement.pdf'));

let app: INestApplication;
let pool: pg.Pool;
let shopA: SeededTenant;
let shopB: SeededTenant;
let tokenA: string;
let tokenB: string;
let accountId: string;

function assertDisposable(): void {
  if (process.env['MOD006_T04_RECON_TEST_ONLY'] !== sentinel) {
    throw new Error('T04 reconciliation opt-in sentinel missing');
  }
  for (const key of ['DATABASE_URL', 'TEST_DATABASE_URL', 'ADMIN_DATABASE_URL']) {
    const value = process.env[key];
    if (!value) throw new Error('T04 reconciliation database URL is absent: ' + key);
    const url = new URL(value);
    if (url.protocol !== 'postgres:' || url.hostname !== '127.0.0.1' ||
        url.port !== port || url.pathname !== '/' + database ||
        url.username !== (key === 'ADMIN_DATABASE_URL' ? 'postgres' : 'sher_app')) {
      throw new Error('Refusing non-disposable reconciliation database URL: ' + key);
    }
  }
}
const api = () => request(app.getHttpServer());
function startBody(operationId = Ulid.generate(clock)) {
  return { accountId, fromDate: '2026-08-01', toDate: '2026-08-31', operationId };
}
function postStart(body = startBody()) {
  return api().post('/api/v1/money/reconciliations')
    .set('Authorization', 'Bearer ' + tokenA).send(body);
}
async function start(): Promise<string> {
  const response = await postStart();
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data.id as string;
}
async function footprint(target: SeededTenant) {
  return asTenant(pool, target.tenantId, async (db) => {
    const result = await db.query(
      "SELECT (SELECT count(*)::int FROM journal_entries) AS entries," +
      " (SELECT count(*)::int FROM journal_lines) AS lines," +
      " (SELECT count(*)::int FROM cash_sessions) AS cash_days," +
      " (SELECT count(*)::int FROM account_reconciliations) AS reconciliations",
    );
    return result.rows[0] as { entries: number; lines: number; cash_days: number; reconciliations: number };
  });
}

suite('MOD-006 T04 reconciliation security, idempotency and original evidence', () => {
  beforeAll(async () => {
    assertDisposable(); // must run before any migration/seed/reset
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
    shopA = await seedTenant(pool, { name: 'T04 Bank A', permissions: full });
    shopB = await seedTenant(pool, { name: 'T04 Bank B', permissions: full });
    tokenA = signToken(shopA, TEST_JWT_SECRET);
    tokenB = signToken(shopB, TEST_JWT_SECRET);

    const created = await api().post('/api/v1/money/accounts')
      .set('Authorization', 'Bearer ' + tokenA)
      .send({
        name: 'Bank A', type: 'BANK', isDrawer: false,
        holderName: null, reference: null, openingAmountMinor: 0,
        openingDate: null, operationId: Ulid.generate(clock),
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    accountId = created.body.data.id as string;
  });

  afterEach(async () => {
    await assertGoldenInvariants(pool, shopA.tenantId);
    await assertGoldenInvariants(pool, shopB.tenantId);
  });

  it('creates exactly one draft with a replayed operationId; bank-only never starts a cash day', async () => {
    const body = startBody();
    const first = await postStart(body);
    const second = await postStart(body);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(await footprint(shopA)).toMatchObject({
      entries: 0, lines: 0, cash_days: 0, reconciliations: 1,
    });
  });

  it('refuses changed-body operationId replay without reusing a different bank period', async () => {
    const body = startBody();
    const first = await postStart(body);
    expect(first.status).toBe(201);
    const changed = await postStart({ ...body, fromDate: '2026-07-01' });
    // RED on the existing source: it returns HTTP 201 and the old workspace.
    expect(changed.status, JSON.stringify(changed.body)).toBe(409);
    expect(changed.body.error?.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await footprint(shopA)).toMatchObject({ entries: 0, lines: 0, reconciliations: 1 });
  });

  it('rejects reversed date ranges and duplicate simultaneous drafts without financial writes', async () => {
    const malformed = await postStart({ ...startBody(), fromDate: '2026-09-01' });
    expect(malformed.status).toBe(400);
    const id = await start();
    const duplicate = await postStart();
    expect(duplicate.status).toBe(400);
    const list = await api().get('/api/v1/money/reconciliations')
      .set('Authorization', 'Bearer ' + tokenA);
    expect(list.status).toBe(200);
    expect(list.body.rows.map((row: { id: string }) => row.id)).toEqual([id]);
    expect(await footprint(shopA)).toMatchObject({ entries: 0, lines: 0, reconciliations: 1 });
  });

  it('keeps the list/account filter/workspace private from a second tenant', async () => {
    const id = await start();
    const listed = await api().get('/api/v1/money/reconciliations?accountId=' + accountId)
      .set('Authorization', 'Bearer ' + tokenA);
    expect(listed.status).toBe(200);
    expect(listed.body.rows).toHaveLength(1);
    const empty = await api().get('/api/v1/money/reconciliations')
      .set('Authorization', 'Bearer ' + tokenB);
    expect(empty.status).toBe(200);
    expect(empty.body.rows).toEqual([]);
    const stolen = await api().get('/api/v1/money/reconciliations/' + id)
      .set('Authorization', 'Bearer ' + tokenB);
    expect(stolen.status).toBe(404);
  });

  it('denies list and start without their separate reconciliation permissions', async () => {
    const limited = await seedTenant(pool, {
      name: 'T04 Read Bank Only', permissions: [Permission.BANK_ACCOUNT_VIEW],
    });
    const limitedToken = signToken(limited, TEST_JWT_SECRET);
    const list = await api().get('/api/v1/money/reconciliations')
      .set('Authorization', 'Bearer ' + limitedToken);
    const create = await api().post('/api/v1/money/reconciliations')
      .set('Authorization', 'Bearer ' + limitedToken).send(startBody());
    expect(list.status).toBe(403);
    expect(create.status).toBe(403);
    expect(await footprint(shopA)).toMatchObject({ entries: 0, lines: 0, reconciliations: 0 });
  });

  it('serves exact original bank statement bytes only to its own tenant, without journal writes', async () => {
    const id = await start();
    const before = await footprint(shopA);
    const uploaded = await api().post('/api/v1/money/reconciliations/' + id + '/statement')
      .set('Authorization', 'Bearer ' + tokenA)
      .send({ fileName: 'original.pdf', contentBase64: PDF.toString('base64') });
    expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(200);
    const fileId = uploaded.body.data.fileId as string;

    const download = (auth: string) => api()
      .get('/api/v1/money/reconciliations/' + id + '/statement/' + fileId + '/file')
      .set('Authorization', 'Bearer ' + auth)
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    const own = await download(tokenA);
    expect(own.status).toBe(200);
    expect(Buffer.compare(own.body as Buffer, PDF)).toBe(0);
    const denied = await download(tokenB);
    expect(denied.status).toBe(404);
    expect(await footprint(shopA)).toEqual({ ...before, reconciliations: 1 });
  });
});
