/*
 * Coverage claims, read by `pnpm test:inventory` (owner request 2026-09-03).
 *
 * These are what this file is answerable for in the test matrix. A claim naming
 * something the inventory no longer contains fails the scan, so a screen renamed
 * out from under a test cannot leave the coverage report quietly overstating itself.
 *
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
import { prepareTestDatabase, resetDatabase, seedTenant, testPool, todayIn } from './support/database';

const clock = new SystemClock();
const CONCURRENT_WRITES = 50;

let app: INestApplication;
let pool: pg.Pool;
let tenant: SeededTenant;
let token: string;

beforeAll(async () => {
  pool = testPool();
  await prepareTestDatabase();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.useGlobalFilters(new AppErrorFilter());
  // Listen on a real ephemeral port: supertest would otherwise bind the server
  // per request, and 50 concurrent binds reset each other's sockets.
  await app.listen(0);
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

beforeEach(async () => {
  await resetDatabase(pool);
  tenant = await seedTenant(pool, {
    name: 'Numbering',
    permissions: [Permission.NOTE_CREATE, Permission.NOTE_VIEW],
  });
  token = signToken(tenant, TEST_JWT_SECRET);
});

/**
 * Duplicate document numbers are a defect a customer finds, not a test.
 * SELECT ... FOR UPDATE on the counter row is what prevents them (SRS 3.7).
 */
describe('document numbering under concurrency', () => {
  it(`${String(CONCURRENT_WRITES)} concurrent creates produce ${String(CONCURRENT_WRITES)} unique sequential numbers with no gaps`, async () => {
    const businessDate = todayIn(tenant.timezone);
    const year = businessDate.slice(0, 4);

    const responses = await Promise.all(
      Array.from({ length: CONCURRENT_WRITES }, (_, index) =>
        request(app.getHttpServer())
          .post('/api/v1/notes')
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', Ulid.generate(clock))
          .send({ title: `Concurrent ${String(index)}`, amountMinor: 100, businessDate }),
      ),
    );

    expect(responses.every((response) => response.status === 201)).toBe(true);

    const numbers = responses.map((response) => response.body.data.noteNumber as string).sort();
    const expected = Array.from({ length: CONCURRENT_WRITES }, (_, index) =>
      `NOTE-${year}-${String(index + 1).padStart(6, '0')}`,
    ).sort();

    expect(new Set(numbers).size).toBe(CONCURRENT_WRITES);
    expect(numbers).toEqual(expected);
  });

  it('numbers restart per tenant', async () => {
    const businessDate = todayIn(tenant.timezone);
    const year = businessDate.slice(0, 4);
    const other = await seedTenant(pool, { name: 'Other', permissions: [Permission.NOTE_CREATE] });

    const first = await request(app.getHttpServer())
      .post('/api/v1/notes')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', Ulid.generate(clock))
      .send({ title: 'Tenant one', amountMinor: 1, businessDate });

    const second = await request(app.getHttpServer())
      .post('/api/v1/notes')
      .set('Authorization', `Bearer ${signToken(other, TEST_JWT_SECRET)}`)
      .set('Idempotency-Key', Ulid.generate(clock))
      .send({ title: 'Tenant two', amountMinor: 1, businessDate });

    expect(first.body.data.noteNumber).toBe(`NOTE-${year}-000001`);
    expect(second.body.data.noteNumber).toBe(`NOTE-${year}-000001`);
  });
});
