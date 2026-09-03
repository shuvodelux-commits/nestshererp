/*
 * Coverage claims, read by `pnpm test:inventory` (owner request 2026-09-03).
 *
 * These are what this file is answerable for in the test matrix. A claim naming
 * something the inventory no longer contains fails the scan, so a screen renamed
 * out from under a test cannot leave the coverage report quietly overstating itself.
 *
 * @covers endpoint:GET /api/v1/notes/:id
 * @covers endpoint:POST /api/v1/notes
 */
import 'reflect-metadata';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Permission } from '@sher/core-contracts';
import { SystemClock, Ulid } from '@sher/shared-utils';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { AppErrorFilter } from '../src/common/app-error.filter';
import { signToken, TEST_JWT_SECRET } from './support/auth';
import type { SeededTenant } from './support/database';
import { asTenant, closePeriod, prepareTestDatabase, resetDatabase, seedTenant, testPool, todayIn } from './support/database';

const clock = new SystemClock();

let app: INestApplication;
let pool: pg.Pool;
let tenantA: SeededTenant;
let tenantB: SeededTenant;
let tokenA: string;
let tokenB: string;

const ALL_PERMISSIONS = [Permission.NOTE_CREATE, Permission.NOTE_VIEW];

function post(token: string, operationId: string, body: unknown): request.Test {
  return request(app.getHttpServer())
    .post('/api/v1/notes')
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', operationId)
    .send(body as object);
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
  tenantA = await seedTenant(pool, { name: 'Tenant A', permissions: ALL_PERMISSIONS });
  tenantB = await seedTenant(pool, { name: 'Tenant B', permissions: ALL_PERMISSIONS });
  tokenA = signToken(tenantA, TEST_JWT_SECRET);
  tokenB = signToken(tenantB, TEST_JWT_SECRET);
});

describe('the ten-step write path', () => {
  it('creates a note, numbered, audited and mirrored to the outbox', async () => {
    const today = todayIn(tenantA.timezone);
    const response = await post(tokenA, Ulid.generate(clock), {
      title: 'Opening note',
      amountMinor: 125075,
      businessDate: today,
    });

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      noteNumber: `NOTE-${today.slice(0, 4)}-000001`,
      title: 'Opening note',
      amountMinor: 125075,
      businessDate: today,
      entryMode: 'ON_TIME',
      status: 'POSTED',
    });

    const written = await asTenant(pool, tenantA.tenantId, async (client) => ({
      notes: await client.query('SELECT amount_minor, entry_mode FROM notes'),
      audit: await client.query('SELECT action, before_json, after_json, source FROM audit_events'),
      outbox: await client.query('SELECT event_type, payload FROM outbox'),
    }));

    // Money is stored as an integer minor unit, not a float.
    expect(written.notes.rows).toEqual([{ amount_minor: 125075, entry_mode: 'ON_TIME' }]);

    // R-D4: one audit event, with before/after money values.
    expect(written.audit.rows).toHaveLength(1);
    expect(written.audit.rows[0]).toMatchObject({
      action: 'CREATE',
      before_json: null,
      after_json: { noteNumber: `NOTE-${today.slice(0, 4)}-000001`, title: 'Opening note', amountMinor: 125075 },
      source: 'API',
    });

    // R-D7: exactly one outbox row, written in the same transaction.
    expect(written.outbox.rows).toHaveLength(1);
    expect(written.outbox.rows[0]).toMatchObject({
      event_type: 'note.created',
      payload: { noteNumber: `NOTE-${today.slice(0, 4)}-000001`, amountMinor: 125075 },
    });
  });

  it('rolls the whole transaction back when a step fails — no note, no audit, no outbox', async () => {
    const today = todayIn(tenantA.timezone);
    const [year, month] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
    await closePeriod(pool, tenantA, year, month);

    const response = await post(tokenA, Ulid.generate(clock), {
      title: 'Into a locked month',
      amountMinor: 5000,
      businessDate: today,
    });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('PERIOD_LOCKED');

    const counts = await asTenant(pool, tenantA.tenantId, async (client) => ({
      notes: (await client.query('SELECT 1 FROM notes')).rowCount,
      audit: (await client.query('SELECT 1 FROM audit_events')).rowCount,
      outbox: (await client.query('SELECT 1 FROM outbox')).rowCount,
      keys: (await client.query('SELECT 1 FROM idempotency_keys')).rowCount,
    }));

    expect(counts).toEqual({ notes: 0, audit: 0, outbox: 0, keys: 0 });
  });

  it('rejects a future business date', async () => {
    const response = await post(tokenA, Ulid.generate(clock), {
      title: 'Tomorrow',
      amountMinor: 100,
      businessDate: '2099-01-01',
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('idempotency (R-D3)', () => {
  it('returns ONE record and the same response for a repeated operation_id', async () => {
    const operationId = Ulid.generate(clock);
    const body = { title: 'Retried', amountMinor: 4200, businessDate: todayIn(tenantA.timezone) };

    const first = await post(tokenA, operationId, body);
    const second = await post(tokenA, operationId, body);

    expect(first.status).toBe(201);
    expect(second.body.data).toEqual(first.body.data);

    const rows = await asTenant(pool, tenantA.tenantId, (client) =>
      client.query('SELECT id FROM notes'),
    );
    expect(rows.rowCount).toBe(1);
  });

  it('still returns ONE record after the 30-day fast path row is pruned', async () => {
    const operationId = Ulid.generate(clock);
    const body = { title: 'Replayed after prune', amountMinor: 999, businessDate: todayIn(tenantA.timezone) };

    const first = await post(tokenA, operationId, body);

    // Simulate the prune: the fast path is gone, the unique index is not.
    await asTenant(pool, tenantA.tenantId, (client) =>
      client.query('DELETE FROM idempotency_keys'),
    );

    const replay = await post(tokenA, operationId, body);

    expect(replay.status).toBe(201);
    expect(replay.body.data.id).toBe(first.body.data.id);
    expect(replay.body.data.noteNumber).toBe(first.body.data.noteNumber);

    const rows = await asTenant(pool, tenantA.tenantId, (client) =>
      client.query('SELECT id FROM notes'),
    );
    expect(rows.rowCount).toBe(1);
  });

  it('rejects the same key with a different payload', async () => {
    const operationId = Ulid.generate(clock);
    const businessDate = todayIn(tenantA.timezone);

    await post(tokenA, operationId, { title: 'First', amountMinor: 100, businessDate });
    const conflict = await post(tokenA, operationId, { title: 'Changed', amountMinor: 200, businessDate });

    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('requires the Idempotency-Key header', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/notes')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ title: 'No key', amountMinor: 1, businessDate: todayIn(tenantA.timezone) });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('tenant isolation (R-E5)', () => {
  it('tenant B cannot READ tenant A\'s note — 404, never 403', async () => {
    const created = await post(tokenA, Ulid.generate(clock), {
      title: 'Tenant A private',
      amountMinor: 1000,
      businessDate: todayIn(tenantA.timezone),
    });

    const asB = await request(app.getHttpServer())
      .get(`/api/v1/notes/${created.body.data.id}`)
      .set('Authorization', `Bearer ${tokenB}`);

    expect(asB.status).toBe(404);
    expect(asB.body.error.code).toBe('NOT_FOUND');

    const asA = await request(app.getHttpServer())
      .get(`/api/v1/notes/${created.body.data.id}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(asA.status).toBe(200);
  });

  it('tenant B WRITING with tenant A\'s operation_id creates its own record, not a shared one', async () => {
    const operationId = Ulid.generate(clock);
    const businessDate = todayIn(tenantA.timezone);

    const a = await post(tokenA, operationId, { title: 'A', amountMinor: 111, businessDate });
    const b = await post(tokenB, operationId, { title: 'B', amountMinor: 222, businessDate });

    expect(a.body.data.id).not.toBe(b.body.data.id);
    expect(b.body.data.amountMinor).toBe(222);

    const inA = await asTenant(pool, tenantA.tenantId, (client) =>
      client.query('SELECT amount_minor FROM notes'),
    );
    expect(inA.rows).toEqual([{ amount_minor: 111 }]);
  });

  it('ignores a tenant_id smuggled in the request body', async () => {
    const response = await post(tokenA, Ulid.generate(clock), {
      title: 'Smuggled',
      amountMinor: 100,
      businessDate: todayIn(tenantA.timezone),
      tenantId: tenantB.tenantId,
    });

    // The contract is strict: an unknown field is a validation failure, and the
    // tenant could not have been changed even if it were accepted.
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('permissions (R-E8)', () => {
  it('denies a user whose role lacks demo.note.create', async () => {
    const readOnly = await seedTenant(pool, { name: 'Read only', permissions: [Permission.NOTE_VIEW] });
    const token = signToken(readOnly, TEST_JWT_SECRET);

    const response = await post(token, Ulid.generate(clock), {
      title: 'Not allowed',
      amountMinor: 1,
      businessDate: todayIn(readOnly.timezone),
    });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('PERMISSION_DENIED');
  });

  it('denies a user whose role lacks demo.note.view', async () => {
    const created = await post(tokenA, Ulid.generate(clock), {
      title: 'Visible to A only',
      amountMinor: 1,
      businessDate: todayIn(tenantA.timezone),
    });

    const writeOnly = await seedTenant(pool, { name: 'Write only', permissions: [Permission.NOTE_CREATE] });
    const response = await request(app.getHttpServer())
      .get(`/api/v1/notes/${created.body.data.id}`)
      .set('Authorization', `Bearer ${signToken(writeOnly, TEST_JWT_SECRET)}`);

    expect(response.status).toBe(403);
  });

  it('rejects a request with no token, and one signed with the wrong secret', async () => {
    const noToken = await request(app.getHttpServer()).get('/api/v1/notes/whatever');
    expect(noToken.status).toBe(401);

    const forged = await request(app.getHttpServer())
      .get('/api/v1/notes/whatever')
      .set('Authorization', `Bearer ${signToken(tenantA, 'wrong-secret')}`);
    expect(forged.status).toBe(401);
    expect(forged.body.error.code).toBe('UNAUTHENTICATED');
  });
});

describe('entry_mode (SRS 3.4)', () => {
  it('is LATE_ENTRY earlier in the same month and BACKDATED in an earlier month', async () => {
    const today = todayIn(tenantA.timezone);
    const year = today.slice(0, 4);
    const month = today.slice(5, 7);
    const dayOfMonth = Number(today.slice(8, 10));

    if (dayOfMonth > 1) {
      const earlierSameMonth = `${year}-${month}-01`;
      const late = await post(tokenA, Ulid.generate(clock), {
        title: 'Late entry',
        amountMinor: 10,
        businessDate: earlierSameMonth,
      });
      expect(late.body.data.entryMode).toBe('LATE_ENTRY');
    }

    const earlierMonth = `${String(Number(year) - 1)}-01-15`;
    const backdated = await post(tokenA, Ulid.generate(clock), {
      title: 'Backdated',
      amountMinor: 10,
      businessDate: earlierMonth,
    });
    expect(backdated.body.data.entryMode).toBe('BACKDATED');
  });
});
