/*
 * Coverage claims, read by `pnpm test:inventory` (owner request 2026-09-03).
 *
 * These are what this file is answerable for in the test matrix. A claim naming
 * something the inventory no longer contains fails the scan, so a screen renamed
 * out from under a test cannot leave the coverage report quietly overstating itself.
 *
 * @covers endpoint:GET /api/v1/money/reconciliations/:id/statement/:fileId/file
 * @covers endpoint:POST /api/v1/money/reconciliations
 * @covers endpoint:POST /api/v1/money/reconciliations/:id/statement
 */
import 'reflect-metadata';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
import { asTenant, prepareTestDatabase, resetDatabase, seedTenant, testPool } from './support/database';

/**
 * Reading the bank's PDF (§5.17, Phase 11).
 *
 * Three fixtures, one for each thing a shop actually uploads: a statement with
 * text in it, a scan with none, and a file that is not really a PDF. The three
 * answers are deliberately different — read it, keep it and carry on by hand,
 * and refuse it with a reason — because collapsing them would leave the owner
 * unable to tell "I need to type these by hand" from "this file is broken".
 */

const clock = new SystemClock();
const fixture = (name: string): Buffer =>
  readFileSync(join(__dirname, 'support/fixtures', name));

let app: INestApplication;
let pool: pg.Pool;
let tenant: SeededTenant;
let token: string;
let reconciliationId: string;

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
  tenant = await seedTenant(pool, {
    name: 'Statement Test',
    permissions: [
      Permission.BANK_ACCOUNT_VIEW,
      Permission.RECONCILIATION_VIEW,
      Permission.RECONCILIATION_PERFORM,
    ],
  });
  token = signToken(tenant, TEST_JWT_SECRET);

  const accountId = Ulid.generate(clock);
  await asTenant(pool, tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO accounts (id, tenant_id, name, type, is_drawer, status, created_at, updated_at, created_by, updated_by, version)
       VALUES ($1, $2, 'Sher Test Bank', 'BANK', FALSE, 'ACTIVE', now(), now(), $3, $3, 1)`,
      [accountId, tenant.tenantId, tenant.userId],
    ),
  );

  const started = await request(app.getHttpServer())
    .post('/api/v1/money/reconciliations')
    .set('Authorization', `Bearer ${token}`)
    .send({
      accountId,
      fromDate: '2026-08-01',
      toDate: '2026-08-31',
      operationId: Ulid.generate(clock),
    });
  reconciliationId = started.body.data.id as string;
});

function upload(name: string, bytes: Buffer): request.Test {
  return request(app.getHttpServer())
    .post(`/api/v1/money/reconciliations/${reconciliationId}/statement`)
    .set('Authorization', `Bearer ${token}`)
    .send({ fileName: name, contentBase64: bytes.toString('base64') });
}

describe('a statement with text in it', () => {
  it('reads the rows, the dates and both balances', async () => {
    const response = await upload('statement.pdf', fixture('statement.pdf'));

    expect(response.status).toBe(200);
    expect(response.body.data.parseStatus).toBe('PARSED');
    expect(response.body.data.openingBalanceMinor).toBe(3_000_000);
    expect(response.body.data.closingBalanceMinor).toBe(3_950_000);
    expect(response.body.data.lines).toEqual([
      expect.objectContaining({
        businessDate: '2026-08-05',
        amountMinor: 1_000_000,
        reference: 'TX889',
      }),
      expect.objectContaining({
        businessDate: '2026-08-08',
        amountMinor: -50_000,
        reference: 'TR223',
      }),
    ]);
  });

  it('imports nothing until the owner has read the preview', async () => {
    await upload('statement.pdf', fixture('statement.pdf'));

    const stored = await asTenant(pool, tenant.tenantId, (client) =>
      client.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM statement_lines'),
    );

    expect(stored.rows[0]?.count).toBe('0');
  });
});

describe('a scan, with no text layer at all', () => {
  it('keeps the file and says it could not be read, rather than refusing it', async () => {
    const response = await upload('scanned.pdf', fixture('scanned.pdf'));

    expect(response.status).toBe(200);
    expect(response.body.data.parseStatus).toBe('UNREADABLE');
    expect(response.body.data.lines).toEqual([]);

    const kept = await asTenant(pool, tenant.tenantId, (client) =>
      client.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM bank_statement_files'),
    );
    expect(kept.rows[0]?.count).toBe('1');
  });
});

describe('a file that is not really a PDF', () => {
  it('refuses it with a reason the owner can act on', async () => {
    const response = await upload('corrupt.pdf', fixture('corrupt.pdf'));

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
    expect(response.body.error.message).toContain('password-protected');

    const kept = await asTenant(pool, tenant.tenantId, (client) =>
      client.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM bank_statement_files'),
    );
    // Nothing was stored: there is no evidence in a file that will not open.
    expect(kept.rows[0]?.count).toBe('0');
  });
});

describe('the original stays available', () => {
  it('gives back the exact bytes that were uploaded', async () => {
    const original = fixture('statement.pdf');
    const uploaded = await upload('statement.pdf', original);
    const fileId = uploaded.body.data.fileId as string;

    const download = await request(app.getHttpServer())
      .get(`/api/v1/money/reconciliations/${reconciliationId}/statement/${fileId}/file`)
      .set('Authorization', `Bearer ${token}`)
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    expect(download.status).toBe(200);
    expect(download.headers['content-type']).toContain('application/pdf');
    expect(Buffer.compare(download.body as Buffer, original)).toBe(0);
  });
});
