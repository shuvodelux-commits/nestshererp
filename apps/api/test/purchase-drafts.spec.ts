/*
 * @covers endpoint:GET /api/v1/purchases/drafts
 * @covers endpoint:GET /api/v1/purchases/drafts/:id
 * @covers endpoint:POST /api/v1/purchases/drafts
 * @covers endpoint:PUT /api/v1/purchases/drafts/:id
 * @covers endpoint:DELETE /api/v1/purchases/drafts/:id
 * @covers endpoint:POST /api/v1/purchases/drafts/:id/restore
 */
import 'reflect-metadata';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Permission } from '@sher/core-contracts';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { AppErrorFilter } from '../src/common/app-error.filter';
import { signToken, TEST_JWT_SECRET } from './support/auth';
import type { SeededTenant } from './support/database';
import { asTenant, prepareTestDatabase, resetDatabase, seedTenant, testPool } from './support/database';

let app: INestApplication;
let pool: pg.Pool;
let tenantA: SeededTenant;
let tenantB: SeededTenant;
let tokenA: string;
let tokenB: string;

const allowed = [Permission.PURCHASE_CREATE, Permission.COST_VIEW];
const OPERATION_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const body = (operationId = OPERATION_ID) => ({
  operationId,
  label: 'Unfinished supplier invoice',
  supplierName: 'Test Supplier',
  itemCount: 1,
  grandTotalMinor: 125075,
  cart: {
    date: '2026-11-13',
    referenceNo: 'PO-TEST-7',
    lines: [{ id: 'line-1', quantity: { box: 1, piece: 5 }, price: '1250.75' }],
    payments: [{ id: 'pay-1', method: 'Cash', amount: '0' }],
    photos: [],
  },
});

/** Update and recycle contracts do NOT accept the create-only operationId. */
const updateBody = () => {
  const original = body();
  return {
    label: original.label,
    supplierName: original.supplierName,
    itemCount: original.itemCount,
    grandTotalMinor: original.grandTotalMinor,
    cart: original.cart,
  };
};
const route = '/api/v1/purchases/drafts';
const authed = (token: string) => ({ Authorization: `Bearer ${token}` });

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
  tenantA = await seedTenant(pool, { name: 'Draft business A', permissions: allowed });
  tenantB = await seedTenant(pool, { name: 'Draft business B', permissions: allowed });
  tokenA = signToken(tenantA, TEST_JWT_SECRET);
  tokenB = signToken(tenantB, TEST_JWT_SECRET);
});

describe('MOD-008 durable purchase drafts, never postings', () => {
  it('saves, lists, resumes, updates, recycles and restores exactly one draft', async () => {
    const create = await request(app.getHttpServer()).post(route).set(authed(tokenA)).send(body());
    expect(create.status).toBe(201);
    expect(create.body.data).toMatchObject({
      label: 'Unfinished supplier invoice', supplierName: 'Test Supplier',
      itemCount: 1, grandTotalMinor: 125075, version: 1, deletedAt: null,
    });
    const id = create.body.data.id as string;
    expect(id).toHaveLength(26);
    expect(create.body.data.cart.lines).toEqual(body().cart.lines);

    const list = await request(app.getHttpServer()).get(route).set(authed(tokenA));
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    const detail = await request(app.getHttpServer()).get(`${route}/${id}`).set(authed(tokenA));
    expect(detail.status).toBe(200);
    expect(detail.body.data.cart.payments).toEqual(body().cart.payments);

    const updated = await request(app.getHttpServer()).put(`${route}/${id}`).set(authed(tokenA))
      .send({ ...updateBody(), label: 'Resumed, saved again', expectedVersion: 1 });
    expect(updated.status).toBe(200);
    expect(updated.body.data).toMatchObject({ id, label: 'Resumed, saved again', version: 2 });

    const stale = await request(app.getHttpServer()).put(`${route}/${id}`).set(authed(tokenA))
      .send({ ...updateBody(), expectedVersion: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('CONFLICT_STALE_VERSION');

    const recycled = await request(app.getHttpServer()).delete(`${route}/${id}`).set(authed(tokenA))
      .send({ expectedVersion: 2 });
    expect(recycled.status).toBe(200);
    expect(recycled.body.data.version).toBe(3);
    expect(recycled.body.data.recoverableUntilEpochMs).toBe(Date.parse(recycled.body.data.deletedAt) + 30 * 86_400_000);
    const empty = await request(app.getHttpServer()).get(route).set(authed(tokenA));
    expect(empty.body.data).toEqual([]);
    const deleted = await request(app.getHttpServer()).get(`${route}?state=deleted`).set(authed(tokenA));
    expect(deleted.body.data.map((draft: {id: string}) => draft.id)).toEqual([id]);

    const restored = await request(app.getHttpServer()).post(`${route}/${id}/restore`)
      .set(authed(tokenA)).send({ expectedVersion: 3 });
    expect(restored.status).toBe(200);
    expect(restored.body.data).toMatchObject({ id, deletedAt: null, version: 4 });

    const count = await asTenant(pool, tenantA.tenantId, async (client) => ({
      drafts: (await client.query('SELECT 1 FROM purchase_drafts')).rowCount,
      purchases: (await client.query('SELECT 1 FROM purchases')).rowCount,
      journal: (await client.query('SELECT 1 FROM journal_entries')).rowCount,
      stock: (await client.query('SELECT 1 FROM stock_movements')).rowCount,
      cash: (await client.query('SELECT 1 FROM cash_movements')).rowCount,
      payments: (await client.query('SELECT 1 FROM supplier_payments')).rowCount,
    }));
    expect(count).toEqual({ drafts: 1, purchases: 0, journal: 0, stock: 0, cash: 0, payments: 0 });
  });

  it('never leaks tenant A drafts to tenant B, even through direct RLS SQL', async () => {
    const created = await request(app.getHttpServer()).post(route).set(authed(tokenA)).send(body());
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;
    expect((await request(app.getHttpServer()).get(route).set(authed(tokenB))).body.data).toEqual([]);
    const hidden = await request(app.getHttpServer()).get(`${route}/${id}`).set(authed(tokenB));
    expect(hidden.status).toBe(404);
    expect((await request(app.getHttpServer()).put(`${route}/${id}`).set(authed(tokenB))
      .send({ ...updateBody(), expectedVersion: 1 })).status).toBe(404);
    const raw = await asTenant(pool, tenantB.tenantId, (client) => client.query('SELECT id FROM purchase_drafts'));
    expect(raw.rowCount).toBe(0);
    const real = await asTenant(pool, tenantA.tenantId, (client) => client.query('SELECT id FROM purchase_drafts'));
    expect(real.rowCount).toBe(1);
  });

  it('requires purchase and cost permission and refuses unsafe raw attachments and tenant spoofing', async () => {
    const limited = await seedTenant(pool, { name: 'No cost access', permissions: [Permission.PURCHASE_CREATE] });
    const limitedToken = signToken(limited, TEST_JWT_SECRET);
    expect((await request(app.getHttpServer()).get(route).set(authed(limitedToken))).status).toBe(403);
    expect((await request(app.getHttpServer()).post(route).set(authed(limitedToken)).send(body())).status).toBe(403);

    const inline = { ...body(), cart: { ...body().cart, photos: ['data:image/jpeg;base64,aaaa'] } };
    expect((await request(app.getHttpServer()).post(route).set(authed(tokenA)).send(inline)).status).toBe(400);
    expect((await request(app.getHttpServer()).post(route).set(authed(tokenA))
      .send({ ...body(), tenantId: tenantB.tenantId })).status).toBe(400);
  });


  it('replays the same creation operation without a second draft or financial posting', async () => {
    const original = await request(app.getHttpServer()).post(route).set(authed(tokenA)).send(body());
    expect(original.status).toBe(201);
    const retried = await request(app.getHttpServer()).post(route).set(authed(tokenA)).send(body());
    expect(retried.status).toBe(201);
    expect(retried.body.data).toEqual(original.body.data);

    // JSONB object key ordering is not an identity difference.
    const reordered = body();
    reordered.cart = {
      payments: body().cart.payments,
      lines: body().cart.lines,
      referenceNo: 'PO-TEST-7',
      date: '2026-11-13',
      photos: [],
    };
    const canonicalReplay = await request(app.getHttpServer()).post(route)
      .set(authed(tokenA)).send(reordered);
    expect(canonicalReplay.status).toBe(201);
    expect(canonicalReplay.body.data.id).toBe(original.body.data.id);

    const counted = await asTenant(pool, tenantA.tenantId, async (client) => ({
      drafts: (await client.query('SELECT 1 FROM purchase_drafts')).rowCount,
      purchases: (await client.query('SELECT 1 FROM purchases')).rowCount,
      journals: (await client.query('SELECT 1 FROM journal_entries')).rowCount,
      stock: (await client.query('SELECT 1 FROM stock_movements')).rowCount,
      cash: (await client.query('SELECT 1 FROM cash_movements')).rowCount,
      supplierPayments: (await client.query('SELECT 1 FROM supplier_payments')).rowCount,
    }));
    expect(counted).toEqual({
      drafts: 1, purchases: 0, journals: 0, stock: 0, cash: 0, supplierPayments: 0,
    });
  });

  it('serializes simultaneous same-key creates and rejects conflicting payloads', async () => {
    const concurrent = await Promise.all(Array.from({ length: 6 }, () =>
      request(app.getHttpServer()).post(route).set(authed(tokenA)).send(body())));
    expect(concurrent.every(result => result.status === 201)).toBe(true);
    const ids = concurrent.map(result => result.body.data.id as string);
    expect(new Set(ids).size).toBe(1);
    const rowCount = await asTenant(pool, tenantA.tenantId,
      async client => (await client.query('SELECT id FROM purchase_drafts')).rowCount);
    expect(rowCount).toBe(1);

    const reuse = await request(app.getHttpServer()).post(route).set(authed(tokenA))
      .send({ ...body(), label: 'Other unfinished invoice' });
    expect(reuse.status).toBe(409);
    expect(reuse.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const stillOne = await asTenant(pool, tenantA.tenantId,
      async client => (await client.query('SELECT id FROM purchase_drafts')).rowCount);
    expect(stillOne).toBe(1);
  });

  it('isolates operation keys by tenant and preserves idempotency after editing and recycling', async () => {
    const firstA = await request(app.getHttpServer()).post(route).set(authed(tokenA)).send(body());
    const firstB = await request(app.getHttpServer()).post(route).set(authed(tokenB)).send(body());
    expect(firstA.status).toBe(201);
    expect(firstB.status).toBe(201);
    expect(firstB.body.data.id).not.toBe(firstA.body.data.id);

    const updated = await request(app.getHttpServer())
      .put(route + '/' + firstA.body.data.id).set(authed(tokenA))
      .send({ ...updateBody(), label: 'Edited later', expectedVersion: 1 });
    expect(updated.status).toBe(200);
    const afterEdit = await request(app.getHttpServer()).post(route)
      .set(authed(tokenA)).send(body());
    expect(afterEdit.status).toBe(201);
    expect(afterEdit.body.data.id).toBe(firstA.body.data.id);
    expect(afterEdit.body.data.version).toBe(2);
    expect(afterEdit.body.data.label).toBe('Edited later');

    const recycle = await request(app.getHttpServer())
      .delete(route + '/' + firstA.body.data.id).set(authed(tokenA))
      .send({ expectedVersion: 2 });
    expect(recycle.status).toBe(200);
    const afterRecycle = await request(app.getHttpServer()).post(route)
      .set(authed(tokenA)).send(body());
    expect(afterRecycle.status).toBe(201);
    expect(afterRecycle.body.data.id).toBe(firstA.body.data.id);
    expect(afterRecycle.body.data.deletedAt).not.toBeNull();

    const rowsA = await asTenant(pool, tenantA.tenantId,
      async client => (await client.query(
        'SELECT create_operation_id, create_fingerprint FROM purchase_drafts')).rows);
    expect(rowsA).toHaveLength(1);
    expect(rowsA[0].create_operation_id.trim()).toBe(OPERATION_ID);
    expect(rowsA[0].create_fingerprint.trim()).toMatch(/^[a-f0-9]{64}$/);
    const rowsB = await asTenant(pool, tenantB.tenantId,
      async client => (await client.query(
        'SELECT create_operation_id FROM purchase_drafts')).rows);
    expect(rowsB).toHaveLength(1);
  });

  it('requires a valid, stable create operationId and never fabricates a draft on missing key', async () => {
    const invalid = [
      { ...body(), operationId: '' },
      { ...body(), operationId: 'preview-draft' },
      { ...body(), operationId: 'AAAAAAAAAAAAAAAAAAAAAAAAAA' },
    ];
    for (const candidate of invalid) {
      const response = await request(app.getHttpServer()).post(route).set(authed(tokenA)).send(candidate);
      expect(response.status).toBe(400);
    }
    const missing = { ...body() } as Partial<ReturnType<typeof body>>;
    delete missing.operationId;
    const response = await request(app.getHttpServer()).post(route).set(authed(tokenA)).send(missing);
    expect(response.status).toBe(400);
    const count = await asTenant(pool, tenantA.tenantId,
      async client => (await client.query('SELECT id FROM purchase_drafts')).rowCount);
    expect(count).toBe(0);
  });

  it('does not restore a draft beyond the 30-day retention window', async () => {
    const created = await request(app.getHttpServer()).post(route).set(authed(tokenA)).send(body());
    const id = created.body.data.id as string;
    const recycled = await request(app.getHttpServer()).delete(`${route}/${id}`).set(authed(tokenA))
      .send({ expectedVersion: 1 });
    expect(recycled.status).toBe(200);
    await asTenant(pool, tenantA.tenantId, (client) =>
      client.query('UPDATE purchase_drafts SET deleted_at = now() - interval \'31 days\' WHERE id = $1', [id]),
    );
    const expired = await request(app.getHttpServer()).post(`${route}/${id}/restore`)
      .set(authed(tokenA)).send({ expectedVersion: 2 });
    expect(expired.body.error.code).toBe('VALIDATION_FAILED');
    const rows = await asTenant(pool, tenantA.tenantId, (client) =>
      client.query('SELECT deleted_at FROM purchase_drafts WHERE id = $1', [id]));
    expect(rows.rows[0].deleted_at).not.toBeNull();
  });
});
