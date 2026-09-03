/*
 * Coverage claims, read by `pnpm test:inventory` (owner request 2026-09-03).
 *
 * These are what this file is answerable for in the test matrix. A claim naming
 * something the inventory no longer contains fails the scan, so a screen renamed
 * out from under a test cannot leave the coverage report quietly overstating itself.
 *
 * @covers endpoint:GET /api/v1/settings/security
 * @covers endpoint:POST /api/v1/auth/login
 * @covers endpoint:POST /api/v1/auth/login/pin
 * @covers endpoint:POST /api/v1/auth/refresh
 * @covers endpoint:POST /api/v1/auth/registration
 * @covers endpoint:POST /api/v1/auth/registration/google
 * @covers endpoint:POST /api/v1/auth/registration/otp
 * @covers endpoint:POST /api/v1/settings/security/password
 * @covers endpoint:POST /api/v1/settings/security/pin
 */
import 'reflect-metadata';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { GoogleIdentity, GoogleVerifier } from '@sher/core-application';
import { AppError, ErrorCode } from '@sher/core-contracts';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { AppErrorFilter } from '../src/common/app-error.filter';
import { GOOGLE_VERIFIER } from '../src/infrastructure/tokens';
import { asTenant, prepareTestDatabase, resetDatabase, testPool } from './support/database';

/**
 * Settings → Security: **setting** a first password or PIN, and **changing**
 * one that already exists (§5.3).
 *
 * An account created through Google holds neither credential — Google is the
 * credential (D-07). Until it can set one, that owner can never sign in on a
 * device where Google is unavailable, and can never use a PIN. The rule this
 * suite pins down is that the *stored* state decides which is required, never
 * what the caller chose to send.
 */
const GOOGLE_EMAIL = 'shopkeeper@gmail.com';
const PHONE = '01712345678';
const PASSWORD = 'Passw0rd23';
const NEW_PASSWORD = 'Passw0rd99';
const PIN = '4821';
const NEW_PIN = '1357';

class FakeGoogleVerifier implements GoogleVerifier {
  verify(idToken: string): Promise<GoogleIdentity> {
    if (!idToken.startsWith('valid:')) {
      return Promise.reject(new AppError(ErrorCode.UNAUTHENTICATED, 'Invalid Google token'));
    }
    return Promise.resolve({ email: idToken.slice('valid:'.length) });
  }
}

let app: INestApplication;
let pool: pg.Pool;

interface Account {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly tenantId: string;
}

/** A Google signup: no password, no PIN. */
async function googleAccount(email = GOOGLE_EMAIL): Promise<Account> {
  const created = await request(app.getHttpServer())
    .post('/api/v1/auth/registration/google')
    .send({ idToken: `valid:${email}`, businessName: 'Karim Traders' });

  expect(created.status).toBe(201);
  return {
    accessToken: created.body.data.accessToken as string,
    refreshToken: created.body.data.refreshToken as string,
    tenantId: created.body.data.tenant.id as string,
  };
}

/** An OTP signup: both credentials set from the start. */
async function passwordAccount(identifier = PHONE): Promise<Account> {
  const otp = await request(app.getHttpServer())
    .post('/api/v1/auth/registration/otp')
    .send({ identifier });

  const created = await request(app.getHttpServer())
    .post('/api/v1/auth/registration')
    .send({
      identifier,
      otpCode: otp.body.data.devCode as string,
      businessName: 'Rahman Store',
      username: 'rahman',
      password: PASSWORD,
      pin: PIN,
    });

  expect(created.status).toBe(201);
  return {
    accessToken: created.body.data.accessToken as string,
    refreshToken: created.body.data.refreshToken as string,
    tenantId: created.body.data.tenant.id as string,
  };
}

function readSettings(token: string): request.Test {
  return request(app.getHttpServer())
    .get('/api/v1/settings/security')
    .set('Authorization', `Bearer ${token}`);
}

function putPassword(token: string, body: Record<string, unknown>): request.Test {
  return request(app.getHttpServer())
    .post('/api/v1/settings/security/password')
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}

function putPin(token: string, body: Record<string, unknown>): request.Test {
  return request(app.getHttpServer())
    .post('/api/v1/settings/security/pin')
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}

function login(identifier: string, password: string): request.Test {
  return request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ identifier, password });
}

function loginWithPin(refreshToken: string, pin: string): request.Test {
  return request(app.getHttpServer())
    .post('/api/v1/auth/login/pin')
    .send({ refreshToken, pin });
}

function inTenant(tenantId: string, sql: string): Promise<pg.QueryResult> {
  return asTenant(pool, tenantId, (client) => client.query(sql));
}

beforeAll(async () => {
  pool = testPool();
  await prepareTestDatabase();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(GOOGLE_VERIFIER)
    .useValue(new FakeGoogleVerifier())
    .compile();
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

describe('reading which credentials exist', () => {
  it('reports neither for a Google account', async () => {
    const account = await googleAccount();

    const response = await readSettings(account.accessToken);

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ hasPassword: false, hasPin: false });
  });

  it('reports both for an account that signed up with an OTP', async () => {
    const account = await passwordAccount();

    const response = await readSettings(account.accessToken);

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ hasPassword: true, hasPin: true });
  });

  it('requires a bearer token', async () => {
    await googleAccount();

    const response = await request(app.getHttpServer()).get('/api/v1/settings/security');

    expect(response.status).toBe(401);
  });
});

describe('a Google account setting its first password', () => {
  it('accepts it without a current password, and the account can then log in', async () => {
    const account = await googleAccount();

    const response = await putPassword(account.accessToken, {
      refreshToken: account.refreshToken,
      newPassword: PASSWORD,
    });

    expect(response.status).toBe(204);
    expect((await readSettings(account.accessToken)).body.data).toEqual({
      hasPassword: true,
      hasPin: false,
    });

    // The point of the whole feature: this owner can now sign in without Google.
    const signedIn = await login(GOOGLE_EMAIL, PASSWORD);
    expect(signedIn.status).toBe(200);
  });

  it('stores it hashed, never in the clear', async () => {
    const account = await googleAccount();

    await putPassword(account.accessToken, {
      refreshToken: account.refreshToken,
      newPassword: PASSWORD,
    });

    const rows = await inTenant(account.tenantId, 'SELECT password_hash, pin_hash FROM users');
    expect(rows.rows[0].password_hash).not.toBe(PASSWORD);
    expect(rows.rows[0].password_hash).toMatch(/^scrypt\$/);
    // Independently managed: setting a password leaves the PIN alone.
    expect(rows.rows[0].pin_hash).toBeNull();
  });

  it('keeps this device signed in and does not revoke the Google session', async () => {
    const account = await googleAccount();

    await putPassword(account.accessToken, {
      refreshToken: account.refreshToken,
      newPassword: PASSWORD,
    });

    // Nothing was established with an *old* password, so there is nothing to
    // invalidate — the phone this owner is holding stays signed in.
    const refreshed = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: account.refreshToken });
    expect(refreshed.status).toBe(200);
  });

  it('records it as SET, not CHANGED', async () => {
    const account = await googleAccount();

    await putPassword(account.accessToken, {
      refreshToken: account.refreshToken,
      newPassword: PASSWORD,
    });

    const audit = await inTenant(
      account.tenantId,
      "SELECT action FROM audit_events WHERE entity_type = 'user'",
    );
    expect(audit.rows).toEqual([{ action: 'PASSWORD_SET' }]);
  });

  it('still enforces the password rules', async () => {
    const account = await googleAccount();

    const response = await putPassword(account.accessToken, {
      refreshToken: account.refreshToken,
      newPassword: 'short1',
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('requires the current password once one exists', async () => {
    const account = await googleAccount();
    await putPassword(account.accessToken, {
      refreshToken: account.refreshToken,
      newPassword: PASSWORD,
    });

    // The second attempt is a change, so omitting `currentPassword` is refused
    // — the branch is decided from what is stored, not from what was sent.
    const omitted = await putPassword(account.accessToken, {
      refreshToken: account.refreshToken,
      newPassword: NEW_PASSWORD,
    });
    expect(omitted.status).toBe(400);
    expect(omitted.body.error.code).toBe('VALIDATION_FAILED');

    const wrong = await putPassword(account.accessToken, {
      refreshToken: account.refreshToken,
      currentPassword: 'Wrongpass99',
      newPassword: NEW_PASSWORD,
    });
    expect(wrong.status).toBe(401);

    // The password is unchanged by either failed attempt.
    expect((await login(GOOGLE_EMAIL, PASSWORD)).status).toBe(200);
  });
});

describe('a Google account setting its first PIN', () => {
  it('accepts it without a current PIN, and the PIN then unlocks the device', async () => {
    const account = await googleAccount();

    const response = await putPin(account.accessToken, { newPin: PIN });

    expect(response.status).toBe(204);
    expect((await readSettings(account.accessToken)).body.data).toEqual({
      hasPassword: false,
      hasPin: true,
    });

    const unlocked = await loginWithPin(account.refreshToken, PIN);
    expect(unlocked.status).toBe(200);
  });

  it('stores it hashed and leaves the password untouched', async () => {
    const account = await googleAccount();

    await putPin(account.accessToken, { newPin: PIN });

    const rows = await inTenant(account.tenantId, 'SELECT password_hash, pin_hash FROM users');
    expect(rows.rows[0].pin_hash).not.toBe(PIN);
    expect(rows.rows[0].pin_hash).toMatch(/^scrypt\$/);
    expect(rows.rows[0].password_hash).toBeNull();
  });

  it('records it as SET, not CHANGED', async () => {
    const account = await googleAccount();

    await putPin(account.accessToken, { newPin: PIN });

    const audit = await inTenant(
      account.tenantId,
      "SELECT action FROM audit_events WHERE entity_type = 'user'",
    );
    expect(audit.rows).toEqual([{ action: 'PIN_SET' }]);
  });

  it('requires the current PIN once one exists', async () => {
    const account = await googleAccount();
    await putPin(account.accessToken, { newPin: PIN });

    const omitted = await putPin(account.accessToken, { newPin: NEW_PIN });
    expect(omitted.status).toBe(400);

    const wrong = await putPin(account.accessToken, { currentPin: '0000', newPin: NEW_PIN });
    expect(wrong.status).toBe(401);

    // Still the original PIN.
    expect((await loginWithPin(account.refreshToken, PIN)).status).toBe(200);
  });
});

describe('the two credentials are managed independently', () => {
  it('a Google account can set a PIN without ever setting a password', async () => {
    const account = await googleAccount();

    expect((await putPin(account.accessToken, { newPin: PIN })).status).toBe(204);

    expect((await readSettings(account.accessToken)).body.data).toEqual({
      hasPassword: false,
      hasPin: true,
    });
    // A PIN is not a password: signing in on a new device still needs one.
    expect((await login(GOOGLE_EMAIL, PASSWORD)).status).toBe(401);
  });

  it('setting a password does not disturb an existing PIN', async () => {
    const account = await googleAccount();
    await putPin(account.accessToken, { newPin: PIN });

    await putPassword(account.accessToken, {
      refreshToken: account.refreshToken,
      newPassword: PASSWORD,
    });

    expect((await readSettings(account.accessToken)).body.data).toEqual({
      hasPassword: true,
      hasPin: true,
    });
    expect((await loginWithPin(account.refreshToken, PIN)).status).toBe(200);
  });
});

describe('an OTP account behaves exactly as before', () => {
  it('cannot skip the current password by omitting it', async () => {
    const account = await passwordAccount();

    const response = await putPassword(account.accessToken, {
      refreshToken: account.refreshToken,
      newPassword: NEW_PASSWORD,
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
    // Unchanged.
    expect((await login(PHONE, PASSWORD)).status).toBe(200);
  });

  it('cannot skip the current PIN by omitting it', async () => {
    const account = await passwordAccount();

    const response = await putPin(account.accessToken, { newPin: NEW_PIN });

    expect(response.status).toBe(400);
    expect((await loginWithPin(account.refreshToken, PIN)).status).toBe(200);
  });

  it('still revokes other sessions when the password actually changes', async () => {
    const account = await passwordAccount();
    const elsewhere = await login(PHONE, PASSWORD);
    expect(elsewhere.status).toBe(200);

    const changed = await putPassword(account.accessToken, {
      refreshToken: account.refreshToken,
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expect(changed.status).toBe(204);

    // The other device is signed out; this one is not.
    const otherRefresh = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: elsewhere.body.data.refreshToken as string });
    expect(otherRefresh.status).toBe(401);

    const thisRefresh = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: account.refreshToken });
    expect(thisRefresh.status).toBe(200);

    const audit = await inTenant(
      account.tenantId,
      "SELECT action FROM audit_events WHERE entity_type = 'user'",
    );
    expect(audit.rows).toEqual([{ action: 'PASSWORD_CHANGED' }]);
  });
});
