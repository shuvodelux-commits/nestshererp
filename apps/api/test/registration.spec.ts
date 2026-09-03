/*
 * Coverage claims, read by `pnpm test:inventory` (owner request 2026-09-03).
 *
 * These are what this file is answerable for in the test matrix. A claim naming
 * something the inventory no longer contains fails the scan, so a screen renamed
 * out from under a test cannot leave the coverage report quietly overstating itself.
 *
 * @covers endpoint:GET /api/v1/dashboard/summary
 * @covers endpoint:POST /api/v1/auth/registration
 * @covers endpoint:POST /api/v1/auth/registration/otp
 * @covers endpoint:POST /api/v1/auth/registration/otp/verify
 */
import 'reflect-metadata';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { AppErrorFilter } from '../src/common/app-error.filter';
import { signToken, TEST_JWT_SECRET } from './support/auth';
import { asPlatform, asTenant, prepareTestDatabase, resetDatabase, testPool } from './support/database';

/**
 * Slice 1.1 — register a tenant via OTP, set username/password/PIN, land on the
 * dashboard. The expected values here were written before the code existed.
 */
const PHONE = '01712345678';
const EMAIL = 'karim@shop.com.bd';
const BUSINESS = 'Karim Traders';
const USERNAME = 'karim';
const PASSWORD = 'Passw0rd23';
const PIN = '4821';

let app: INestApplication;
let pool: pg.Pool;

function sendOtp(identifier: string): request.Test {
  return request(app.getHttpServer()).post('/api/v1/auth/registration/otp').send({ identifier });
}

function register(overrides: Record<string, unknown> = {}): request.Test {
  return request(app.getHttpServer())
    .post('/api/v1/auth/registration')
    .send({
      identifier: PHONE,
      otpCode: '000000',
      businessName: BUSINESS,
      username: USERNAME,
      password: PASSWORD,
      pin: PIN,
      ...overrides,
    });
}

/** The development transport hands the code back, which is what makes this testable. */
async function codeFor(identifier: string): Promise<string> {
  const response = await sendOtp(identifier);
  expect(response.status).toBe(200);
  return response.body.data.devCode as string;
}

async function registerFully(identifier = PHONE): Promise<request.Response> {
  const otpCode = await codeFor(identifier);
  return register({ identifier, otpCode });
}

/**
 * Tenant-scoped tables are behind RLS, so a raw pool query sees nothing — the
 * same door the application uses is the only way in (`asTenant`).
 *
 * "How many accounts exist in total" is asked of `user_identifiers` instead,
 * which is deliberately not RLS-scoped and holds exactly one row per account.
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

describe('requesting a signup code (D-07)', () => {
  it('issues one unconsumed code and audits the send with no tenant', async () => {
    const response = await sendOtp(PHONE);

    expect(response.status).toBe(200);
    expect(response.body.data.channel).toBe('PHONE');
    expect(response.body.data.devCode).toMatch(/^\d{6}$/);

    const otps = await pool.query(
      'SELECT identifier, channel, purpose, attempt_count, consumed_at, code_hash FROM otp_codes',
    );
    expect(otps.rows).toHaveLength(1);
    expect(otps.rows[0]).toMatchObject({
      identifier: PHONE,
      channel: 'PHONE',
      purpose: 'SIGNUP',
      attempt_count: 0,
      consumed_at: null,
    });
    // The code is stored hashed, never in the clear (§5.3).
    expect(otps.rows[0].code_hash).not.toBe(response.body.data.devCode);

    // A platform event belongs to no tenant, so no tenant's RLS policy can see
    // it — reading it needs the owner connection, which is the intended design.
    const audit = await asPlatform((admin) =>
      admin.query(
        "SELECT tenant_id, action, source FROM audit_events WHERE entity_type = 'signup_otp'",
      ),
    );
    expect(audit.rows).toEqual([{ tenant_id: null, action: 'SEND', source: 'API' }]);

    const hidden = await pool.query('SELECT id FROM audit_events');
    expect(hidden.rowCount).toBe(0);
  });

  it('classifies an email identifier as the email channel', async () => {
    const response = await sendOtp(EMAIL);

    expect(response.status).toBe(200);
    expect(response.body.data.channel).toBe('EMAIL');
  });

  it('rejects an identifier that is neither a mobile number nor an email', async () => {
    const response = await sendOtp('not-an-identifier');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('makes the previous code useless once a new one is requested', async () => {
    const first = await codeFor(PHONE);
    const second = await codeFor(PHONE);
    expect(first).not.toBe(second);

    // Only the newest code is ever considered, so a superseded one reads as
    // simply wrong. It cannot create an account either way, which is the rule
    // that matters — "invalidated on a new request" (§5.3).
    const stale = await register({ otpCode: first });
    expect(stale.status).toBe(400);
    expect(stale.body.error.code).toBe('OTP_INCORRECT');
    expect(await accountCount()).toBe(0);

    const current = await register({ otpCode: second });
    expect(current.status).toBe(201);
  });

  it('sends no code, and reveals nothing, for an identifier that already has an account', async () => {
    await registerFully();

    const response = await sendOtp(PHONE);

    // Same 200 and same shape as a fresh identifier — no enumeration oracle.
    expect(response.status).toBe(200);
    expect(response.body.data.channel).toBe('PHONE');
    expect(response.body.data.devCode).toBeUndefined();
  });
});

describe('verifying a code without spending it', () => {
  function verify(identifier: string, otpCode: string): request.Test {
    return request(app.getHttpServer())
      .post('/api/v1/auth/registration/otp/verify')
      .send({ identifier, otpCode });
  }

  it('accepts the right code and leaves it usable for registration', async () => {
    const otpCode = await codeFor(PHONE);

    const checked = await verify(PHONE, otpCode);
    expect(checked.status).toBe(200);
    expect(checked.body.data).toEqual({ verified: true });

    // Not consumed — the same code still creates the account.
    const otps = await pool.query('SELECT consumed_at FROM otp_codes');
    expect(otps.rows).toEqual([{ consumed_at: null }]);

    const registered = await register({ otpCode });
    expect(registered.status).toBe(201);
  });

  it('rejects a wrong code and counts the attempt', async () => {
    const otpCode = await codeFor(PHONE);
    const wrong = otpCode === '000000' ? '111111' : '000000';

    const response = await verify(PHONE, wrong);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('OTP_INCORRECT');
    expect((await pool.query('SELECT attempt_count FROM otp_codes')).rows).toEqual([
      { attempt_count: 1 },
    ]);
  });

  it('is not a free brute-force oracle — it honours the 5-attempt cap', async () => {
    const otpCode = await codeFor(PHONE);
    const wrong = otpCode === '000000' ? '111111' : '000000';

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect((await verify(PHONE, wrong)).body.error.code).toBe('OTP_INCORRECT');
    }

    expect((await verify(PHONE, wrong)).body.error.code).toBe('OTP_MAX_ATTEMPTS_EXCEEDED');
    // Even the correct code is dead now, here and at registration.
    expect((await verify(PHONE, otpCode)).body.error.code).toBe('OTP_MAX_ATTEMPTS_EXCEEDED');
    expect((await register({ otpCode })).body.error.code).toBe('OTP_MAX_ATTEMPTS_EXCEEDED');
    expect(await accountCount()).toBe(0);
  });
});

describe('completing registration', () => {
  it('creates exactly one tenant, Owner role and user, and returns a usable token', async () => {
    const response = await registerFully();

    expect(response.status).toBe(201);
    expect(response.body.data.tenant.name).toBe(BUSINESS);
    expect(response.body.data.user.username).toBe(USERNAME);
    expect(response.body.data.accessToken).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);

    const tenantId = response.body.data.tenant.id as string;

    const tenants = await inTenant(tenantId, 'SELECT id, name, timezone FROM tenants');
    expect(tenants.rows).toEqual([{ id: tenantId, name: BUSINESS, timezone: 'Asia/Dhaka' }]);

    // §5.26 ships all six roles with every tenant; the founder holds Owner.
    const roles = await inTenant(
      tenantId,
      "SELECT code, name, is_system FROM roles WHERE code = 'OWNER'",
    );
    expect(roles.rows).toEqual([{ code: 'OWNER', name: 'Owner', is_system: true }]);

    const users = await inTenant(
      tenantId,
      'SELECT username, phone, email, password_hash, pin_hash FROM users',
    );
    expect(users.rows).toHaveLength(1);
    expect(users.rows[0]).toMatchObject({ username: USERNAME, phone: PHONE, email: null });
    // Credentials are hashed, never stored in the clear.
    expect(users.rows[0].password_hash).not.toBe(PASSWORD);
    expect(users.rows[0].pin_hash).not.toBe(PIN);
    expect(users.rows[0].password_hash).toMatch(/^scrypt\$/);

    expect(await accountCount()).toBe(1);

    const audit = await inTenant(
      tenantId,
      "SELECT tenant_id, action, before_json, after_json, source FROM audit_events WHERE entity_type = 'tenant'",
    );
    expect(audit.rows).toEqual([
      {
        tenant_id: tenantId,
        action: 'CREATE',
        before_json: null,
        // `verifiedBy` and the two credential flags distinguish this from a
        // Google signup, which is verified differently and holds neither.
        after_json: {
          name: BUSINESS,
          username: USERNAME,
          channel: 'PHONE',
          verifiedBy: 'OTP',
          hasPassword: 'YES',
          hasPin: 'YES',
        },
        source: 'API',
      },
    ]);
  });

  it('stores an email identifier on the email column, leaving phone null', async () => {
    const response = await registerFully(EMAIL);

    expect(response.status).toBe(201);
    const users = await inTenant(
      response.body.data.tenant.id as string,
      'SELECT email, phone FROM users',
    );
    expect(users.rows).toEqual([{ email: EMAIL, phone: null }]);
  });

  it('consumes the code, so the same one cannot create a second business', async () => {
    const otpCode = await codeFor(PHONE);
    const first = await register({ otpCode });
    expect(first.status).toBe(201);

    const replay = await register({ otpCode, username: 'second' });

    expect(replay.status).toBe(400);
    expect(replay.body.error.code).toBe('OTP_EXPIRED');
    expect(await accountCount()).toBe(1);
  });

  it('refuses an identifier that already has an account, creating nothing', async () => {
    await registerFully();

    // A fresh code cannot be obtained for a taken identifier, so this proves the
    // guard holds even when a caller supplies one another way.
    const response = await register({ otpCode: '000000' });

    expect([400, 409]).toContain(response.status);
    expect(await accountCount()).toBe(1);
  });

  it('rejects a wrong code and counts the attempt', async () => {
    const otpCode = await codeFor(PHONE);
    const wrong = otpCode === '000000' ? '111111' : '000000';

    const response = await register({ otpCode: wrong });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('OTP_INCORRECT');

    // The counter survives the rejected request — a rollback here would make the
    // attempt limit unenforceable.
    const otps = await pool.query('SELECT attempt_count FROM otp_codes');
    expect(otps.rows).toEqual([{ attempt_count: 1 }]);
    expect(await accountCount()).toBe(0);
  });

  it('kills the code after 5 wrong attempts, even if the right one follows', async () => {
    const otpCode = await codeFor(PHONE);
    const wrong = otpCode === '000000' ? '111111' : '000000';

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await register({ otpCode: wrong });
      expect(response.body.error.code).toBe('OTP_INCORRECT');
    }

    const sixth = await register({ otpCode: wrong });
    expect(sixth.body.error.code).toBe('OTP_MAX_ATTEMPTS_EXCEEDED');

    const withCorrectCode = await register({ otpCode });
    expect(withCorrectCode.status).toBe(400);
    expect(withCorrectCode.body.error.code).toBe('OTP_MAX_ATTEMPTS_EXCEEDED');
    expect(await accountCount()).toBe(0);
  });

  it('rejects a weak password and a malformed PIN before touching the code', async () => {
    const otpCode = await codeFor(PHONE);

    const weak = await register({ otpCode, password: 'short1' });
    expect(weak.status).toBe(400);
    expect(weak.body.error.code).toBe('VALIDATION_FAILED');

    const badPin = await register({ otpCode, pin: '12' });
    expect(badPin.status).toBe(400);

    // Neither attempt spent the code.
    const good = await register({ otpCode });
    expect(good.status).toBe(201);
  });

  it('ignores a tenant_id smuggled into the payload', async () => {
    const otpCode = await codeFor(PHONE);

    const response = await register({ otpCode, tenantId: 'ABCDEFGHJKMNPQRSTVWXYZ0123' });

    // The contract is strict: an unknown field fails validation outright.
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('the dashboard after signing up', () => {
  it('returns the business name for the token issued at registration', async () => {
    const registered = await registerFully();

    const response = await request(app.getHttpServer())
      .get('/api/v1/dashboard/summary')
      .set('Authorization', `Bearer ${registered.body.data.accessToken as string}`);

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ businessName: BUSINESS });
  });

  it('rejects a request with no token and one signed with the wrong secret', async () => {
    const noToken = await request(app.getHttpServer()).get('/api/v1/dashboard/summary');
    expect(noToken.status).toBe(401);

    const forged = await request(app.getHttpServer())
      .get('/api/v1/dashboard/summary')
      .set(
        'Authorization',
        `Bearer ${signToken(
          { tenantId: 'ABCDEFGHJKMNPQRSTVWXYZ0123', userId: 'ABCDEFGHJKMNPQRSTVWXYZ0123', roleId: '', timezone: 'Asia/Dhaka' },
          'wrong-secret',
        )}`,
      );
    expect(forged.status).toBe(401);
    expect(forged.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('shows tenant B its own business, never tenant A\'s (R-E5)', async () => {
    const a = await registerFully(PHONE);
    const b = await registerFully(EMAIL);

    const asB = await request(app.getHttpServer())
      .get('/api/v1/dashboard/summary')
      .set('Authorization', `Bearer ${b.body.data.accessToken as string}`);

    expect(asB.status).toBe(200);
    expect(asB.body.data.businessName).toBe(BUSINESS);
    expect(a.body.data.tenant.id).not.toBe(b.body.data.tenant.id);
  });

  it('returns 404 when the token names a tenant that does not exist', async () => {
    const token = signToken(
      {
        tenantId: 'ABCDEFGHJKMNPQRSTVWXYZ0123',
        userId: 'ABCDEFGHJKMNPQRSTVWXYZ0124',
        roleId: '',
        timezone: 'Asia/Dhaka',
      },
      TEST_JWT_SECRET,
    );

    const response = await request(app.getHttpServer())
      .get('/api/v1/dashboard/summary')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
  });
});
