/*
 * M7-02B1 — red-first, real PostgreSQL 16 versioned parked-cart contract.
 *
 * @covers endpoint:GET /api/v1/sales/drafts
 * @covers endpoint:POST /api/v1/sales/drafts
 * @covers endpoint:GET /api/v1/sales/drafts/:id
 * @covers endpoint:PUT /api/v1/sales/drafts/:id
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

const clock = new SystemClock();
const path = '/api/v1/sales/drafts';
let app: INestApplication;
let pool: pg.Pool;
let tenant: SeededTenant;
let token: string;

type HttpResponse = request.Response;
const api = (): ReturnType<typeof request> => request(app.getHttpServer());
const authorized = (test: request.Test, bearer = token): request.Test =>
  test.set('Authorization', `Bearer ${bearer}`);

const cart = {
  items: [
    { productId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', unit: 'Gauge', qty: 1.5, unitPriceMinor: 2345,
      conversions: [{ from: 'Gauge', to: 'Gira', factor: 16 }], serials: ['SN-001'], warranty: '12 months' },
    { productId: '01ARZ3NDEKTSV4RRFFQ69G5FAW', unit: 'Box', qty: 2,
      independentPricesMinor: { Piece: 50, Box: 900, Carton: 10000 },
      bundle: { version: 3, components: [{ sku: 'WIRE', qty: 12 }] } },
  ],
  payments: [{ method: 'CASH', amountMinor: 300 }, { method: 'BANK', amountMinor: 700 }],
  installments: [{ dueDate: '2026-12-01', amountMinor: 2345 }],
  memo: 'বাংলা — নির্ভুল 🧾',
};
const payload = (override: Record<string, unknown> = {}) => ({
  label: 'হোল্ড • দোকান', customerName: null, itemCount: 2, grandTotalMinor: 2345,
  cart, ...override,
});
const replacement = (expectedVersion: number, override: Record<string, unknown> = {}) =>
  ({ ...payload({ label: 'পরিবর্তিত • Draft', customerName: 'রহিম', itemCount: 3 }), expectedVersion, ...override });

function must(response: HttpResponse, description: string): HttpResponse {
  if (response.status >= 400) throw new Error(`${description}: ${response.status} ${JSON.stringify(response.body)}`);
  return response;
}

async function newDraft(overrides: Record<string, unknown> = {}): Promise<string> {
  const posted = must(await authorized(api().post(path)).send(payload(overrides)), 'create draft');
  expect(posted.status).toBe(201);
  return posted.body.data.id as string;
}

async function originalRow(id: string): Promise<{
  id: string; version: number; savedAt: Date; updatedAt: Date;
  updatedBy: string; businessDate: string; cart: unknown; label: string;
}> {
  return asTenant(pool, tenant.tenantId, async (client) => {
    const { rows } = await client.query(
      'SELECT id, version, created_at AS "savedAt", updated_at AS "updatedAt", updated_by AS "updatedBy", business_date AS "businessDate", cart, label FROM sale_drafts WHERE tenant_id=$1 AND id=$2',
      [tenant.tenantId, id],
    );
    return rows[0] as {
      id: string; version: number; savedAt: Date; updatedAt: Date;
      updatedBy: string; businessDate: string; cart: unknown; label: string;
    };
  });
}

async function nonDraftEffects(): Promise<Record<string, number>> {
  return asTenant(pool, tenant.tenantId, async (client) => {
    const tables = [
      'sales', 'sale_lines', 'sale_payments', 'customer_receipts',
      'journal_entries', 'journal_lines', 'stock_movements',
      'money_movements', 'outbox_events',
    ];
    const counts: Record<string, number> = {};
    for (const table of tables) {
      // Static trusted table literals above; scoped with the actual RLS role.
      const result = await client.query(`SELECT count(*)::integer AS n FROM ${table} WHERE tenant_id=$1`, [tenant.tenantId]);
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
  tenant = await seedTenant(pool, { name: 'M7 B1 Drafts', permissions: [Permission.SALE_CREATE] });
  token = signToken(tenant, TEST_JWT_SECRET);
});
afterEach(async () => { await assertGoldenInvariants(pool, tenant.tenantId); });

describe('M7-02B1 versioned parked sale drafts — PG16', () => {
  it('preserves the exact eight-key list while detail exposes updatedAt/version and nested data', async () => {
    const id = await newDraft();
    const list = must(await authorized(api().get(path)), 'list drafts');
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(Object.keys(list.body.data[0]).sort()).toEqual([
      'businessDate', 'cart', 'customerName', 'grandTotalMinor', 'id',
      'itemCount', 'label', 'savedAt',
    ]);
    expect(list.body.data[0].cart).toEqual(cart);
    const detail = must(await authorized(api().get(`${path}/${id}`)), 'draft detail');
    expect(detail.status).toBe(200);
    expect(detail.body.data).toMatchObject({
      id, version: 1, label: payload().label, customerName: null,
      itemCount: 2, grandTotalMinor: 2345, cart,
    });
    expect(Date.parse(detail.body.data.updatedAt)).not.toBeNaN();
    expect(detail.body.data.savedAt).toBe(list.body.data[0].savedAt);
  });

  it('replaces draft atomically using same ID, preserves creation date and nested JSON, and increments twice', async () => {
    const id = await newDraft();
    const original = await originalRow(id);
    expect(original.version).toBe(1);
    const baseline = await nonDraftEffects();
    const first = must(await authorized(api().put(`${path}/${id}`)).send(replacement(1)), 'edit v1');
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ id, version: 2, ...payload({label:'পরিবর্তিত • Draft', customerName:'রহিম',itemCount:3}) });
    expect(first.body.data.savedAt).toBe(original.savedAt.toISOString());
    expect(first.body.data.businessDate).toBe(original.businessDate);
    const persisted = await originalRow(id);
    expect(persisted.id.trim()).toBe(id);
    expect(persisted.version).toBe(2);
    expect(persisted.updatedBy.trim()).toBe(tenant.userId);
    expect(persisted.updatedAt.getTime()).toBeGreaterThanOrEqual(original.updatedAt.getTime());
    expect(persisted.savedAt).toEqual(original.savedAt);
    expect(persisted.cart).toEqual(cart);

    const nextCart = { ...cart, items: [{ unit: 'Feet', qty: 2.25, unitPriceMinor: 999 }] };
    const second = must(await authorized(api().put(`${path}/${id}`)).send(replacement(2, { cart: nextCart })), 'edit v2');
    expect(second.body.data).toMatchObject({ id, version: 3, cart: nextCart });
    expect((await originalRow(id)).version).toBe(3);
    expect(await nonDraftEffects()).toEqual(baseline);
    const count = await asTenant(pool, tenant.tenantId, async (client) =>
      (await client.query('SELECT count(*)::integer AS n FROM sale_drafts WHERE tenant_id=$1', [tenant.tenantId])).rows[0].n as number);
    expect(count).toBe(1);
  });

  it('returns deterministic 409 on stale edit without changing any field', async () => {
    const id = await newDraft();
    must(await authorized(api().put(`${path}/${id}`)).send(replacement(1)), 'first edit');
    const before = await originalRow(id);
    const refused = await authorized(api().put(`${path}/${id}`)).send(replacement(1, { label: 'should never write' }));
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('CONFLICT_STALE_VERSION');
    expect(await originalRow(id)).toEqual(before);
  });

  it('resolves simultaneous same-version PUTs with exactly one update and one 409', async () => {
    const id = await newDraft();
    const responses = await Promise.all([
      authorized(api().put(`${path}/${id}`)).send(replacement(1, { label: 'actor A' })),
      authorized(api().put(`${path}/${id}`)).send(replacement(1, { label: 'actor B' })),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const row = await originalRow(id);
    expect(row.version).toBe(2);
    expect(['actor A', 'actor B']).toContain(row.label);
  });

  it('returns 404 for missing, malformed, and other-tenant draft IDs', async () => {
    const id = await newDraft();
    const other = await seedTenant(pool, { name: 'Other tenant', permissions: [Permission.SALE_CREATE] });
    const otherToken = signToken(other, TEST_JWT_SECRET);
    for (const target of [Ulid.generate(clock), 'not-a-valid-id', 'Z'.repeat(26)]) {
      const fetched = await authorized(api().get(`${path}/${target}`)).send();
      expect(fetched.status).toBe(404);
    }
    expect((await authorized(api().get(`${path}/${id}`), otherToken)).status).toBe(404);
    const refused = await authorized(api().put(`${path}/${id}`), otherToken).send(replacement(1));
    expect(refused.status).toBe(404);
    expect((await originalRow(id)).version).toBe(1);
  });

  it('checks sale.invoice.create for detail and mutation, including denied users', async () => {
    const id = await newDraft();
    const other = await seedTenant(pool, { name: 'No sell permission', permissions: [] });
    const deniedToken = signToken(other, TEST_JWT_SECRET);
    expect((await authorized(api().get(path), deniedToken)).status).toBe(403);
    expect((await authorized(api().get(`${path}/${id}`), deniedToken)).status).toBe(403);
    expect((await authorized(api().put(`${path}/${id}`), deniedToken).send(replacement(1))).status).toBe(403);
    expect((await api().get(`${path}/${id}`)).status).toBe(401);
    expect((await api().put(`${path}/${id}`).send(replacement(1))).status).toBe(401);
  });

  it.each([
    ['missing expectedVersion', { expectedVersion: undefined }],
    ['negative version', { expectedVersion: -1 }],
    ['zero version', { expectedVersion: 0 }],
    ['fractional version', { expectedVersion: 1.5 }],
    ['version over int4', { expectedVersion: 2_147_483_648 }],
    ['string version', { expectedVersion: '1' }],
    ['negative total', { grandTotalMinor: -5 }],
    ['fractional total', { grandTotalMinor: 5.25 }],
    ['unsafe amount', { grandTotalMinor: Number.MAX_SAFE_INTEGER + 1 }],
    ['itemCount negative', { itemCount: -1 }],
    ['itemCount over 500', { itemCount: 501 }],
    ['itemCount fractional', { itemCount: 1.25 }],
    ['empty label', { label: ' ' }],
    ['long Bangla label', { label: 'বাংলা'.repeat(45) }],
    ['long customer', { customerName: 'x'.repeat(121) }],
    ['nonobject cart', { cart: [1, 2, 3] }],
    ['null cart', { cart: null }],
    ['extraneous field', { operationId: 'forbidden' }],
  ])('rejects invalid update: %s without mutation', async (_name, changed) => {
    const id = await newDraft();
    const before = await originalRow(id);
    const invalid = replacement(1, changed);
    const refused = await authorized(api().put(`${path}/${id}`)).send(invalid);
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('VALIDATION_FAILED');
    expect(await originalRow(id)).toEqual(before);
  });

  it('accepts empty and 500-item metadata boundaries, empty cart, and UTF-8 labels', async () => {
    const id = await newDraft({ itemCount: 0, cart: {} });
    const a = must(await authorized(api().put(`${path}/${id}`)).send(replacement(1, { itemCount: 500, cart: {}, label: 'বাংলা ✅' })), '500 items');
    expect(a.body.data).toMatchObject({ id, version: 2, itemCount: 500, cart: {}, label: 'বাংলা ✅' });
    const b = must(await authorized(api().put(`${path}/${id}`)).send(replacement(2, { itemCount: 0 })), '0 items');
    expect(b.body.data.itemCount).toBe(0);
  });

  it('rejects oversized JSON request without internal error or record mutation', async () => {
    const id = await newDraft();
    const before = await originalRow(id);
    const refused = await authorized(api().put(`${path}/${id}`)).send(replacement(1, { cart: { blob: 'x'.repeat(250_000) } }));
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.status).toBeLessThan(500);
    expect(await originalRow(id)).toEqual(before);
  });
});
