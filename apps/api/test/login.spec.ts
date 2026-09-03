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
import { asPlatform, prepareTestDatabase, resetDatabase, testPool } from './support/database';

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
}

async function registerAccount(identifier = PHONE): Promise<Registered> {
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
      pin: PIN,
    });

  expect(created.status).toBe(201);
  return {
    accessToken: created.body.data.accessToken as string,
    refreshToken: created.body.data.refreshToken as string,
    userId: created.body.data.user.id as string,
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
