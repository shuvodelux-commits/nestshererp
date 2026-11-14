import 'reflect-metadata';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { myAccessResponseSchema } from '@sher/core-contracts';
import { FixedClock, SystemClock, Ulid } from '@sher/shared-utils';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { signToken } from '../src/auth/jwt';
import { AppErrorFilter } from '../src/common/app-error.filter';
import { asTenant, prepareTestDatabase, resetDatabase, testPool } from './support/database';

let app: INestApplication;
let pool: pg.Pool;
const clock = new SystemClock();

interface Owner {
  readonly tenantId: string;
  readonly userId: string;
  readonly accessToken: string;
}

async function register(identifier: string, businessName: string): Promise<Owner> {
  const otp = await request(app.getHttpServer())
    .post('/api/v1/auth/registration/otp')
    .send({ identifier });
  expect(otp.status).toBe(200);
  const created = await request(app.getHttpServer())
    .post('/api/v1/auth/registration')
    .send({ identifier, otpCode: otp.body.data.devCode as string, businessName,
      username: 'owner', password: 'Passw0rd23', pin: '4821' });
  expect(created.status).toBe(201);
  return {
    tenantId: created.body.data.tenant.id as string,
    userId: created.body.data.user.id as string,
    accessToken: created.body.data.accessToken as string,
  };
}

function me(token: string, tenantHint?: string): request.Test {
  return request(app.getHttpServer())
    .get('/api/v1/me')
    .query(tenantHint === undefined ? {} : { tenantId: tenantHint })
    .set('Authorization', `Bearer ${token}`);
}

// Observe persisted state through the same tenant/RLS scope as the application.
async function persisted(owner: Owner): Promise<unknown[]> {
  return asTenant(pool, owner.tenantId, async (client) => {
    const rows: unknown[] = [];
    for (const table of ['tenants', 'users', 'roles', 'role_permissions', 'settings',
      'journal_entries', 'journal_lines', 'stock_movements', 'cash_movements',
      'audit_events', 'outbox']) {
      const result = await client.query(`SELECT * FROM ${table} ORDER BY id`);
      rows.push(result.rows);
    }
    return rows;
  });
}

beforeAll(async () => {
  await prepareTestDatabase();
  pool = testPool();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.useGlobalFilters(new AppErrorFilter());
  await app.init();
  // Pin a single ephemeral listener: concurrent Supertest requests must not race
  // to open/close the same unbound HTTP server (ECONNRESET between requests).
  await app.listen(0);
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

beforeEach(async () => { await resetDatabase(pool); });

describe('authoritative /me bootstrap (MOD-000-A / F0-01)', () => {
  it('returns the registered tenant IDs and each current profile, ignoring a foreign tenant hint', async () => {
    const a = await register('01712345678', 'Shop A');
    const b = await register('01912345678', 'Shop B');
    await asTenant(pool, b.tenantId, (client) => client.query(
      'UPDATE tenants SET timezone = $1 WHERE id = $2', ['Asia/Kolkata', b.tenantId],
    ));

    const asA = await me(a.accessToken, b.tenantId);
    const asB = await me(b.accessToken, a.tenantId);
    expect(asA.status).toBe(200);
    expect(asB.status).toBe(200);
    expect(a.tenantId).not.toBe(b.tenantId);
    expect(Ulid.isValid(a.tenantId)).toBe(true);
    expect(Ulid.isValid(b.tenantId)).toBe(true);
    expect(asA.body.data).toMatchObject({ tenantId: a.tenantId, timezone: 'Asia/Dhaka', businessName: 'Shop A' });
    expect(asB.body.data).toMatchObject({ tenantId: b.tenantId, timezone: 'Asia/Kolkata', businessName: 'Shop B' });
    expect(Object.keys(asA.body)).toEqual(['data']);
    expect(myAccessResponseSchema.safeParse(asA.body.data).success).toBe(true);
    expect(myAccessResponseSchema.safeParse(asB.body.data).success).toBe(true);
  });

  it('reads profile edits with the original token and preserves identity, permissions and effective features', async () => {
    const owner = await register('01712345678', 'Shop A');
    const initial = await me(owner.accessToken);
    expect(initial.status).toBe(200);
    expect(initial.body.data.user).toEqual({ id: owner.userId, username: 'owner', displayName: 'owner', roleName: 'Owner' });
    expect(initial.body.data.permissions).toContain('user.account.create');
    expect(initial.body.data.features).toContain('cash_session_enabled');
    expect(initial.body.data.features).not.toContain('vendor_consignment_enabled');
    await asTenant(pool, owner.tenantId, async (client) => {
      await client.query('UPDATE tenants SET name = $1, timezone = $2 WHERE id = $3',
        ['Renamed shop', 'Europe/London', owner.tenantId]);
      await client.query('DELETE FROM role_permissions WHERE permission_code = $1', ['user.account.create']);
    });
    const before = await persisted(owner);
    const current = await me(owner.accessToken);
    expect(await persisted(owner)).toEqual(before);
    expect(current.status).toBe(200);
    expect(current.body.data).toMatchObject({ tenantId: owner.tenantId, businessName: 'Renamed shop', timezone: 'Europe/London' });
    expect(current.body.data.user).toEqual(initial.body.data.user);
    expect([...current.body.data.permissions].sort()).toEqual(
      (initial.body.data.permissions as string[]).filter((code) => code !== 'user.account.create').sort(),
    );
    expect(current.body.data.features).toEqual(initial.body.data.features);
  });

  it('returns NOT_FOUND for a disabled user without writing business state', async () => {
    const owner = await register('01712345678', 'Shop A');
    await asTenant(pool, owner.tenantId, (client) => client.query(
      'UPDATE users SET deleted_at = $1 WHERE id = $2', [clock.now(), owner.userId],
    ));
    const before = await persisted(owner);
    const response = await me(owner.accessToken);
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(await persisted(owner)).toEqual(before);
  });

  it('returns NOT_FOUND for a missing or foreign-tenant user', async () => {
    const a = await register('01712345678', 'Shop A');
    const b = await register('01912345678', 'Shop B');
    for (const userId of [Ulid.generate(clock), b.userId]) {
      const token = signToken({ tenantId: a.tenantId, userId, timezone: 'Asia/Dhaka' },
        'test-secret-not-used-in-production', clock);
      const response = await me(token);
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    }
  });

  it('returns NOT_FOUND for an unavailable profile instead of another tenant profile', async () => {
    const a = await register('01712345678', 'Shop A');
    await register('01912345678', 'Shop B');
    await asTenant(pool, a.tenantId, (client) => client.query(
      'UPDATE tenants SET deleted_at = $1 WHERE id = $2', [clock.now(), a.tenantId],
    ));
    const before = await persisted(a);
    const response = await me(a.accessToken);
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(await persisted(a)).toEqual(before);
  });

  it('retains authentication refusal for absent and invalid credentials', async () => {
    for (const response of [await request(app.getHttpServer()).get('/api/v1/me'), await me('invalid')]) {
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('UNAUTHENTICATED');
    }
  });

  it('validates canonical tenant ULIDs and IANA profile timezones in the response contract', () => {
    const valid = { tenantId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', timezone: 'Asia/Dhaka',
      user: { id: '01ARZ3NDEKTSV4RRFFQ69G5FAW', username: 'owner', displayName: 'Owner', roleName: 'Owner' },
      businessName: 'Shop A', permissions: [], features: [] };
    expect(myAccessResponseSchema.safeParse(valid).success).toBe(true);
    for (const tenantId of ['t1', '81ARZ3NDEKTSV4RRFFQ69G5FAV', '01arz3ndektsv4rrffq69g5fav']) {
      expect(myAccessResponseSchema.safeParse({ ...valid, tenantId }).success).toBe(false);
    }
    for (const timezone of ['', 'not/a-zone', '+06:00']) {
      expect(myAccessResponseSchema.safeParse({ ...valid, timezone }).success).toBe(false);
    }
    expect(myAccessResponseSchema.safeParse({ ...valid, timezone: 'Europe/London' }).success).toBe(true);
  });
});


/**
 * MOD-000-A F0-01 readiness expansion (issue #150).
 * DB assertions run against the job's disposable PostgreSQL16.
 * Setup mutations are excluded from post-read immutable-state comparisons.
 */
describe('F0-01 readiness: adversarial tenant, feature and retry partitions', () => {
  it('F001-05/17: reflects changed feature flags, preserving other tenant and read-only state', async () => {
    const a = await register('01712345678', 'Shop A');
    const b = await register('01912345678', 'Shop B');
    const initialA = await me(a.accessToken);
    const initialB = await me(b.accessToken);
    expect(initialA.status).toBe(200);
    expect(initialB.status).toBe(200);
    expect(initialA.body.data.features).toContain('cash_session_enabled');
    expect(initialB.body.data.features).toContain('cash_session_enabled');
    expect(initialA.body.data.features).not.toContain('serial_tracking_enabled');

    for (const [key, value] of [
      ['cash_session_enabled', 'off'],
      ['serial_tracking_enabled', 'on'],
    ] as const) {
      const saved = await request(app.getHttpServer())
        .post('/api/v1/settings/value')
        .set('Authorization', 'Bearer ' + a.accessToken)
        .send({ key, value });
      expect(saved.status).toBe(201);
    }
    const beforeA = await persisted(a);
    const beforeB = await persisted(b);
    const currentA = await me(a.accessToken);
    const currentB = await me(b.accessToken);
    expect(currentA.status).toBe(200);
    expect(currentB.status).toBe(200);
    expect(currentA.body.data.features).not.toContain('cash_session_enabled');
    expect(currentA.body.data.features).toContain('serial_tracking_enabled');
    expect(currentB.body.data.features).toContain('cash_session_enabled');
    expect(currentB.body.data.features).not.toContain('serial_tracking_enabled');
    expect(currentA.body.data.tenantId).toBe(a.tenantId);
    expect(currentB.body.data.tenantId).toBe(b.tenantId);
    expect(await persisted(a)).toEqual(beforeA);
    expect(await persisted(b)).toEqual(beforeB);
  });

  it('F001-09: rejects missing, malformed and expired credentials with stable errors', async () => {
    const a = await register('01712345678', 'Shop A');
    const before = await persisted(a);
    const expired = signToken(
      { tenantId: a.tenantId, userId: a.userId, timezone: 'UTC' },
      'test-secret-not-used-in-production',
      new FixedClock('2000-01-01T00:00:00Z'),
    );
    const responses = [
      await request(app.getHttpServer()).get('/api/v1/me').set('Authorization', 'Basic abc'),
      await request(app.getHttpServer()).get('/api/v1/me').set('Authorization', 'bearer wrong-case'),
      await me('not-a-jwt'),
      await me(expired),
    ];
    for (const response of responses) {
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('UNAUTHENTICATED');
      expect(response.body.data).toBeUndefined();
    }
    expect(await persisted(a)).toEqual(before);
  });

  it('F001-10: foreign or invalid query and header tenant hints cannot select another profile', async () => {
    const a = await register('01712345678', 'Shop A');
    const b = await register('01912345678', 'Shop B');
    const beforeA = await persisted(a);
    for (const query of [b.tenantId, 'not-a-ulid', '', '../other-tenant']) {
      const result = await me(a.accessToken, query)
        .set('X-Tenant-Id', b.tenantId)
        .set('X-Business-Id', b.tenantId);
      expect(result.status).toBe(200);
      expect(result.body.data).toMatchObject({
        tenantId: a.tenantId,
        businessName: 'Shop A',
        timezone: 'Asia/Dhaka',
      });
      expect(result.body.data.user.id).toBe(a.userId);
      expect(result.body.data.tenantId).not.toBe(b.tenantId);
    }
    expect(await persisted(a)).toEqual(beforeA);
  });

  it('F001-12/14: concurrent and repeated cross-tenant GETs never mix identities or persist writes', async () => {
    const a = await register('01712345678', 'Shop A');
    const b = await register('01912345678', 'Shop B');
    await asTenant(pool, b.tenantId, (client) => client.query(
      'UPDATE tenants SET timezone = $1 WHERE id = $2', ['Europe/London', b.tenantId],
    ));
    const beforeA = await persisted(a);
    const beforeB = await persisted(b);
    // Drain every in-flight request even if one refuses/fails; otherwise the
    // next test's TRUNCATE can race a read transaction and deadlock PG16.
    const outcomes = await Promise.allSettled(Array.from({ length: 20 }, (_, index) => {
      const owner = index % 2 === 0 ? a : b;
      const other = index % 2 === 0 ? b : a;
      return me(owner.accessToken, other.tenantId);
    }));
    expect(outcomes.filter((result) => result.status === 'rejected')).toEqual([]);
    for (let index = 0; index < outcomes.length; index += 1) {
      const outcome = outcomes[index]!;
      if (outcome.status !== 'fulfilled') continue;
      const owner = index % 2 === 0 ? a : b;
      const timezone = index % 2 === 0 ? 'Asia/Dhaka' : 'Europe/London';
      const response = outcome.value;
      expect(response.status).toBe(200);
      expect(response.body.data.tenantId).toBe(owner.tenantId);
      expect(response.body.data.user.id).toBe(owner.userId);
      expect(response.body.data.timezone).toBe(timezone);
    }
    expect(await persisted(a)).toEqual(beforeA);
    expect(await persisted(b)).toEqual(beforeB);
  });

  it('F001-11: enforces strict response shape and IANA boundary values', async () => {
    const a = await register('01712345678', 'Shop A');
    const response = await me(a.accessToken);
    expect(response.status).toBe(200);
    const valid = response.body.data;
    for (const timezone of ['UTC', 'Etc/UTC', 'Asia/Dhaka', 'America/Argentina/Buenos_Aires']) {
      expect(myAccessResponseSchema.safeParse({ ...valid, timezone }).success).toBe(true);
    }
    for (const timezone of ['', 'Asia/Dhaka ', 'Asia/\nDhaka', 'Not/A_Real_Zone', 'x'.repeat(61), null]) {
      expect(myAccessResponseSchema.safeParse({ ...valid, timezone }).success).toBe(false);
    }
    for (const tenantId of ['01ARZ3NDEKTSV4RRFFQ69G5FAI', '01ARZ3NDEKTSV4RRFFQ69G5FA', null, 123]) {
      expect(myAccessResponseSchema.safeParse({ ...valid, tenantId }).success).toBe(false);
    }
    expect(myAccessResponseSchema.safeParse({ ...valid, unexpected: 'must fail' }).success).toBe(false);
  });

  it('F001-15: authenticated /me stays readable after permission revocation without leaking other tenants', async () => {
    const a = await register('01712345678', 'Shop A');
    const b = await register('01912345678', 'Shop B');
    const baselineB = await me(b.accessToken);
    await asTenant(pool, a.tenantId, (client) => client.query(
      'DELETE FROM role_permissions WHERE permission_code = $1', ['user.account.create'],
    ));
    const beforeA = await persisted(a);
    const currentA = await me(a.accessToken);
    const currentB = await me(b.accessToken);
    expect(currentA.status).toBe(200);
    expect(currentB.status).toBe(200);
    expect(currentA.body.data.permissions).not.toContain('user.account.create');
    expect(currentB.body.data.permissions).toContain('user.account.create');
    expect(currentB.body.data).toEqual(baselineB.body.data);
    expect(currentA.body.data.user.id).toBe(a.userId);
    expect(currentA.body.data.tenantId).toBe(a.tenantId);
    expect(await persisted(a)).toEqual(beforeA);
  });
});
