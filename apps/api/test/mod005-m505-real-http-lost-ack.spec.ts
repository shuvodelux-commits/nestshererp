/*
 * M5-05: genuine lost HTTP ACK after durable Nest+Postgres cash session commit.
 * QA-only loopback proxy, registered dev-OTP owner and real auth refresh.
 */
import 'reflect-metadata';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SystemClock, Ulid } from '@sher/shared-utils';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { AppErrorFilter } from '../src/common/app-error.filter';
import { asTenant, prepareTestDatabase, resetDatabase, testPool, todayIn } from './support/database';
import { assertGoldenInvariants } from './support/invariants';
import { createRealNestLostAckProxy } from './support/mod005-real-nest-lost-ack-proxy';

const clock = new SystemClock();
const sentinel = 'MOD005_M505_REALACK_DISPOSABLE_20261114';
const suite = process.env['MOD005_M505_REALACK_TEST_ONLY'] === sentinel ? describe : describe.skip;
let app: INestApplication;
let pool: pg.Pool;
let target: string;
let token: string;
let refreshToken: string;
let tenantId: string;
let day: string;
const ulid = (): string => Ulid.generate(clock);
const api = (): ReturnType<typeof request> => request(app.getHttpServer());
const auth = (r: request.Test): request.Test => r.set('Authorization', 'Bearer ' + token);

function ensureDisposable(): void {
  if (process.env['MOD005_M505_REALACK_TEST_ONLY'] !== sentinel) {
    throw new Error('M5-05 real-ACK tests require explicit opt-in');
  }
  for (const name of ['DATABASE_URL', 'TEST_DATABASE_URL', 'ADMIN_DATABASE_URL']) {
    const value = process.env[name];
    if (!value) throw new Error('Missing exclusive DB URL ' + name);
    const url = new URL(value);
    if (url.protocol !== 'postgres:' || url.hostname !== '127.0.0.1' ||
      url.port !== '55744' || url.pathname !== '/hisabiq_mod005_m505_realack_20261114' ||
      url.username !== (name === 'ADMIN_DATABASE_URL' ? 'postgres' : 'sher_app')) {
      throw new Error('Refuse non-disposable M5-05 DB connection: ' + name);
    }
  }
}
interface State {
  readonly entries: number;
  readonly lines: number;
  readonly sessions: number;
  readonly closes: number;
  readonly audit: number;
  readonly outbox: number;
  readonly idempotency: number;
  readonly difference: number;
  readonly unbalanced: number;
}
async function snapshot(): Promise<State> {
  return asTenant(pool, tenantId, async db => {
    const r = await db.query<{
      entries: number; lines: number; sessions: number; closes: number;
      audit: number; outbox: number; idempotency: number;
      difference: string; unbalanced: number;
    }>(
      'SELECT ' +
      '(SELECT count(*)::int FROM journal_entries) AS entries, ' +
      '(SELECT count(*)::int FROM journal_lines) AS lines, ' +
      '(SELECT count(*)::int FROM cash_sessions) AS sessions, ' +
      '(SELECT count(*)::int FROM cash_session_closes) AS closes, ' +
      '(SELECT count(*)::int FROM audit_events) AS audit, ' +
      '(SELECT count(*)::int FROM outbox) AS outbox, ' +
      '(SELECT count(*)::int FROM idempotency_keys) AS idempotency, ' +
      "(SELECT coalesce(sum(amount_minor),0)::text FROM journal_lines WHERE account_code='CASH_SHORT_OVER') AS difference, " +
      '(SELECT count(*)::int FROM (SELECT je.id FROM journal_entries je ' +
      'JOIN journal_lines jl ON jl.journal_entry_id=je.id ' +
      'GROUP BY je.id HAVING sum(jl.amount_minor)<>0) bad) AS unbalanced',
    );
    const x = r.rows[0]!;
    return {
      entries: x.entries, lines: x.lines, sessions: x.sessions, closes: x.closes,
      audit: x.audit, outbox: x.outbox, idempotency: x.idempotency,
      difference: Number(x.difference), unbalanced: x.unbalanced,
    };
  });
}
async function tokenRefresh(): Promise<void> {
  const response = await api().post('/api/v1/auth/refresh').send({ refreshToken });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  // JWTs minted within one second can have byte-identical iat/exp values.
  // Rotation guarantees a NEW refresh token and revocation of the old one,
  // not necessarily distinct JWT bytes when the same user/claims are signed.
  expect(response.body.data.refreshToken).not.toBe(refreshToken);
  const previousRefreshToken = refreshToken;
  token = response.body.data.accessToken as string;
  refreshToken = response.body.data.refreshToken as string;
  const expired = await api().post('/api/v1/auth/refresh')
    .send({ refreshToken: previousRefreshToken });
  expect(expired.status).toBe(401);
}
async function operationAfterRealNetworkLoss(
  path: string, body: Record<string, unknown>,
): Promise<{ data: Record<string, unknown> }> {
  const proxy = await createRealNestLostAckProxy({ target, matchPath: path });
  try {
    await expect(fetch(proxy.endpoint + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(body),
    })).rejects.toThrow();
    const committed = await proxy.waitCommitted;
    expect(committed.status).toBe(201);
    return JSON.parse(committed.body) as { data: Record<string, unknown> };
  } finally {
    await proxy.close();
  }
}
async function startDay(): Promise<string> {
  const r = await auth(api().post('/api/v1/money/day/start')).send({
    businessDate: day, openingAmountMinor: 500_000, counterpartAccountCode: null,
    note: 'Counted and verified', operationId: ulid(),
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.data.id as string;
}
suite('M5-05 actual Nest commit followed by lost ACK, token refresh and ULID retry', () => {
  beforeAll(async () => {
    ensureDisposable();
    pool = testPool();
    await prepareTestDatabase();
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalFilters(new AppErrorFilter());
    await app.listen(0, '127.0.0.1');
    target = new URL(await app.getUrl()).origin;
    expect(new URL(target).hostname).toBe('127.0.0.1');
  }, 90_000);
  afterAll(async () => { await app?.close(); await pool?.end(); });
  beforeEach(async () => {
    await resetDatabase(pool);
    const otp = await api().post('/api/v1/auth/registration/otp')
      .send({ identifier: '01712345678' });
    expect(otp.status).toBeLessThan(400);
    const registered = await api().post('/api/v1/auth/registration').send({
      identifier: '01712345678', otpCode: otp.body.data.devCode as string,
      businessName: 'M5-05 disposable shop', username: 'cashowner',
      password: 'LostAckStrongP4ss', pin: '4821',
    });
    expect(registered.status, JSON.stringify(registered.body)).toBe(201);
    token = registered.body.data.accessToken as string;
    refreshToken = registered.body.data.refreshToken as string;
    tenantId = registered.body.data.tenant.id as string;
    day = todayIn('Asia/Dhaka');
    const account = await auth(api().post('/api/v1/money/accounts')).send({
      name: 'Counted test drawer', type: 'CASH', holderName: null, reference: null,
      isDrawer: true, openingAmountMinor: 500_000,
      openingDate: '2026-01-01', operationId: ulid(),
    });
    expect(account.status, JSON.stringify(account.body)).toBe(201);
  });
  afterEach(async () => {
    if (tenantId) await assertGoldenInvariants(pool, tenantId);
  });

  it('START lost ACK after commit, rotating refresh token and retrying exact operation has no effect', async () => {
    const body = {
      businessDate: day, openingAmountMinor: 500_000, counterpartAccountCode: null,
      note: 'Original start note', operationId: ulid(),
    };
    const previous = await snapshot();
    const committed = await operationAfterRealNetworkLoss('/api/v1/money/day/start', body);
    const after = await snapshot();
    expect(committed.data.status).toBe('OPEN');
    expect(after.sessions).toBe(previous.sessions + 1);
    expect(after.unbalanced).toBe(0);
    await tokenRefresh();
    const beforeRetry = await snapshot();
    const replay = await auth(api().post('/api/v1/money/day/start')).send(body);
    expect(replay.status, JSON.stringify(replay.body)).toBe(201);
    expect(replay.body).toEqual(committed);
    expect(await snapshot()).toEqual(beforeRetry);
    const altered = await auth(api().post('/api/v1/money/day/start')).send({
      ...body, note: 'Changed after the real commit',
    });
    expect(altered.status).toBe(409);
    expect(await snapshot()).toEqual(beforeRetry);
  });

  it('CLOSE lost ACK after actual shortage journal and replay never doubles the shortage', async () => {
    const sessionId = await startDay();
    const path = '/api/v1/money/day/' + sessionId + '/close';
    const body = { countedClosingMinor: 495_000, reason: 'Counted BDT 50 short', operationId: ulid() };
    const previous = await snapshot();
    const committed = await operationAfterRealNetworkLoss(path, body);
    const after = await snapshot();
    expect(committed.data.status).toBe('CLOSED');
    expect(after.closes).toBe(previous.closes + 1);
    expect(after.difference).not.toBe(previous.difference);
    await tokenRefresh();
    const beforeRetry = await snapshot();
    const replay = await auth(api().post(path)).send(body);
    expect(replay.status, JSON.stringify(replay.body)).toBe(201);
    expect(replay.body).toEqual(committed);
    expect(await snapshot()).toEqual(beforeRetry);
    const altered = await auth(api().post(path)).send({
      ...body, reason: 'Altered shortage explanation after commit',
    });
    expect(altered.status).toBe(409);
    expect(await snapshot()).toEqual(beforeRetry);
  });

  it('REOPEN lost ACK preserves one reversal, immutable original response and zero short-over', async () => {
    const sessionId = await startDay();
    const closed = await auth(api().post('/api/v1/money/day/' + sessionId + '/close')).send({
      countedClosingMinor: 495_000, reason: 'Count entered incorrectly', operationId: ulid(),
    });
    expect(closed.status, JSON.stringify(closed.body)).toBe(201);
    expect((await snapshot()).difference).not.toBe(0);
    const path = '/api/v1/money/day/' + sessionId + '/reopen';
    const body = { reason: 'Correct counted close', operationId: ulid() };
    const previous = await snapshot();
    const committed = await operationAfterRealNetworkLoss(path, body);
    const after = await snapshot();
    expect(committed.data.status).toBe('OPEN');
    expect(after.closes).toBe(previous.closes);
    expect(after.difference).toBe(0);
    await tokenRefresh();
    const beforeRetry = await snapshot();
    // Two concurrent identical retries after lost ACK must converge on the
    // single real Reopen side effect. Neither caller may post a second reversal.
    const [replay, parallel] = await Promise.all([
      auth(api().post(path)).send(body),
      auth(api().post(path)).send(body),
    ]);
    expect(replay.status, JSON.stringify(replay.body)).toBe(201);
    expect(parallel.status, JSON.stringify(parallel.body)).toBe(201);
    expect(replay.body).toEqual(committed);
    expect(parallel.body).toEqual(committed);
    expect(await snapshot()).toEqual(beforeRetry);
    const altered = await auth(api().post(path)).send({
      ...body, reason: 'Changed reason after the committed ACK drop',
    });
    expect(altered.status).toBe(409);
    expect(await snapshot()).toEqual(beforeRetry);
  });
});
