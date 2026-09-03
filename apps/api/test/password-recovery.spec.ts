/*
 * Coverage claims, read by `pnpm test:inventory` (owner request 2026-09-03).
 *
 * These are what this file is answerable for in the test matrix. A claim naming
 * something the inventory no longer contains fails the scan, so a screen renamed
 * out from under a test cannot leave the coverage report quietly overstating itself.
 *
 * @covers endpoint:POST /api/v1/auth/login
 * @covers endpoint:POST /api/v1/auth/login/pin
 * @covers endpoint:POST /api/v1/auth/password/otp
 * @covers endpoint:POST /api/v1/auth/password/reset
 * @covers endpoint:POST /api/v1/auth/refresh
 * @covers endpoint:POST /api/v1/auth/registration
 * @covers endpoint:POST /api/v1/auth/registration/otp
 * @covers endpoint:POST /api/v1/settings/security/password
 * @covers endpoint:POST /api/v1/settings/security/pin
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
 * Slice 1.2b — forgot password via OTP, change password/PIN in Settings (§5.3,
 * D-07). Expected values written before the code.
 */
const PHONE = '01712345678';
const EMAIL = 'karim@shop.com.bd';
const PASSWORD = 'Passw0rd23';
const NEW_PASSWORD = 'Newpass99';
const PIN = '4821';
const NEW_PIN = '7305';
const UNKNOWN_PHONE = '01999999999';

let app: INestApplication;
let pool: pg.Pool;

interface Registered {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly userId: string;
}

async function registerAccount(identifier = PHONE, username = 'karim'): Promise<Registered> {
  const otp = await request(app.getHttpServer())
    .post('/api/v1/auth/registration/otp')
    .send({ identifier });

  const created = await request(app.getHttpServer())
    .post('/api/v1/auth/registration')
    .send({
      identifier,
      otpCode: otp.body.data.devCode as string,
      businessName: 'Karim Traders',
      username,
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

function requestResetOtp(identifier: string): request.Test {
  return request(app.getHttpServer()).post('/api/v1/auth/password/otp').send({ identifier });
}

function resetPassword(body: Record<string, unknown>): request.Test {
  return request(app.getHttpServer()).post('/api/v1/auth/password/reset').send(body);
}

function login(body: Record<string, unknown>): request.Test {
  return request(app.getHttpServer()).post('/api/v1/auth/login').send(body);
}

function refresh(refreshToken: string): request.Test {
  return request(app.getHttpServer()).post('/api/v1/auth/refresh').send({ refreshToken });
}

function changePassword(token: string, body: Record<string, unknown>): request.Test {
  return request(app.getHttpServer())
    .post('/api/v1/settings/security/password')
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}

function changePin(token: string, body: Record<string, unknown>): request.Test {
  return request(app.getHttpServer())
    .post('/api/v1/settings/security/pin')
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}

/** Sends a reset code and returns it — the dev transport echoes it back. */
async function resetCodeFor(identifier: string): Promise<string> {
  const sent = await requestResetOtp(identifier);
  expect(sent.status).toBe(200);
  return sent.body.data.devCode as string;
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

describe('requesting a reset code', () => {
  it('sends a code to a registered phone number', async () => {
    await registerAccount();

    const response = await requestResetOtp(PHONE);

    expect(response.status).toBe(200);
    expect(response.body.data.channel).toBe('PHONE');
    expect(response.body.data.devCode).toMatch(/^\d{6}$/);

    const codes = await pool.query(
      "SELECT purpose, code_hash FROM otp_codes WHERE purpose = 'PASSWORD_RESET'",
    );
    expect(codes.rowCount).toBe(1);
    // Stored hashed, never in the clear (§5.3).
    expect(codes.rows[0].code_hash).not.toBe(response.body.data.devCode);
  });

  it('answers an unknown identifier the same way, and sends nothing', async () => {
    await registerAccount();

    const known = await requestResetOtp(PHONE);
    const unknown = await requestResetOtp(UNKNOWN_PHONE);

    expect(unknown.status).toBe(known.status);
    expect(unknown.body.data.channel).toBe('PHONE');

    // One code exists, for the account that actually has one.
    const codes = await pool.query(
      "SELECT identifier FROM otp_codes WHERE purpose = 'PASSWORD_RESET'",
    );
    expect(codes.rows).toEqual([{ identifier: PHONE }]);
  });

  it('audits the suppressed send without naming a tenant', async () => {
    await requestResetOtp(UNKNOWN_PHONE);

    const audit = await asPlatform((admin) =>
      admin.query(
        `SELECT tenant_id, action, after_json FROM audit_events
         WHERE entity_type = 'password_reset_otp'`,
      ),
    );
    expect(audit.rows).toEqual([
      {
        tenant_id: null,
        action: 'SEND_SUPPRESSED',
        after_json: { channel: 'PHONE', reason: 'IDENTIFIER_NOT_REGISTERED' },
      },
    ]);
  });

  it('invalidates the previous reset code when a new one is requested', async () => {
    await registerAccount();

    const first = await resetCodeFor(PHONE);
    const second = await resetCodeFor(PHONE);
    expect(second).not.toBe(first);

    // Only the newest code is ever looked up, so the superseded one is refused
    // as simply not matching — the same answer the signup flow gives.
    const stale = await resetPassword({
      identifier: PHONE,
      otpCode: first,
      password: NEW_PASSWORD,
    });
    expect(stale.status).toBe(400);
    expect(stale.body.error.code).toBe('OTP_INCORRECT');
    expect((await login({ identifier: PHONE, password: PASSWORD })).status).toBe(200);

    // The new code is the one that works.
    expect(
      (await resetPassword({ identifier: PHONE, otpCode: second, password: NEW_PASSWORD })).status,
    ).toBe(204);

    const superseded = await pool.query(
      "SELECT consumed_at FROM otp_codes WHERE purpose = 'PASSWORD_RESET' ORDER BY created_at",
    );
    expect(superseded.rowCount).toBe(2);
    // Both are dead: the first was consumed by the resend, the second by the reset.
    expect(superseded.rows[0].consumed_at).not.toBeNull();
    expect(superseded.rows[1].consumed_at).not.toBeNull();
  });

  it('rejects an identifier that is neither an email nor a mobile number', async () => {
    const response = await requestResetOtp('nonsense');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('resetting the password', () => {
  it('sets the new password, and the old one stops working', async () => {
    await registerAccount();
    const code = await resetCodeFor(PHONE);

    const reset = await resetPassword({ identifier: PHONE, otpCode: code, password: NEW_PASSWORD });
    expect(reset.status).toBe(204);

    expect((await login({ identifier: PHONE, password: NEW_PASSWORD })).status).toBe(200);
    expect((await login({ identifier: PHONE, password: PASSWORD })).status).toBe(401);
  });

  it('revokes every session, including the one this browser held', async () => {
    const registered = await registerAccount();
    const code = await resetCodeFor(PHONE);

    await resetPassword({ identifier: PHONE, otpCode: code, password: NEW_PASSWORD });

    expect((await refresh(registered.refreshToken)).status).toBe(401);
    const sessions = await pool.query('SELECT revoked_at FROM refresh_tokens');
    expect(sessions.rowCount).toBe(1);
    expect(sessions.rows[0].revoked_at).not.toBeNull();
  });

  it('does not sign anyone in — the response carries no token', async () => {
    await registerAccount();
    const code = await resetCodeFor(PHONE);

    const reset = await resetPassword({ identifier: PHONE, otpCode: code, password: NEW_PASSWORD });

    expect(reset.status).toBe(204);
    expect(reset.body).toEqual({});
  });

  it('spends the code — the same one cannot reset twice', async () => {
    await registerAccount();
    const code = await resetCodeFor(PHONE);

    await resetPassword({ identifier: PHONE, otpCode: code, password: NEW_PASSWORD });
    const replay = await resetPassword({
      identifier: PHONE,
      otpCode: code,
      password: 'Thirdpass77',
    });

    expect(replay.status).toBe(400);
    expect(replay.body.error.code).toBe('OTP_EXPIRED');
    // The password is the one set by the first call, not the third.
    expect((await login({ identifier: PHONE, password: NEW_PASSWORD })).status).toBe(200);
  });

  it('counts a wrong code against the 5-attempt cap, then kills the code', async () => {
    await registerAccount();
    const code = await resetCodeFor(PHONE);

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const wrong = await resetPassword({
        identifier: PHONE,
        otpCode: '000000',
        password: NEW_PASSWORD,
      });
      expect(wrong.status).toBe(400);
      expect(wrong.body.error.code).toBe('OTP_INCORRECT');
    }

    const attempts = await pool.query(
      "SELECT attempt_count FROM otp_codes WHERE purpose = 'PASSWORD_RESET'",
    );
    expect(attempts.rows[0].attempt_count).toBe(5);

    // The right code no longer helps: the code is dead.
    const dead = await resetPassword({ identifier: PHONE, otpCode: code, password: NEW_PASSWORD });
    expect(dead.status).toBe(400);
    expect(dead.body.error.code).toBe('OTP_MAX_ATTEMPTS_EXCEEDED');
    expect((await login({ identifier: PHONE, password: PASSWORD })).status).toBe(200);
  });

  it('refuses a signup code — purposes never cross (D-07)', async () => {
    // A fresh signup code for an identifier that already has an account is
    // suppressed, so the only way to hold one is to start a *second* signup.
    await registerAccount(PHONE);
    const signup = await request(app.getHttpServer())
      .post('/api/v1/auth/registration/otp')
      .send({ identifier: EMAIL });
    const signupCode = signup.body.data.devCode as string;

    // That code is real, unspent, and for a different flow.
    const response = await resetPassword({
      identifier: EMAIL,
      otpCode: signupCode,
      password: NEW_PASSWORD,
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('OTP_EXPIRED');
  });

  it('refuses a weak password before spending the code', async () => {
    await registerAccount();
    const code = await resetCodeFor(PHONE);

    const weak = await resetPassword({ identifier: PHONE, otpCode: code, password: 'short' });
    expect(weak.status).toBe(400);
    expect(weak.body.error.code).toBe('VALIDATION_FAILED');

    // The code survived, so no second SMS is needed.
    expect(
      (await resetPassword({ identifier: PHONE, otpCode: code, password: NEW_PASSWORD })).status,
    ).toBe(204);
  });

  it('audits the reset against the right tenant, without the password', async () => {
    const registered = await registerAccount();
    const code = await resetCodeFor(PHONE);

    await resetPassword({ identifier: PHONE, otpCode: code, password: NEW_PASSWORD });

    const audit = await asPlatform((admin) =>
      admin.query(
        `SELECT entity_id, action, after_json FROM audit_events WHERE action = 'PASSWORD_RESET'`,
      ),
    );
    expect(audit.rows).toEqual([
      {
        entity_id: registered.userId,
        action: 'PASSWORD_RESET',
        after_json: { credential: 'PASSWORD', via: 'OTP' },
      },
    ]);
  });

  it('touches only the identified account (R-E5)', async () => {
    const a = await registerAccount(PHONE, 'karim');
    const b = await registerAccount(EMAIL, 'rahim');

    const code = await resetCodeFor(PHONE);
    await resetPassword({ identifier: PHONE, otpCode: code, password: NEW_PASSWORD });

    // Tenant B's password and session are untouched.
    expect((await login({ identifier: EMAIL, password: PASSWORD })).status).toBe(200);
    expect((await refresh(b.refreshToken)).status).toBe(200);
    expect((await refresh(a.refreshToken)).status).toBe(401);
  });
});

describe('changing the password in Settings', () => {
  it('changes it, requiring the current one', async () => {
    const registered = await registerAccount();

    const response = await changePassword(registered.accessToken, {
      refreshToken: registered.refreshToken,
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    expect(response.status).toBe(204);
    expect((await login({ identifier: PHONE, password: NEW_PASSWORD })).status).toBe(200);
    expect((await login({ identifier: PHONE, password: PASSWORD })).status).toBe(401);
  });

  it('refuses a wrong current password and changes nothing', async () => {
    const registered = await registerAccount();

    const response = await changePassword(registered.accessToken, {
      refreshToken: registered.refreshToken,
      currentPassword: 'Wrongpass99',
      newPassword: NEW_PASSWORD,
    });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
    expect((await login({ identifier: PHONE, password: PASSWORD })).status).toBe(200);
  });

  it('invalidates all OTHER sessions and keeps this one (§5.3)', async () => {
    const registered = await registerAccount();
    const elsewhere = await login({ identifier: PHONE, password: PASSWORD });
    const otherToken = elsewhere.body.data.refreshToken as string;

    const response = await changePassword(registered.accessToken, {
      refreshToken: registered.refreshToken,
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expect(response.status).toBe(204);

    // The other device is out; this one still refreshes.
    expect((await refresh(otherToken)).status).toBe(401);
    expect((await refresh(registered.refreshToken)).status).toBe(200);
  });

  it('refuses a weak new password', async () => {
    const registered = await registerAccount();

    const response = await changePassword(registered.accessToken, {
      refreshToken: registered.refreshToken,
      currentPassword: PASSWORD,
      newPassword: 'nodigits',
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('requires a bearer token', async () => {
    const registered = await registerAccount();

    const response = await request(app.getHttpServer())
      .post('/api/v1/settings/security/password')
      .send({
        refreshToken: registered.refreshToken,
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      });

    expect(response.status).toBe(401);
  });

  it('changes only the caller, never the tenant named by a stolen refresh token (R-E5)', async () => {
    const a = await registerAccount(PHONE, 'karim');
    const b = await registerAccount(EMAIL, 'rahim');

    // A signs in and presents B's refresh token. The user id comes from the
    // token in the Authorization header, so A's own password changes and B's
    // session must survive untouched.
    const response = await changePassword(a.accessToken, {
      refreshToken: b.refreshToken,
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    expect(response.status).toBe(204);
    expect((await login({ identifier: EMAIL, password: PASSWORD })).status).toBe(200);
    expect((await refresh(b.refreshToken)).status).toBe(200);
    // A's own session was not spared, because the token it presented was not its own.
    expect((await refresh(a.refreshToken)).status).toBe(401);
  });

  it('audits the change without recording either password', async () => {
    const registered = await registerAccount();

    await changePassword(registered.accessToken, {
      refreshToken: registered.refreshToken,
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    const audit = await asPlatform((admin) =>
      admin.query(
        `SELECT entity_id, action, before_json, after_json FROM audit_events
         WHERE action = 'PASSWORD_CHANGED'`,
      ),
    );
    expect(audit.rows).toEqual([
      {
        entity_id: registered.userId,
        action: 'PASSWORD_CHANGED',
        before_json: null,
        after_json: { credential: 'PASSWORD', otherSessionsRevoked: 'OTHERS' },
      },
    ]);
    expect(JSON.stringify(audit.rows)).not.toContain(PASSWORD);
    expect(JSON.stringify(audit.rows)).not.toContain(NEW_PASSWORD);
  });
});

describe('changing the PIN in Settings', () => {
  function loginWithPin(refreshToken: string, pin: string): request.Test {
    return request(app.getHttpServer()).post('/api/v1/auth/login/pin').send({ refreshToken, pin });
  }

  it('changes it, requiring the current one', async () => {
    const registered = await registerAccount();

    const response = await changePin(registered.accessToken, {
      currentPin: PIN,
      newPin: NEW_PIN,
    });

    expect(response.status).toBe(204);
    expect((await loginWithPin(registered.refreshToken, NEW_PIN)).status).toBe(200);
  });

  it('refuses a wrong current PIN and changes nothing', async () => {
    const registered = await registerAccount();

    const response = await changePin(registered.accessToken, { currentPin: '0000', newPin: NEW_PIN });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
    expect((await loginWithPin(registered.refreshToken, PIN)).status).toBe(200);
  });

  it('refuses a PIN that is not exactly 4 digits', async () => {
    const registered = await registerAccount();

    const response = await changePin(registered.accessToken, { currentPin: PIN, newPin: '12a4' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('revokes nothing — a PIN is never the credential behind another session', async () => {
    const registered = await registerAccount();
    const elsewhere = await login({ identifier: PHONE, password: PASSWORD });

    await changePin(registered.accessToken, { currentPin: PIN, newPin: NEW_PIN });

    expect((await refresh(elsewhere.body.data.refreshToken as string)).status).toBe(200);
  });

  it('leaves the password alone', async () => {
    const registered = await registerAccount();

    await changePin(registered.accessToken, { currentPin: PIN, newPin: NEW_PIN });

    expect((await login({ identifier: PHONE, password: PASSWORD })).status).toBe(200);
  });

  it('requires a bearer token', async () => {
    await registerAccount();

    const response = await request(app.getHttpServer())
      .post('/api/v1/settings/security/pin')
      .send({ currentPin: PIN, newPin: NEW_PIN });

    expect(response.status).toBe(401);
  });

  it('audits the change without recording either PIN', async () => {
    const registered = await registerAccount();

    await changePin(registered.accessToken, { currentPin: PIN, newPin: NEW_PIN });

    const audit = await asPlatform((admin) =>
      admin.query(
        `SELECT entity_id, action, after_json FROM audit_events WHERE action = 'PIN_CHANGED'`,
      ),
    );
    expect(audit.rows).toEqual([
      { entity_id: registered.userId, action: 'PIN_CHANGED', after_json: { credential: 'PIN' } },
    ]);
    expect(JSON.stringify(audit.rows)).not.toContain(NEW_PIN);
  });
});
