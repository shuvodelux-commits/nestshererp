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
 * @covers endpoint:POST /api/v1/auth/password/otp
 * @covers endpoint:POST /api/v1/auth/password/reset
 * @covers endpoint:POST /api/v1/auth/registration
 * @covers endpoint:POST /api/v1/auth/registration/google
 * @covers endpoint:POST /api/v1/auth/registration/otp
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
import {
  asPlatform,
  asTenant,
  prepareTestDatabase,
  resetDatabase,
  testPool,
} from './support/database';

/**
 * Slice 1.2c — Google sign-in completes signup (§5.3, D-07 revised 2026-08-17).
 * Expected values written before the code.
 *
 * The real `GoogleIdTokenVerifier` needs Google's live key set and a configured
 * client id, so the **port** is replaced here with one that trusts a token of
 * the form `valid:<email>`. That is the whole point of the port: everything
 * downstream of "Google says this address is verified" is exercised for real,
 * and signature checking is Google's own concern, not this slice's.
 */
const GOOGLE_EMAIL = 'shopkeeper@gmail.com';
const OTHER_EMAIL = 'someone.else@gmail.com';
const PHONE = '01712345678';
const PASSWORD = 'Passw0rd23';
const PIN = '4821';

/** Trusts `valid:<email>`, rejects everything else — like the real one would. */
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

function googleLogin(idToken: string): request.Test {
  return request(app.getHttpServer()).post('/api/v1/auth/login/google').send({ idToken });
}

function googleRegister(body: Record<string, unknown>): request.Test {
  return request(app.getHttpServer()).post('/api/v1/auth/registration/google').send(body);
}

function dashboard(token: string): request.Test {
  return request(app.getHttpServer())
    .get('/api/v1/dashboard/summary')
    .set('Authorization', `Bearer ${token}`);
}

/**
 * Tenant-scoped tables are behind RLS, so a raw pool query sees nothing — the
 * same door the application uses is the only way in (`asTenant`).
 *
 * "How many businesses exist in total" is therefore asked of
 * `user_identifiers`, which is deliberately not RLS-scoped and holds exactly
 * one row per account.
 */
function inTenant(tenantId: string, sql: string): Promise<pg.QueryResult> {
  return asTenant(pool, tenantId, (client) => client.query(sql));
}

async function accountCount(): Promise<number> {
  return (await pool.query('SELECT id FROM user_identifiers')).rowCount ?? 0;
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

describe('signing in with a Google account that has no business', () => {
  it('says so distinctly, and creates nothing', async () => {
    const response = await googleLogin(`valid:${GOOGLE_EMAIL}`);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('GOOGLE_ACCOUNT_UNKNOWN');

    expect(await accountCount()).toBe(0);
  });

  it('still refuses a token Google did not sign', async () => {
    const response = await googleLogin('forged.token.here');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });
});

describe('creating the business from a Google account', () => {
  it('creates the tenant, Owner role and user, and signs them in', async () => {
    const response = await googleRegister({
      idToken: `valid:${GOOGLE_EMAIL}`,
      businessName: 'Karim Traders',
    });

    expect(response.status).toBe(201);
    expect(response.body.data.tenant.name).toBe('Karim Traders');
    // Username derived from the email local-part (§5.3).
    expect(response.body.data.user.username).toBe('shopkeeper');

    expect((await dashboard(response.body.data.accessToken as string)).status).toBe(200);

    const tenantId = response.body.data.tenant.id as string;
    const tenants = await inTenant(tenantId, 'SELECT name, timezone FROM tenants');
    expect(tenants.rows).toEqual([{ name: 'Karim Traders', timezone: 'Asia/Dhaka' }]);
    // §5.26 ships all six roles with every tenant; the founder holds Owner.
    const roles = await inTenant(
      tenantId,
      "SELECT code, is_system FROM roles WHERE code = 'OWNER'",
    );
    expect(roles.rows).toEqual([{ code: 'OWNER', is_system: true }]);
  });

  it('leaves password and PIN NULL — Google is the only way in', async () => {
    const created = await googleRegister({
      idToken: `valid:${GOOGLE_EMAIL}`,
      businessName: 'Karim Traders',
    });

    const users = await inTenant(
      created.body.data.tenant.id as string,
      'SELECT email, phone, password_hash, pin_hash FROM users',
    );
    expect(users.rows).toEqual([
      { email: GOOGLE_EMAIL, phone: null, password_hash: null, pin_hash: null },
    ]);
  });

  it('cannot be signed into with a password or a PIN', async () => {
    const created = await googleRegister({
      idToken: `valid:${GOOGLE_EMAIL}`,
      businessName: 'Karim Traders',
    });

    const byPassword = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ identifier: GOOGLE_EMAIL, password: PASSWORD });
    expect(byPassword.status).toBe(401);

    // A null PIN is simply "no", not a crash.
    const byPin = await request(app.getHttpServer())
      .post('/api/v1/auth/login/pin')
      .send({ refreshToken: created.body.data.refreshToken as string, pin: PIN });
    expect(byPin.status).toBe(401);
  });

  it('signs in on the second visit instead of creating a second business', async () => {
    await googleRegister({ idToken: `valid:${GOOGLE_EMAIL}`, businessName: 'Karim Traders' });

    const again = await googleLogin(`valid:${GOOGLE_EMAIL}`);

    expect(again.status).toBe(200);
    expect(again.body.data.user.username).toBe('shopkeeper');
    expect(await accountCount()).toBe(1);
  });

  it('refuses to create a second business for the same Google account', async () => {
    await googleRegister({ idToken: `valid:${GOOGLE_EMAIL}`, businessName: 'Karim Traders' });

    const twice = await googleRegister({
      idToken: `valid:${GOOGLE_EMAIL}`,
      businessName: 'Another Shop',
    });

    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('IDENTIFIER_ALREADY_REGISTERED');
    expect(await accountCount()).toBe(1);
  });

  it('verifies the token again — the business-name step is not a free tenant factory', async () => {
    const response = await googleRegister({
      idToken: 'forged.token.here',
      businessName: 'Fraud Traders',
    });

    expect(response.status).toBe(401);
    expect(await accountCount()).toBe(0);
  });

  it('requires a business name, and stores nothing without one', async () => {
    const blank = await googleRegister({ idToken: `valid:${GOOGLE_EMAIL}`, businessName: '   ' });

    expect(blank.status).toBe(400);
    expect(blank.body.error.code).toBe('VALIDATION_FAILED');
    expect(await accountCount()).toBe(0);
  });

  it('links to an account that already exists rather than creating a rival one', async () => {
    // Registered the ordinary way, by OTP, on the same email.
    const otp = await request(app.getHttpServer())
      .post('/api/v1/auth/registration/otp')
      .send({ identifier: GOOGLE_EMAIL });
    await request(app.getHttpServer())
      .post('/api/v1/auth/registration')
      .send({
        identifier: GOOGLE_EMAIL,
        otpCode: otp.body.data.devCode as string,
        businessName: 'Karim Traders',
        username: 'karim',
        password: PASSWORD,
        pin: PIN,
      });

    const viaGoogle = await googleLogin(`valid:${GOOGLE_EMAIL}`);

    expect(viaGoogle.status).toBe(200);
    // The OTP-chosen username, not one derived from the address.
    expect(viaGoogle.body.data.user.username).toBe('karim');
    expect(await accountCount()).toBe(1);
  });

  it('audits the creation, recording that it had no password or PIN', async () => {
    const created = await googleRegister({
      idToken: `valid:${GOOGLE_EMAIL}`,
      businessName: 'Karim Traders',
    });

    const audit = await asPlatform((admin) =>
      admin.query(
        `SELECT entity_id, action, after_json FROM audit_events
         WHERE entity_type = 'tenant' AND action = 'CREATE'`,
      ),
    );
    expect(audit.rows).toEqual([
      {
        entity_id: created.body.data.tenant.id,
        action: 'CREATE',
        after_json: {
          name: 'Karim Traders',
          username: 'shopkeeper',
          channel: 'EMAIL',
          verifiedBy: 'GOOGLE',
          hasPassword: 'NO',
          hasPin: 'NO',
        },
      },
    ]);
  });
});

describe('recovery on a Google-created account (§5.3)', () => {
  it('forgot-password gives it a password, which then works', async () => {
    await googleRegister({ idToken: `valid:${GOOGLE_EMAIL}`, businessName: 'Karim Traders' });

    // The Google address is a verified email, so it can receive a reset code.
    const sent = await request(app.getHttpServer())
      .post('/api/v1/auth/password/otp')
      .send({ identifier: GOOGLE_EMAIL });
    expect(sent.status).toBe(200);

    const reset = await request(app.getHttpServer())
      .post('/api/v1/auth/password/reset')
      .send({
        identifier: GOOGLE_EMAIL,
        otpCode: sent.body.data.devCode as string,
        password: PASSWORD,
      });
    expect(reset.status).toBe(204);

    const byPassword = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ identifier: GOOGLE_EMAIL, password: PASSWORD });
    expect(byPassword.status).toBe(200);
  });
});

describe('tenant isolation (R-E5)', () => {
  it('two Google accounts get two separate businesses', async () => {
    const a = await googleRegister({
      idToken: `valid:${GOOGLE_EMAIL}`,
      businessName: 'Karim Traders',
    });
    const b = await googleRegister({
      idToken: `valid:${OTHER_EMAIL}`,
      businessName: 'Rahim Stores',
    });

    expect(a.body.data.tenant.id).not.toBe(b.body.data.tenant.id);
    expect((await dashboard(a.body.data.accessToken as string)).body.data.businessName).toBe(
      'Karim Traders',
    );
    expect((await dashboard(b.body.data.accessToken as string)).body.data.businessName).toBe(
      'Rahim Stores',
    );
  });

  it('does not collide when two addresses derive the same username', async () => {
    // Usernames are unique per tenant, and each of these is the only user in a
    // brand-new tenant — so identical derived usernames are not a conflict.
    const a = await googleRegister({
      idToken: 'valid:karim@gmail.com',
      businessName: 'Karim Traders',
    });
    const b = await googleRegister({
      idToken: 'valid:karim@yahoo.com',
      businessName: 'Karim Stores',
    });

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.data.user.username).toBe('karim');
    expect(b.body.data.user.username).toBe('karim');
  });
});

describe('signup by OTP still behaves exactly as before', () => {
  it('creates a tenant with a password and a PIN, audited as OTP-verified', async () => {
    const otp = await request(app.getHttpServer())
      .post('/api/v1/auth/registration/otp')
      .send({ identifier: PHONE });
    const created = await request(app.getHttpServer())
      .post('/api/v1/auth/registration')
      .send({
        identifier: PHONE,
        otpCode: otp.body.data.devCode as string,
        businessName: 'Karim Traders',
        username: 'karim',
        password: PASSWORD,
        pin: PIN,
      });

    expect(created.status).toBe(201);

    const users = await inTenant(
      created.body.data.tenant.id as string,
      'SELECT phone, password_hash, pin_hash FROM users',
    );
    expect(users.rows[0].phone).toBe(PHONE);
    expect(users.rows[0].password_hash).not.toBeNull();
    expect(users.rows[0].pin_hash).not.toBeNull();

    const audit = await asPlatform((admin) =>
      admin.query(
        `SELECT after_json FROM audit_events WHERE entity_type = 'tenant' AND action = 'CREATE'`,
      ),
    );
    expect(audit.rows[0].after_json).toEqual({
      name: 'Karim Traders',
      username: 'karim',
      channel: 'PHONE',
      verifiedBy: 'OTP',
      hasPassword: 'YES',
      hasPin: 'YES',
    });
  });
});
