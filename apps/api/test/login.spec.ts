/*
 * Coverage claims, read by `pnpm test:inventory` (owner request 2026-09-03).
 *
 * These are what this file is answerable for in the test matrix. A claim naming
 * something the inventory no longer contains fails the scan, so a screen renamed
 * out from under a test cannot leave the coverage report quietly overstating itself.
 *
 * @covers endpoint:GET /api/v1/dashboard/summary
 * @covers endpoint:POST /api/v1/auth/login
 * @covers endpoint:POST /api/v1/auth/login/google
 * @covers endpoint:POST /api/v1/auth/login/pin
 * @covers endpoint:POST /api/v1/auth/logout
 * @covers endpoint:POST /api/v1/auth/refresh
 * @covers endpoint:POST /api/v1/auth/registration
 * @covers endpoint:POST /api/v1/auth/registration/otp
 */
import 'reflect-metadata';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { AppErrorFilter } from '../src/common/app-error.filter';
import { asPlatform, asTenant, prepareTestDatabase, resetDatabase, testPool } from './support/database';

/**
 * Slice 1.2 — log in and log out (D-07). Expected values written before the code.
 */
const PHONE = '01712345678';
const EMAIL = 'karim@shop.com.bd';
const PASSWORD = 'Passw0rd23';
const PIN = '4821';

let app: INestApplication;
let pool: pg.Pool;

interface Registered {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly userId: string;
  readonly tenantId: string;
}

async function registerAccount(identifier = PHONE, pin = PIN): Promise<Registered> {
  const otp = await request(app.getHttpServer())
    .post('/api/v1/auth/registration/otp')
    .send({ identifier });

  const created = await request(app.getHttpServer())
    .post('/api/v1/auth/registration')
    .send({
      identifier,
      otpCode: otp.body.data.devCode as string,
      businessName: 'Karim Traders',
      username: 'karim',
      password: PASSWORD,
      pin,
    });

  expect(created.status).toBe(201);
  return {
    accessToken: created.body.data.accessToken as string,
    refreshToken: created.body.data.refreshToken as string,
    userId: created.body.data.user.id as string,
    tenantId: created.body.data.tenant.id as string,
  };
}

function login(body: Record<string, unknown>): request.Test {
  return request(app.getHttpServer()).post('/api/v1/auth/login').send(body);
}

function dashboard(token: string): request.Test {
  return request(app.getHttpServer())
    .get('/api/v1/dashboard/summary')
    .set('Authorization', `Bearer ${token}`);
}

beforeAll(async () => {
  pool = testPool();
  await prepareTestDatabase();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.useGlobalFilters(new AppErrorFilter());
  await app.init();
  // Keep one ephemeral listener for parallel PIN requests; otherwise Supertest
  // may start/close the same unbound HTTP server between in-flight requests.
  await app.listen(0);
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

beforeEach(async () => {
  await resetDatabase(pool);
});

describe('signing up leaves you signed in', () => {
  it('returns a refresh token alongside the access token', async () => {
    const registered = await registerAccount();

    expect(registered.refreshToken).toMatch(/^[\w-]{20,}$/);

    const sessions = await pool.query('SELECT token_hash, revoked_at FROM refresh_tokens');
    expect(sessions.rows).toHaveLength(1);
    expect(sessions.rows[0].revoked_at).toBeNull();
    // The raw token is never stored — only its hash.
    expect(sessions.rows[0].token_hash).not.toBe(registered.refreshToken);
  });
});

describe('logging in with a password', () => {
  it('works with the registered phone number', async () => {
    await registerAccount();

    const response = await login({ identifier: PHONE, password: PASSWORD });

    expect(response.status).toBe(200);
    expect(response.body.data.user.username).toBe('karim');
    expect(await dashboard(response.body.data.accessToken as string)).toMatchObject({
      status: 200,
    });
  });

  it('works with a registered email, case-insensitively', async () => {
    await registerAccount(EMAIL);

    const response = await login({ identifier: 'KARIM@SHOP.COM.BD', password: PASSWORD });

    expect(response.status).toBe(200);
  });

  it('answers a wrong password and an unknown identifier identically (§5.3)', async () => {
    await registerAccount();

    const wrongPassword = await login({ identifier: PHONE, password: 'Wrongpass99' });
    const unknownUser = await login({ identifier: '01999999999', password: PASSWORD });
    const notAnIdentifier = await login({ identifier: 'nonsense', password: PASSWORD });

    for (const response of [wrongPassword, unknownUser, notAnIdentifier]) {
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('UNAUTHENTICATED');
      expect(response.body.error.message).toBe('That login is not correct');
    }
  });

  it('audits a failed attempt without telling the caller why', async () => {
    await registerAccount();

    await login({ identifier: PHONE, password: 'Wrongpass99' });

    const audit = await asPlatform((admin) =>
      admin.query("SELECT action, after_json FROM audit_events WHERE action = 'LOGIN_FAILED'"),
    );
    expect(audit.rows).toEqual([{ action: 'LOGIN_FAILED', after_json: { method: 'PASSWORD' } }]);
  });

  it('mints a second session without disturbing the first', async () => {
    const registered = await registerAccount();

    const second = await login({ identifier: PHONE, password: PASSWORD });

    expect(second.status).toBe(200);
    expect(second.body.data.refreshToken).not.toBe(registered.refreshToken);
    expect((await pool.query('SELECT id FROM refresh_tokens')).rowCount).toBe(2);
    // Signing in on a second device must not sign the first one out.
    expect((await dashboard(registered.accessToken)).status).toBe(200);
  });
});

describe('PIN login (§5.3)', () => {
  function withPin(body: Record<string, unknown>): request.Test {
    return request(app.getHttpServer()).post('/api/v1/auth/login/pin').send(body);
  }

  it('unlocks a returning session on the same device', async () => {
    const registered = await registerAccount();

    const response = await withPin({ refreshToken: registered.refreshToken, pin: PIN });

    expect(response.status).toBe(200);
    expect((await dashboard(response.body.data.accessToken as string)).status).toBe(200);
  });

  it('registers a six-digit PIN, unlocks its own session and rotates the refresh credential', async () => {
    const sixDigitPin = '482193';
    const registered = await registerAccount(PHONE, sixDigitPin);
    const response = await withPin({ refreshToken: registered.refreshToken, pin: sixDigitPin });

    expect(response.status).toBe(200);
    expect(response.body.data.refreshToken).not.toBe(registered.refreshToken);
    expect((await dashboard(response.body.data.accessToken as string)).status).toBe(200);
    expect((await withPin({ refreshToken: registered.refreshToken, pin: sixDigitPin })).status).toBe(401);
    expect((await withPin({ refreshToken: response.body.data.refreshToken as string, pin: sixDigitPin })).status).toBe(200);
  });

  it('refuses a six-digit PIN when the refresh credential is invalid', async () => {
    await registerAccount(PHONE, '482193');
    const response = await withPin({ refreshToken: 'not-a-real-token', pin: '482193' });
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('refuses a wrong PIN', async () => {
    const registered = await registerAccount();

    const response = await withPin({ refreshToken: registered.refreshToken, pin: '0000' });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('is useless without this device\'s session — a PIN alone is never a login', async () => {
    await registerAccount();

    const response = await withPin({ refreshToken: 'not-a-real-token', pin: PIN });

    expect(response.status).toBe(401);
  });
});

describe('refresh and logout', () => {
  function refresh(refreshToken: string): request.Test {
    return request(app.getHttpServer()).post('/api/v1/auth/refresh').send({ refreshToken });
  }

  function logout(refreshToken: string): request.Test {
    return request(app.getHttpServer()).post('/api/v1/auth/logout').send({ refreshToken });
  }

  it('rotates the refresh token, and the old one stops working', async () => {
    const registered = await registerAccount();

    const rotated = await refresh(registered.refreshToken);
    expect(rotated.status).toBe(200);
    expect(rotated.body.data.refreshToken).not.toBe(registered.refreshToken);

    // The presented token is revoked, and the rotation is recorded.
    const replayed = await refresh(registered.refreshToken);
    expect(replayed.status).toBe(401);

    const rows = await pool.query(
      'SELECT revoked_at, rotated_to FROM refresh_tokens WHERE rotated_to IS NOT NULL',
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].revoked_at).not.toBeNull();

    // The replacement works.
    expect((await refresh(rotated.body.data.refreshToken as string)).status).toBe(200);
  });

  it('revokes the session on logout, so it cannot be refreshed again', async () => {
    const registered = await registerAccount();

    const out = await logout(registered.refreshToken);
    expect(out.status).toBe(204);

    expect((await refresh(registered.refreshToken)).status).toBe(401);

    const rows = await pool.query('SELECT revoked_at FROM refresh_tokens');
    expect(rows.rows[0].revoked_at).not.toBeNull();
  });

  it('is idempotent — logging out twice is not an error', async () => {
    const registered = await registerAccount();

    expect((await logout(registered.refreshToken)).status).toBe(204);
    expect((await logout(registered.refreshToken)).status).toBe(204);
    expect((await logout('never-existed')).status).toBe(204);
  });
});

describe('Google sign-in (D-07)', () => {
  it('refuses a token when no client id is configured, rather than trusting it', async () => {
    // The test environment sets no GOOGLE_CLIENT_ID, so there is no audience to
    // check against — and skipping that check is the classic vulnerability.
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login/google')
      .send({ idToken: 'anything.at.all' });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });
});

describe('tenant isolation across sessions (R-E5)', () => {
  it('each account sees only its own business', async () => {
    const a = await registerAccount(PHONE);
    const b = await registerAccount(EMAIL);

    const asA = await dashboard(a.accessToken);
    const asB = await dashboard(b.accessToken);

    expect(asA.status).toBe(200);
    expect(asB.status).toBe(200);
    expect(a.userId).not.toBe(b.userId);

    const sessions = await pool.query('SELECT DISTINCT tenant_id FROM refresh_tokens');
    expect(sessions.rowCount).toBe(2);
  });
});


/**
 * HisabIQ MOD-000-A / F0-02 readiness — follow-up to merged #25.
 * Only disposable PG16 and real signed Nest API, no production source changes.
 * Intentionally do not assert #27's known stale text-only validation message.
 */
describe('F0-02 readiness: legacy/new PIN security and tenant boundaries (#214)', () => {
  const withPin = (body: Record<string, unknown>): request.Test =>
    request(app.getHttpServer()).post('/api/v1/auth/login/pin').send(body);

  it('F002-03/09: refuses malformed registration PINs without consuming the verified OTP', async () => {
    const otp = await request(app.getHttpServer())
      .post('/api/v1/auth/registration/otp')
      .send({ identifier: PHONE });
    expect(otp.status).toBe(200);
    const payload = {
      identifier: PHONE,
      otpCode: otp.body.data.devCode as string,
      businessName: 'Karim Traders',
      username: 'karim',
      password: PASSWORD,
    };
    for (const pin of ['482', '48219', '4821937', '48219a', '৪৮২১৯৩', ' 482193', '482193 ']) {
      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/registration').send({ ...payload, pin });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
      expect(response.body.data).toBeUndefined();
    }
    expect((await pool.query('SELECT id FROM tenants')).rowCount).toBe(0);
    expect((await pool.query('SELECT id FROM refresh_tokens')).rowCount).toBe(0);

    // A rejected PIN is validation before OTP use, so the same verified OTP
    // can still complete exactly one legitimate six-digit registration.
    const accepted = await request(app.getHttpServer())
      .post('/api/v1/auth/registration').send({ ...payload, pin: '004821' });
    expect(accepted.status).toBe(201);
    expect((await pool.query('SELECT id FROM tenants')).rowCount).toBe(1);
    expect((await pool.query('SELECT id FROM refresh_tokens')).rowCount).toBe(1);
    const second = await request(app.getHttpServer())
      .post('/api/v1/auth/registration').send({ ...payload, pin: '004821' });
    expect(second.status).not.toBe(201);
    expect((await pool.query('SELECT id FROM tenants')).rowCount).toBe(1);
  });

  it('F002-01/02/05/07/10: legacy four and new six digit PINs never cross tenants or device refresh ownership', async () => {
    const a = await registerAccount(PHONE, '0482');
    const b = await registerAccount('01912345678', '004821');
    const aBefore = await request(app.getHttpServer())
      .get('/api/v1/me').set('Authorization', 'Bearer ' + a.accessToken);
    const bBefore = await request(app.getHttpServer())
      .get('/api/v1/me').set('Authorization', 'Bearer ' + b.accessToken);
    expect(aBefore.status).toBe(200);
    expect(bBefore.status).toBe(200);
    expect(aBefore.body.data.tenantId).toBe(a.tenantId);
    expect(bBefore.body.data.tenantId).toBe(b.tenantId);
    expect(a.tenantId).not.toBe(b.tenantId);

    for (const response of [
      await withPin({ refreshToken: a.refreshToken, pin: '004821' }),
      await withPin({ refreshToken: b.refreshToken, pin: '0482' }),
      await withPin({ refreshToken: a.refreshToken, pin: '0482', tenantId: b.tenantId }),
    ]) {
      expect([400, 401]).toContain(response.status);
      expect(response.body.data).toBeUndefined();
    }
    expect((await pool.query('SELECT id FROM refresh_tokens')).rowCount).toBe(2);
    const aValid = await withPin({ refreshToken: a.refreshToken, pin: '0482' });
    const bValid = await withPin({ refreshToken: b.refreshToken, pin: '004821' });
    expect(aValid.status).toBe(200);
    expect(bValid.status).toBe(200);
    expect(aValid.body.data.user.id).toBe(a.userId);
    expect(bValid.body.data.user.id).toBe(b.userId);
    expect(aValid.body.data.refreshToken).not.toBe(a.refreshToken);
    expect(bValid.body.data.refreshToken).not.toBe(b.refreshToken);
    const aAfter = await request(app.getHttpServer())
      .get('/api/v1/me').set('Authorization', 'Bearer ' + aValid.body.data.accessToken);
    const bAfter = await request(app.getHttpServer())
      .get('/api/v1/me').set('Authorization', 'Bearer ' + bValid.body.data.accessToken);
    expect(aAfter.body.data.tenantId).toBe(a.tenantId);
    expect(bAfter.body.data.tenantId).toBe(b.tenantId);
    expect((await withPin({ refreshToken: a.refreshToken, pin: '0482' })).status).toBe(401);
    expect((await withPin({ refreshToken: b.refreshToken, pin: '004821' })).status).toBe(401);
  });

  it('F002-03/04/06: failed PIN attempts append own audit only, never rotate a still-live device credential', async () => {
    const b = await registerAccount('01912345678', '482193');
    const before = (await pool.query(
      'SELECT token_hash, revoked_at, rotated_to FROM refresh_tokens WHERE tenant_id=$1 ORDER BY id',
      [b.tenantId],
    )).rows;
    const malformed = ['000000', '48219', '4821937', '48219a', '৪৮২১৯৩'];
    for (const pin of malformed) {
      const response = await withPin({ refreshToken: b.refreshToken, pin });
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('UNAUTHENTICATED');
      expect(response.body.data).toBeUndefined();
    }
    const after = (await pool.query(
      'SELECT token_hash, revoked_at, rotated_to FROM refresh_tokens WHERE tenant_id=$1 ORDER BY id',
      [b.tenantId],
    )).rows;
    expect(after).toEqual(before);
    const audit = await asTenant(pool, b.tenantId, (client) => client.query(
      "SELECT after_json FROM audit_events WHERE action='LOGIN_FAILED' ORDER BY id",
    ));
    expect(audit.rows).toHaveLength(malformed.length);
    expect(audit.rows.every((entry) => entry.after_json.method === 'PIN')).toBe(true);
    expect(JSON.stringify(audit.rows)).not.toContain('482193');
    expect(JSON.stringify(audit.rows)).not.toContain(b.refreshToken);

    const valid = await withPin({ refreshToken: b.refreshToken, pin: '482193' });
    expect(valid.status).toBe(200);
    expect(valid.body.data.user.id).toBe(b.userId);
    expect((await withPin({ refreshToken: b.refreshToken, pin: '482193' })).status).toBe(401);
  });

  it('F002-04/11: an expired device refresh cannot be revived even with the correct six digit PIN', async () => {
    const a = await registerAccount(PHONE, '482193');
    await pool.query('UPDATE refresh_tokens SET expires_at=$1 WHERE tenant_id=$2',
      ['2000-01-01T00:00:00Z', a.tenantId]);
    const before = (await pool.query('SELECT id, revoked_at FROM refresh_tokens')).rows;
    const refused = await withPin({ refreshToken: a.refreshToken, pin: '482193' });
    expect(refused.status).toBe(401);
    expect(refused.body.error.code).toBe('UNAUTHENTICATED');
    expect((await pool.query('SELECT id, revoked_at FROM refresh_tokens')).rows).toEqual(before);
    const loggedOut = await request(app.getHttpServer())
      .post('/api/v1/auth/logout').send({ refreshToken: a.refreshToken });
    expect(loggedOut.status).toBe(204);
    expect((await withPin({ refreshToken: a.refreshToken, pin: '482193' })).status).toBe(401);
  });

  it('F002-08/11: concurrent PIN requests must not issue two valid rotations from one refresh', async () => {
    const a = await registerAccount(PHONE, '482193');
    const outcomes = await Promise.allSettled(Array.from({ length: 6 }, () =>
      withPin({ refreshToken: a.refreshToken, pin: '482193' }),
    ));
    expect(outcomes.every((result) => result.status === 'fulfilled')).toBe(true);
    const responses = outcomes
      .filter((result): result is PromiseFulfilledResult<request.Response> => result.status === 'fulfilled')
      .map((result) => result.value);
    expect(responses).toHaveLength(6);
    const ok = responses.filter((response) => response.status === 200);
    const refused = responses.filter((response) => response.status === 401);
    // Security invariant: a stolen/replayed device refresh may rotate only once.
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(5);
    expect(ok[0]!.body.data.user.id).toBe(a.userId);
    expect((await withPin({ refreshToken: a.refreshToken, pin: '482193' })).status).toBe(401);
    const acceptedReplacement = ok[0]!.body.data.refreshToken as string;
    expect((await withPin({ refreshToken: acceptedReplacement, pin: '482193' })).status).toBe(200);
    const sessions = await pool.query(
      'SELECT id, revoked_at, rotated_to FROM refresh_tokens WHERE tenant_id=$1 ORDER BY created_at',
      [a.tenantId],
    );
    // Registration, first rotation, and second rotation with the accepted child.
    expect(sessions.rows).toHaveLength(3);
  });
});
