/*
 * MOD-007 M7-02B2A: RED FIRST — durable parked-cart creation identity.
 * These expectations intentionally FAIL against the legacy no-operation-key
 * Sales Draft POST. No app/schema/migration or other module files are edited.
 *
 * @covers endpoint:POST /api/v1/sales/drafts
 * @covers endpoint:DELETE /api/v1/sales/drafts/:id
 * @covers permission:sale.invoice.create
 */
import 'reflect-metadata';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Permission } from '@sher/core-contracts';
import { SystemClock, Ulid } from '@sher/shared-utils';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { AppErrorFilter } from '../src/common/app-error.filter';
import { signToken, TEST_JWT_SECRET } from './support/auth';
import type { SeededTenant } from './support/database';
import {
  asTenant, prepareTestDatabase, resetDatabase, seedTenant, testPool,
} from './support/database';
import { assertGoldenInvariants } from './support/invariants';

const path = '/api/v1/sales/drafts';
const clock = new SystemClock();
let app: INestApplication;
let pool: pg.Pool;
let tenant: SeededTenant;
let token: string;

const initialCart = () => ({
  items: [
    { productId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', unit: 'Gauge', qty: 1.5,
      unitPriceMinor: 2345, conversions: [{ from: 'Gauge', to: 'Gira', factor: 16 }],
      serials: ['SN-001'], warranty: '12 months' },
    { productId: '01ARZ3NDEKTSV4RRFFQ69G5FAW', unit: 'Box', qty: 2,
      independentPricesMinor: { Piece: 50, Box: 900, Carton: 10000 },
      bundle: { version: 3, components: [{ sku: 'WIRE', qty: 12 }] } },
  ],
  payments: [{ method: 'CASH', amountMinor: 300 }, { method: 'BANK', amountMinor: 700 }],
  installments: [{ dueDate: '2026-12-01', amountMinor: 2345 }],
  memo: 'বাংলা — নির্ভুল 🧾',
});
const payload = (override: Record<string, unknown> = {}) => ({
  label: 'হোল্ড • দোকান', customerName: 'রহিম', itemCount: 2,
  grandTotalMinor: 2345, cart: initialCart(), ...override,
});
type Response = request.Response;

function post(
  key: string | undefined,
  body: Record<string, unknown> = payload(),
  bearer = token,
): Promise<Response> {
  let http = request(app.getHttpServer()).post(path).set('Authorization', 'Bearer ' + bearer);
  if (key !== undefined) http = http.set('Idempotency-Key', key);
  return http.send(body);
}
function makeKey(): string { return Ulid.generate(clock); }
function mustCreated(response: Response): Record<string, unknown> {
  expect(response.status).toBe(201);
  expect(Object.keys(response.body.data).sort()).toEqual([
    'businessDate', 'cart', 'customerName', 'grandTotalMinor', 'id',
    'itemCount', 'label', 'savedAt',
  ]);
  return response.body.data as Record<string, unknown>;
}
async function draftCount(id = tenant.tenantId): Promise<number> {
  return asTenant(pool, id, async (client) => {
    const result = await client.query(
      'SELECT count(*)::integer AS n FROM sale_drafts WHERE tenant_id=$1', [id],
    );
    return result.rows[0].n as number;
  });
}
async function draftVersion(id: string): Promise<number | null> {
  return asTenant(pool, tenant.tenantId, async (client) => {
    const result = await client.query(
      'SELECT version FROM sale_drafts WHERE tenant_id=$1 AND id=$2',
      [tenant.tenantId, id],
    );
    return result.rows.length ? result.rows[0].version as number : null;
  });
}
const postingTables = [
  'sales', 'sale_lines', 'sale_payments', 'customer_receipts',
  'journal_entries', 'journal_lines', 'stock_movements', 'cash_movements', 'outbox',
] as const;
async function postingCounts(): Promise<Record<string, number>> {
  return asTenant(pool, tenant.tenantId, async (client) => {
    const counts: Record<string, number> = {};
    for (const table of postingTables) {
      const result = await client.query(
        'SELECT count(*)::integer AS n FROM ' + table + ' WHERE tenant_id=$1',
        [tenant.tenantId],
      );
      counts[table] = result.rows[0].n as number;
    }
    return counts;
  });
}

beforeAll(async () => {
  pool = testPool();
  await prepareTestDatabase();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.useGlobalFilters(new AppErrorFilter());
  await app.init();
});
afterAll(async () => { await app.close(); await pool.end(); });
beforeEach(async () => {
  await resetDatabase(pool);
  tenant = await seedTenant(pool, {
    name: 'M7-02B2A durable draft create', permissions: [Permission.SALE_CREATE],
  });
  token = signToken(tenant, TEST_JWT_SECRET);
});
afterEach(async () => {
  await assertGoldenInvariants(pool, tenant.tenantId);
  const counts = await postingCounts();
  expect(counts).toEqual(Object.fromEntries(postingTables.map((name) => [name, 0])));
});

describe('M7-02B2A durable sale-draft create operation — real PG16', () => {
  it('returns the same eight-key result and ONE draft after an immediate lost-201 retry', async () => {
    const key = makeKey();
    const original = mustCreated(await post(key));
    const replay = mustCreated(await post(key));
    expect(replay).toEqual(original);
    expect(await draftCount()).toBe(1);
    expect(await draftVersion(original.id as string)).toBe(1);
  });

  it('uses the same durable identity after the generic idempotency cache is pruned', async () => {
    const key = makeKey();
    const first = mustCreated(await post(key));
    await asTenant(pool, tenant.tenantId, async (client) =>
      client.query('DELETE FROM idempotency_keys WHERE tenant_id=$1', [tenant.tenantId]));
    const retried = mustCreated(await post(key));
    expect(retried).toEqual(first);
    expect(await draftCount()).toBe(1);
  });

  it('considers canonical JSON object key order equivalent, including nested items', async () => {
    const key = makeKey();
    const original = payload();
    const alternate = {
      cart: {
        memo: initialCart().memo,
        installments: initialCart().installments,
        payments: initialCart().payments,
        items: initialCart().items.map((item) => ({ ...item })),
      },
      grandTotalMinor: original.grandTotalMinor,
      itemCount: original.itemCount,
      customerName: original.customerName,
      label: original.label,
    };
    const first = mustCreated(await post(key, original));
    const second = mustCreated(await post(key, alternate));
    expect(second.id).toBe(first.id);
    expect(second.savedAt).toBe(first.savedAt);
    expect(await draftCount()).toBe(1);
  });

  it.each([
    ['label', { label: 'DIFFERENT' }],
    ['customer', { customerName: 'অন্য গ্রাহক' }],
    ['item count', { itemCount: 3 }],
    ['payment', { cart: { ...initialCart(), payments: [{ method: 'BANK', amountMinor: 2000 }] } }],
    ['serial', { cart: { ...initialCart(), items: [{ ...initialCart().items[0], serials: ['CHANGED'] }] } }],
    ['amount', { grandTotalMinor: 9999 }],
  ])('refuses reuse of the key for a changed %s without altering the first draft', async (_what, change) => {
    const key = makeKey();
    const first = mustCreated(await post(key));
    const refused = await post(key, payload(change));
    expect(refused.status).toBe(409);
    expect(await draftCount()).toBe(1);
    expect(await draftVersion(first.id as string)).toBe(1);
  });

  it('arbitrates simultaneous POSTs using one original operation identity', async () => {
    const key = makeKey();
    const both = await Promise.all([post(key), post(key)]);
    expect(both.map((r) => r.status).sort()).toEqual([201, 201]);
    expect(both[0].body.data.id).toBe(both[1].body.data.id);
    expect(await draftCount()).toBe(1);
  });

  it('never recreates a hard-deleted draft when the same creation key is replayed', async () => {
    const key = makeKey();
    const first = mustCreated(await post(key));
    const removed = await request(app.getHttpServer())
      .delete(path + '/' + first.id).set('Authorization', 'Bearer ' + token);
    expect(removed.status).toBe(204);
    expect(await draftCount()).toBe(0);
    const replay = await post(key);
    expect(replay.status).toBe(409);
    expect(await draftCount()).toBe(0);
  });

  it('replaying creation after a versioned edit never duplicates or rewinds the edited draft', async () => {
    const key = makeKey();
    const first = mustCreated(await post(key));
    const changed = await request(app.getHttpServer())
      .put(path + '/' + first.id)
      .set('Authorization', 'Bearer ' + token)
      .send({ ...payload(), expectedVersion: 1, label: 'Edited later' });
    expect(changed.status).toBe(200);
    const replay = mustCreated(await post(key));
    expect(replay).toEqual(first);
    expect(await draftCount()).toBe(1);
    expect(await draftVersion(first.id as string)).toBe(2);
  });

  it('allows the same operation key in separate tenants but not the same tenant twice', async () => {
    const key = makeKey();
    const first = mustCreated(await post(key));
    const other = await seedTenant(pool, {
      name: 'Independent legal tenant', permissions: [Permission.SALE_CREATE],
    });
    const second = mustCreated(await post(key, payload(), signToken(other, TEST_JWT_SECRET)));
    expect(second.id).not.toBe(first.id);
    expect(await draftCount()).toBe(1);
    expect(await draftCount(other.tenantId)).toBe(1);
  });

  it('retains the legacy no-header create behavior until the connected POS cutover', async () => {
    const first = mustCreated(await post(undefined));
    const second = mustCreated(await post(undefined));
    expect(second.id).not.toBe(first.id);
    expect(await draftCount()).toBe(2);
  });

  it.each([
    ['', 'empty header'],
    ['bad', 'too short'],
    ['Z'.repeat(26), 'invalid Crockford alphabet'],
  ])('rejects invalid opt-in operation key: %s (%s)', async (key) => {
    const refused = await post(key);
    expect(refused.status).toBe(400);
    expect(await draftCount()).toBe(0);
  });

  it('checks permissions BEFORE replay and never reveals another tenant draft', async () => {
    const key = makeKey();
    const first = mustCreated(await post(key));
    const denied = await seedTenant(pool, { name: 'No sale create', permissions: [] });
    expect((await post(key, payload(), signToken(denied, TEST_JWT_SECRET))).status).toBe(403);
    expect((await post(key, payload(), 'invalid-token')).status).toBe(401);
    expect((await request(app.getHttpServer()).post(path).set('Idempotency-Key', key).send(payload())).status).toBe(401);
    expect(await draftCount()).toBe(1);
    expect(await draftVersion(first.id as string)).toBe(1);
  });

  it('round trips Bangla, split payments, bundles, serials and unit prices without recalculation', async () => {
    const key = makeKey();
    const input = payload({ itemCount: 500 });
    const first = mustCreated(await post(key, input));
    const replay = mustCreated(await post(key, input));
    expect(first.cart).toEqual(input.cart);
    expect(replay).toEqual(first);
    expect(first.itemCount).toBe(500);
    expect(first.grandTotalMinor).toBe(2345);
    expect(await draftCount()).toBe(1);
  });

  it('rejects unsafe money values in idempotent draft creation without persisting', async () => {
    const refused = await post(makeKey(), payload({ grandTotalMinor: Number.MAX_SAFE_INTEGER + 1 }));
    expect(refused.status).toBe(400);
    expect(await draftCount()).toBe(0);
  });

  it('rejects oversized JSON without a 500 or a draft', async () => {
    const refused = await post(makeKey(), payload({ cart: { blob: 'বাংলা'.repeat(100_000) } }));
    expect(refused.status).toBe(413);
    expect(await draftCount()).toBe(0);
  });

  it('retains a PII-free creation tombstone after hard delete and hides other tenants', async () => {
    const key = makeKey();
    const first = mustCreated(await post(key));
    const source = await asTenant(pool, tenant.tenantId, async (client) => {
      const result = await client.query(
        'SELECT operation_id, fingerprint_version, request_fingerprint, draft_id, ' +
        'business_date, saved_at, created_at, created_by ' +
        'FROM sale_draft_create_operations WHERE tenant_id=$1 AND operation_id=$2',
        [tenant.tenantId, key],
      );
      return result.rows;
    });
    expect(source).toHaveLength(1);
    expect(source[0].operation_id.trim()).toBe(key);
    expect(source[0].draft_id.trim()).toBe(first.id);
    expect(source[0].fingerprint_version).toBe('sale.draft.create/v1');
    expect(source[0].request_fingerprint.trim()).toMatch(/^[0-9a-f]{64}$/);
    expect(source[0].saved_at.toISOString()).toBe(first.savedAt);
    // Only source identity and actor, not the original cart/customer PII.
    expect(Object.keys(source[0]).sort()).toEqual([
      'business_date', 'created_at', 'created_by', 'draft_id',
      'fingerprint_version', 'operation_id', 'request_fingerprint', 'saved_at',
    ]);
    const other = await seedTenant(pool, { name: 'Tombstone RLS isolated', permissions: [] });
    const unseen = await asTenant(pool, other.tenantId, async (client) =>
      (await client.query(
        'SELECT operation_id FROM sale_draft_create_operations WHERE operation_id=$1', [key],
      )).rows);
    expect(unseen).toEqual([]);

    const deleted = await request(app.getHttpServer())
      .delete(path + '/' + first.id).set('Authorization', 'Bearer ' + token);
    expect(deleted.status).toBe(204);
    expect(await draftCount()).toBe(0);
    const remains = await asTenant(pool, tenant.tenantId, async (client) =>
      (await client.query(
        'SELECT count(*)::integer AS n FROM sale_draft_create_operations ' +
        'WHERE tenant_id=$1 AND operation_id=$2', [tenant.tenantId, key],
      )).rows[0].n as number);
    expect(remains).toBe(1);
    expect((await post(key)).status).toBe(409);
  });

  it('arbitrates a same-key race across two independently bootstrapped Nest apps', async () => {
    const moduleTwo = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const secondApp = moduleTwo.createNestApplication();
    secondApp.useGlobalFilters(new AppErrorFilter());
    await secondApp.init();
    try {
      const key = makeKey();
      const [left, right] = await Promise.all([
        post(key),
        request(secondApp.getHttpServer()).post(path)
          .set('Authorization', 'Bearer ' + token)
          .set('Idempotency-Key', key).send(payload()),
      ]);
      expect([left.status, right.status]).toEqual([201, 201]);
      expect(left.body.data).toEqual(right.body.data);
      expect(await draftCount()).toBe(1);
    } finally {
      await secondApp.close();
    }
  });
});
