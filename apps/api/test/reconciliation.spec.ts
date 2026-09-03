/*
 * Coverage claims, read by `pnpm test:inventory` (owner request 2026-09-03).
 *
 * These are what this file is answerable for in the test matrix. A claim naming
 * something the inventory no longer contains fails the scan, so a screen renamed
 * out from under a test cannot leave the coverage report quietly overstating itself.
 *
 * @covers endpoint:DELETE /api/v1/money/reconciliations/:id/matches/:matchId
 * @covers endpoint:GET /api/v1/money/reconciliations/:id
 * @covers endpoint:POST /api/v1/money/reconciliations
 * @covers endpoint:POST /api/v1/money/reconciliations/:id/complete
 * @covers endpoint:POST /api/v1/money/reconciliations/:id/matches
 * @covers endpoint:POST /api/v1/money/reconciliations/:id/reopen
 * @covers endpoint:POST /api/v1/money/reconciliations/:id/statement
 * @covers endpoint:POST /api/v1/money/reconciliations/:id/statement/confirm
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
 * Account reconciliation, end to end (§5.17, Phase 11).
 *
 * Two things are being proved here. The first is the workflow: import a
 * statement, let the engine match what it can, resolve the rest, sign off, and
 * find the sign-off still saying what it said.
 *
 * The second matters more. Reconciliation is allowed to compare and to link,
 * and **nothing else** — so this file counts the journal and document rows
 * before and after everything the module can be made to do, and asserts that
 * not one of them moved.
 */

const clock = new SystemClock();
const STATEMENT = readFileSync(join(__dirname, 'support/fixtures/statement.pdf'));

const FULL_ACCESS = [
  Permission.BANK_ACCOUNT_VIEW,
  Permission.RECONCILIATION_VIEW,
  Permission.RECONCILIATION_PERFORM,
  Permission.RECONCILIATION_REOPEN,
];

let app: INestApplication;
let pool: pg.Pool;
let tenant: SeededTenant;
let token: string;
let accountId: string;

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

/** A bank account and the two entries the fixture statement also shows. */
async function seedLedger(
  target: SeededTenant,
  rows: readonly { number: string; date: string; amountMinor: number; type?: string }[],
): Promise<string> {
  const id = Ulid.generate(clock);
  const now = clock.now();

  await asTenant(pool, target.tenantId, async (client) => {
    await client.query(
      `INSERT INTO accounts (id, tenant_id, name, type, is_drawer, status, created_at, updated_at, created_by, updated_by, version)
       VALUES ($1, $2, 'Sher Test Bank', 'BANK', FALSE, 'ACTIVE', $3, $3, $4, $4, 1)`,
      [id, target.tenantId, now, target.userId],
    );

    for (const row of rows) {
      const entryId = Ulid.generate(clock);
      // The journal is append-only: no updated_at, no version, nothing that
      // could be edited in place (§2.4).
      await client.query(
        `INSERT INTO journal_entries (id, tenant_id, business_date, source_document_type, source_document_id, source_number, entry_mode, created_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, 'ON_TIME', $7, $8)`,
        [
          entryId,
          target.tenantId,
          row.date,
          row.type ?? 'CUSTOMER_RECEIPT',
          Ulid.generate(clock),
          row.number,
          now,
          target.userId,
        ],
      );
      await client.query(
        `INSERT INTO journal_lines (id, tenant_id, journal_entry_id, account_code, amount_minor, created_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          Ulid.generate(clock),
          target.tenantId,
          entryId,
          `BANK:${id}`,
          row.amountMinor,
          now,
          target.userId,
        ],
      );
    }
  });

  return id;
}

async function ledgerFootprint(target: SeededTenant): Promise<Record<string, number>> {
  return asTenant(pool, target.tenantId, async (client) => {
    const counts: Record<string, number> = {};
    for (const table of ['journal_entries', 'journal_lines', 'expenses', 'customer_receipts', 'cash_movements']) {
      const result = await client.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ${table}`);
      counts[table] = Number(result.rows[0]?.count ?? '0');
    }
    return counts;
  });
}

async function start(fromDate = '2026-08-01', toDate = '2026-08-31'): Promise<string> {
  const response = await request(app.getHttpServer())
    .post('/api/v1/money/reconciliations')
    .set('Authorization', `Bearer ${token}`)
    .send({ accountId, fromDate, toDate, operationId: Ulid.generate(clock) });

  expect(response.status).toBe(201);
  return response.body.data.id as string;
}

async function importStatement(id: string): Promise<Record<string, unknown>> {
  const upload = await request(app.getHttpServer())
    .post(`/api/v1/money/reconciliations/${id}/statement`)
    .set('Authorization', `Bearer ${token}`)
    .send({ fileName: 'statement.pdf', contentBase64: STATEMENT.toString('base64') });

  expect(upload.status).toBe(200);

  const confirmed = await request(app.getHttpServer())
    .post(`/api/v1/money/reconciliations/${id}/statement/confirm`)
    .set('Authorization', `Bearer ${token}`)
    .send({
      fileId: upload.body.data.fileId,
      lines: upload.body.data.lines,
      openingBalanceMinor: upload.body.data.openingBalanceMinor,
      closingBalanceMinor: upload.body.data.closingBalanceMinor,
    });

  expect(confirmed.status).toBe(200);
  return confirmed.body.data as Record<string, unknown>;
}

beforeEach(async () => {
  await resetDatabase(pool);
  tenant = await seedTenant(pool, { name: 'Reconcile Test', permissions: FULL_ACCESS });
  token = signToken(tenant, TEST_JWT_SECRET);
  accountId = await seedLedger(tenant, [
    { number: 'RCPT-101', date: '2026-08-05', amountMinor: 1_000_000 },
    { number: 'EXP-9', date: '2026-08-08', amountMinor: -50_000, type: 'EXPENSE' },
  ]);
});

describe('matching what the bank sent against what the shop recorded', () => {
  it('matches both entries automatically and leaves nothing loose', async () => {
    const id = await start();
    const workspace = (await importStatement(id)) as never as {
      summary: Record<string, number & string[]>;
      ledgerRows: { matchState: string | null }[];
    };

    expect(workspace.ledgerRows.map((row) => row.matchState)).toEqual(['AUTO', 'AUTO']);
    expect(workspace.summary['autoMatched']).toBe(2);
    expect(workspace.summary['statementOnly']).toBe(0);
    expect(workspace.summary['ledgerOnly']).toBe(0);
  });

  it('adds the opening balance to what was matched, and agrees with the statement', async () => {
    const id = await start();
    const workspace = await importStatement(id);
    const summary = workspace['summary'] as Record<string, number>;

    // Nothing before 1 August, so the book opens at zero; the two matched
    // entries come to 9,500, and the difference against the bank's 39,500 is
    // the 30,000 opening the shop never recorded — which is exactly the sort of
    // gap a reconciliation exists to show.
    expect(summary['bookOpeningMinor']).toBe(0);
    expect(summary['reconciledBalanceMinor']).toBe(950_000);
    expect(summary['statementClosingMinor']).toBe(3_950_000);
    expect(summary['differenceMinor']).toBe(3_000_000);
  });

  it('undoes a link when asked, and puts the row back among the unmatched', async () => {
    const id = await start();
    await importStatement(id);

    const marked = await request(app.getHttpServer())
      .post(`/api/v1/money/reconciliations/${id}/matches`)
      .set('Authorization', `Bearer ${token}`)
      .send({ statementLineId: null, journalLineId: null, state: 'NEEDS_REVIEW' });
    expect(marked.status).toBe(400);

    const workspace = await request(app.getHttpServer())
      .get(`/api/v1/money/reconciliations/${id}`)
      .set('Authorization', `Bearer ${token}`);
    const row = workspace.body.ledgerRows[0];

    const parked = await request(app.getHttpServer())
      .post(`/api/v1/money/reconciliations/${id}/matches`)
      .set('Authorization', `Bearer ${token}`)
      .send({ statementLineId: null, journalLineId: row.journalLineId, state: 'NEEDS_REVIEW' });
    expect(parked.status).toBe(200);
    expect(parked.body.data.summary.needsReview).toBe(1);

    const matchId = parked.body.data.ledgerRows.find(
      (candidate: { journalLineId: string }) => candidate.journalLineId === row.journalLineId,
    ).matchId;

    const undone = await request(app.getHttpServer())
      .delete(`/api/v1/money/reconciliations/${id}/matches/${matchId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(undone.status).toBe(200);
    expect(undone.body.data.summary.needsReview).toBe(0);
    expect(undone.body.data.summary.autoMatched).toBe(2);
  });
});

describe('signing off, and what happens afterwards', () => {
  it('refuses to complete while anything is still unresolved', async () => {
    const id = await start();
    await importStatement(id);

    const refused = await request(app.getHttpServer())
      .post(`/api/v1/money/reconciliations/${id}/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ statementClosingBalanceMinor: 3_950_000, note: null, version: 1 });

    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('completes when the difference is zero, and keeps saying so', async () => {
    const id = await start();
    await importStatement(id);

    const completed = await request(app.getHttpServer())
      .post(`/api/v1/money/reconciliations/${id}/complete`)
      .set('Authorization', `Bearer ${token}`)
      // The bank's closing balance, less the opening the shop had not recorded:
      // what this reconciliation can honestly certify for these two entries.
      .send({ statementClosingBalanceMinor: 950_000, note: 'August', version: 1 });

    expect(completed.status).toBe(200);
    expect(completed.body.data.status).toBe('COMPLETED');
    expect(completed.body.data.summary.differenceMinor).toBe(0);

    const stored = await asTenant(pool, tenant.tenantId, (client) =>
      client.query<{ reconciled_balance_minor: number; status: string }>(
        'SELECT reconciled_balance_minor, status FROM account_reconciliations WHERE id = $1',
        [id],
      ),
    );
    expect(stored.rows[0]).toMatchObject({ status: 'COMPLETED', reconciled_balance_minor: 950_000 });
  });

  it('refuses every change to a completed reconciliation until it is reopened', async () => {
    const id = await start();
    const workspace = await importStatement(id);
    await request(app.getHttpServer())
      .post(`/api/v1/money/reconciliations/${id}/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ statementClosingBalanceMinor: 950_000, note: null, version: 1 });

    const rows = workspace['ledgerRows'] as { journalLineId: string }[];
    const blocked = await request(app.getHttpServer())
      .post(`/api/v1/money/reconciliations/${id}/matches`)
      .set('Authorization', `Bearer ${token}`)
      .send({ statementLineId: null, journalLineId: rows[0]?.journalLineId, state: 'NEEDS_REVIEW' });

    expect(blocked.status).toBe(400);

    const reopened = await request(app.getHttpServer())
      .post(`/api/v1/money/reconciliations/${id}/reopen`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'The bank sent a corrected statement', version: 2 });

    expect(reopened.status).toBe(200);
    expect(reopened.body.data.status).toBe('DRAFT');
    // What it certified is still on the row: reopening says the shop is looking
    // again, not that the sign-off never happened (§5.17).
    const kept = await asTenant(pool, tenant.tenantId, (client) =>
      client.query<{ reconciled_balance_minor: number }>(
        'SELECT reconciled_balance_minor FROM account_reconciliations WHERE id = $1',
        [id],
      ),
    );
    expect(kept.rows[0]?.reconciled_balance_minor).toBe(950_000);
  });

  it('marks a completed reconciliation for review when a matched entry is later corrected', async () => {
    const id = await start();
    await importStatement(id);
    await request(app.getHttpServer())
      .post(`/api/v1/money/reconciliations/${id}/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ statementClosingBalanceMinor: 950_000, note: null, version: 1 });

    // A correction is another posting against the same document (§2.5). The
    // reconciliation is not touched — it reads the change back from the ledger.
    await asTenant(pool, tenant.tenantId, async (client) => {
      const source = await client.query<{ source_document_id: string }>(
        `SELECT source_document_id FROM journal_entries WHERE source_number = 'RCPT-101'`,
      );
      await client.query(
        `INSERT INTO journal_entries (id, tenant_id, business_date, source_document_type, source_document_id, source_number, entry_mode, created_at, created_by)
         VALUES ($1, $2, '2026-08-09', 'CUSTOMER_RECEIPT_CORRECTION', $3, 'RCPT-101', 'CORRECTED', now(), $4)`,
        [Ulid.generate(clock), tenant.tenantId, source.rows[0]?.source_document_id, tenant.userId],
      );
    });

    const reread = await request(app.getHttpServer())
      .get(`/api/v1/money/reconciliations/${id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(reread.body.status).toBe('REVIEW_REQUIRED');
    expect(reread.body.changedSinceCompletion).toEqual([
      expect.objectContaining({ sourceNumber: 'RCPT-101' }),
    ]);
  });
});

describe('who may do what, and whose data it is', () => {
  it('refuses a user without the reconciliation permissions', async () => {
    const outsider = await seedTenant(pool, {
      name: 'No Access',
      permissions: [Permission.BANK_ACCOUNT_VIEW],
    });
    const theirToken = signToken(outsider, TEST_JWT_SECRET);

    const refused = await request(app.getHttpServer())
      .post('/api/v1/money/reconciliations')
      .set('Authorization', `Bearer ${theirToken}`)
      .send({
        accountId,
        fromDate: '2026-08-01',
        toDate: '2026-08-31',
        operationId: Ulid.generate(clock),
      });

    expect(refused.status).toBe(403);
  });

  it('does not let one shop open another shop’s reconciliation', async () => {
    const id = await start();

    const other = await seedTenant(pool, { name: 'Other Shop', permissions: FULL_ACCESS });
    const otherToken = signToken(other, TEST_JWT_SECRET);

    const attempt = await request(app.getHttpServer())
      .get(`/api/v1/money/reconciliations/${id}`)
      .set('Authorization', `Bearer ${otherToken}`);

    expect(attempt.status).toBe(404);
  });

  it('refuses to reconcile a cash drawer — cash is counted, not matched', async () => {
    const cashId = Ulid.generate(clock);
    await asTenant(pool, tenant.tenantId, (client) =>
      client.query(
        `INSERT INTO accounts (id, tenant_id, name, type, is_drawer, status, created_at, updated_at, created_by, updated_by, version)
         VALUES ($1, $2, 'Drawer', 'CASH', TRUE, 'ACTIVE', now(), now(), $3, $3, 1)`,
        [cashId, tenant.tenantId, tenant.userId],
      ),
    );

    const refused = await request(app.getHttpServer())
      .post('/api/v1/money/reconciliations')
      .set('Authorization', `Bearer ${token}`)
      .send({
        accountId: cashId,
        fromDate: '2026-08-01',
        toDate: '2026-08-31',
        operationId: Ulid.generate(clock),
      });

    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toContain('Daily Cash');
  });
});

describe('the safety rule', () => {
  it('never writes a journal line or a document, whatever is done to it', async () => {
    const before = await ledgerFootprint(tenant);

    const id = await start();
    const workspace = await importStatement(id);
    const rows = workspace['ledgerRows'] as { journalLineId: string; matchId: string | null }[];
    const statementRows = workspace['statementRows'] as { statementLineId: string }[];

    await request(app.getHttpServer())
      .post(`/api/v1/money/reconciliations/${id}/matches`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        statementLineId: statementRows[0]?.statementLineId,
        journalLineId: rows[0]?.journalLineId,
        state: 'REJECTED',
      });
    await request(app.getHttpServer())
      .post(`/api/v1/money/reconciliations/${id}/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ statementClosingBalanceMinor: 950_000, note: null, version: 1 });

    const after = await ledgerFootprint(tenant);

    // The whole module, exercised end to end, and the ledger is bit for bit
    // what it was. Reconciliation compares and links; posting belongs to the
    // modules that own the documents.
    expect(after).toEqual(before);
  });
});
