/*
 * Coverage claims, read by `pnpm test:inventory` (owner request 2026-09-03).
 *
 * These are what this file is answerable for in the test matrix. A claim naming
 * something the inventory no longer contains fails the scan, so a screen renamed
 * out from under a test cannot leave the coverage report quietly overstating itself.
 *
 * @covers endpoint:GET /api/v1/audit-events
 * @covers endpoint:GET /api/v1/roles
 * @covers endpoint:GET /api/v1/settings
 * @covers endpoint:PATCH /api/v1/settings/business
 * @covers endpoint:POST /api/v1/auth/login
 * @covers endpoint:POST /api/v1/auth/password/otp
 * @covers endpoint:POST /api/v1/auth/password/reset
 * @covers endpoint:POST /api/v1/auth/registration
 * @covers endpoint:POST /api/v1/auth/registration/otp
 * @covers endpoint:POST /api/v1/settings/value
 * @covers endpoint:POST /api/v1/users
 */
import 'reflect-metadata';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type pg from 'pg';
import { parseInstant } from '@sher/shared-utils';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { AppErrorFilter } from '../src/common/app-error.filter';
import { prepareTestDatabase, resetDatabase, testPool } from './support/database';

/**
 * Slice 1.6 — the audit trail (§5.22). Expected values written before the code.
 *
 * Two things are worth proving here, and both are about evidence surviving:
 *
 *   Every accepted mutation from slices 1.3–1.5 already appears, with its
 *   before and after values. The trail is not a new feature bolted on; it is a
 *   read over what those slices have been writing all along.
 *
 *   A **refused** mutation is recorded too (§5.22). That row is written after
 *   the refused operation's transaction has rolled back — if it were written
 *   inside it, it would roll back with it and the attempt would leave no trace.
 */
const OWNER_PHONE = '01712345678';
const OWNER_PASSWORD = 'Passw0rd23';
const STAFF_PHONE = '01812345679';
const STAFF_PASSWORD = 'Manager2026';

let app: INestApplication;
let pool: pg.Pool;

interface Owner {
  readonly accessToken: string;
  readonly tenantId: string;
  readonly userId: string;
}

async function registerOwner(identifier = OWNER_PHONE): Promise<Owner> {
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
      password: OWNER_PASSWORD,
      pin: '4821',
    });

  expect(created.status).toBe(201);
  return {
    accessToken: created.body.data.accessToken as string,
    tenantId: created.body.data.tenant.id as string,
    userId: created.body.data.user.id as string,
  };
}

/** Adds a Manager and signs in as them — a role with no settings permission. */
async function signInAsManager(owner: Owner): Promise<string> {
  const roles = await request(app.getHttpServer())
    .get('/api/v1/roles')
    .set('Authorization', `Bearer ${owner.accessToken}`);
  const manager = roles.body.data.roles.find((role: { code: string }) => role.code === 'MANAGER');

  const created = await request(app.getHttpServer())
    .post('/api/v1/users')
    .set('Authorization', `Bearer ${owner.accessToken}`)
    .send({
      displayName: 'Rina Akter',
      username: 'rina',
      identifier: STAFF_PHONE,
      roleId: manager.id as string,
      confirmPassword: OWNER_PASSWORD,
    });
  expect(created.status).toBe(201);

  const sent = await request(app.getHttpServer())
    .post('/api/v1/auth/password/otp')
    .send({ identifier: STAFF_PHONE });
  await request(app.getHttpServer())
    .post('/api/v1/auth/password/reset')
    .send({
      identifier: STAFF_PHONE,
      otpCode: sent.body.data.devCode as string,
      password: STAFF_PASSWORD,
    });

  const signedIn = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ identifier: STAFF_PHONE, password: STAFF_PASSWORD });
  expect(signedIn.status).toBe(200);
  return signedIn.body.data.accessToken as string;
}

function listAudit(token: string, query: Record<string, string> = {}): request.Test {
  return request(app.getHttpServer())
    .get('/api/v1/audit-events')
    .query(query)
    .set('Authorization', `Bearer ${token}`);
}

interface AuditRow {
  id: string;
  occurredAt: string;
  actorName: string;
  actorId: string;
  entityType: string;
  entityId: string;
  action: string;
  before: Record<string, string> | null;
  after: Record<string, string> | null;
  reason: string | null;
  source: string;
}

beforeAll(async () => {
  await prepareTestDatabase();
  pool = testPool();

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

describe('audit trail', () => {
  it('shows a setting change with its before and after values (§5.22)', async () => {
    const owner = await registerOwner();
    await request(app.getHttpServer())
      .post('/api/v1/settings/value')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ key: 'serial_tracking_enabled', value: 'on' });

    const trail = await listAudit(owner.accessToken, { entityType: 'setting' });

    expect(trail.status).toBe(200);
    expect(trail.body.data.events).toHaveLength(1);
    const event = trail.body.data.events[0] as AuditRow;
    expect(event.action).toBe('UPDATE');
    expect(event.entityId).toBe('serial_tracking_enabled');
    expect(event.before).toEqual({ value: 'off' });
    expect(event.after).toEqual({ value: 'on' });
    expect(event.source).toBe('API');
    // A name the owner recognises, not a ULID.
    expect(event.actorName).toBe('karim');
    expect(event.actorId).toBe(owner.userId);
  });

  it('shows the newest event first', async () => {
    const owner = await registerOwner();
    await request(app.getHttpServer())
      .post('/api/v1/settings/value')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ key: 'serial_tracking_enabled', value: 'on' });
    await request(app.getHttpServer())
      .patch('/api/v1/settings/business')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ businessName: 'Karim Electronics', timezone: 'Asia/Dhaka' });

    const trail = await listAudit(owner.accessToken);
    const events = trail.body.data.events as AuditRow[];
    const newest = events[0];

    expect(newest?.entityType).toBe('tenant');
    expect(newest?.after).toEqual({
      businessName: 'Karim Electronics',
      timezone: 'Asia/Dhaka',
    });
  });

  it('filters by entity type, action and the record itself', async () => {
    const owner = await registerOwner();
    await request(app.getHttpServer())
      .post('/api/v1/settings/value')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ key: 'serial_tracking_enabled', value: 'on' });
    await request(app.getHttpServer())
      .post('/api/v1/settings/value')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ key: 'cash_session_enabled', value: 'off' });

    const one = await listAudit(owner.accessToken, { entityId: 'cash_session_enabled' });
    expect(one.body.data.events).toHaveLength(1);
    expect((one.body.data.events[0] as AuditRow).after).toEqual({ value: 'off' });

    const byAction = await listAudit(owner.accessToken, { action: 'CREATE' });
    expect(
      (byAction.body.data.events as AuditRow[]).every((event) => event.action === 'CREATE'),
    ).toBe(true);
  });

  it('offers the filter choices this tenant actually has', async () => {
    const owner = await registerOwner();
    await request(app.getHttpServer())
      .post('/api/v1/settings/value')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ key: 'serial_tracking_enabled', value: 'on' });

    const trail = await listAudit(owner.accessToken);

    expect(trail.body.data.entityTypes).toContain('setting');
    expect(trail.body.data.actions).toContain('UPDATE');
    expect(trail.body.data.actors).toContainEqual({ id: owner.userId, name: 'karim' });
  });

  it('pages by keyset, never repeating or skipping a row (§3.9)', async () => {
    const owner = await registerOwner();
    for (const key of ['serial_tracking_enabled', 'cash_session_enabled', 'expiry_tracking_enabled']) {
      await request(app.getHttpServer())
        .post('/api/v1/settings/value')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ key, value: key === 'cash_session_enabled' ? 'off' : 'on' });
    }

    const first = await listAudit(owner.accessToken, { entityType: 'setting', limit: '2' });
    expect(first.body.data.events).toHaveLength(2);
    expect(first.body.data.page.hasMore).toBe(true);

    const second = await listAudit(owner.accessToken, {
      entityType: 'setting',
      limit: '2',
      cursor: first.body.data.page.nextCursor as string,
    });
    expect(second.body.data.events).toHaveLength(1);
    expect(second.body.data.page.hasMore).toBe(false);

    const seen = [...first.body.data.events, ...second.body.data.events] as AuditRow[];
    expect(new Set(seen.map((event) => event.id)).size).toBe(3);
  });

  describe('date filters use the tenant timezone (§3.5)', () => {
    it('includes both ends of the range', async () => {
      const owner = await registerOwner();
      await request(app.getHttpServer())
        .post('/api/v1/settings/value')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ key: 'serial_tracking_enabled', value: 'on' });

      // Today in Dhaka, taken from the event the server just wrote — asserting
      // against a date this test computed itself would only prove the test can
      // do the same arithmetic as the code.
      const all = await listAudit(owner.accessToken, { entityType: 'setting' });
      const occurredAt = (all.body.data.events[0] as AuditRow).occurredAt;
      const occurred = parseInstant(occurredAt);
      expect(occurred).not.toBeNull();
      const dhakaDay = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Dhaka',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(occurred as Date);

      const inRange = await listAudit(owner.accessToken, {
        entityType: 'setting',
        from: dhakaDay,
        to: dhakaDay,
      });
      expect(inRange.body.data.events).toHaveLength(1);
    });

    it('excludes a day the event does not fall on', async () => {
      const owner = await registerOwner();
      await request(app.getHttpServer())
        .post('/api/v1/settings/value')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ key: 'serial_tracking_enabled', value: 'on' });

      const empty = await listAudit(owner.accessToken, {
        entityType: 'setting',
        from: '2020-01-01',
        to: '2020-01-02',
      });
      expect(empty.body.data.events).toHaveLength(0);
    });
  });

  describe('refused mutations (§5.22)', () => {
    it('records a denied write with the code, the record and a trace id', async () => {
      const owner = await registerOwner();
      const managerToken = await signInAsManager(owner);

      const refused = await request(app.getHttpServer())
        .post('/api/v1/settings/value')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ key: 'serial_tracking_enabled', value: 'on' });
      expect(refused.status).toBe(403);

      const trail = await listAudit(owner.accessToken, { entityType: 'permission_denial' });
      expect(trail.body.data.events).toHaveLength(1);

      const event = trail.body.data.events[0] as AuditRow;
      expect(event.action).toBe('DENIED');
      expect(event.entityId).toBe('settings.module.toggle');
      expect(event.actorName).toBe('Rina Akter');
      expect(event.after?.['resource']).toBe('POST /api/v1/settings/value');
      // The id the caller saw in the error envelope, so the two can be joined.
      expect(event.after?.['traceId']).toBe(refused.body.error.traceId);
      expect(event.after?.['traceId']).not.toBe('');
    });

    it('does not record a denied read — §5.22 wants those in aggregate only', async () => {
      const owner = await registerOwner();
      const managerToken = await signInAsManager(owner);

      const refused = await request(app.getHttpServer())
        .get('/api/v1/settings')
        .set('Authorization', `Bearer ${managerToken}`);
      expect(refused.status).toBe(403);

      const trail = await listAudit(owner.accessToken, { entityType: 'permission_denial' });
      expect(trail.body.data.events).toHaveLength(0);
    });
  });

  describe('access', () => {
    it('refuses a caller without the audit permission', async () => {
      const owner = await registerOwner();
      const managerToken = await signInAsManager(owner);

      expect((await listAudit(managerToken)).status).toBe(403);
    });

    it('never shows one tenant another tenant’s history', async () => {
      const first = await registerOwner('01712345678');
      await request(app.getHttpServer())
        .post('/api/v1/settings/value')
        .set('Authorization', `Bearer ${first.accessToken}`)
        .send({ key: 'serial_tracking_enabled', value: 'on' });

      const second = await registerOwner('01912345678');
      const theirs = await listAudit(second.accessToken, { entityType: 'setting' });

      expect(theirs.status).toBe(200);
      expect(theirs.body.data.events).toHaveLength(0);
    });
  });
});
