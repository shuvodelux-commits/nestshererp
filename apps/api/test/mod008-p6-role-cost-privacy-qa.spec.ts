/*
 * MOD-008 P6 QA-only: signed same-tenant nonowner purchase privacy and RBAC.
 *
 * @covers endpoint:GET /api/v1/purchases
 * @covers endpoint:GET /api/v1/purchases/:id
 * @covers endpoint:POST /api/v1/purchases
 * @covers permission:purchase.bill.create
 * @covers permission:purchase.bill.view
 * @covers permission:inventory.cost.view
 *
 * Opt-in ONLY on dedicated labelled disposable PostgreSQL16 port 55683.
 * This suite proves current single-payment API authorization; it does not
 * activate initial purchase paymentLegs or relax production RLS privileges.
 */
import 'reflect-metadata';

import { spawnSync } from 'node:child_process';
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
import {
  asTenant, prepareTestDatabase, resetDatabase, seedTenant, testPool,
} from './support/database';

const clock = new SystemClock();
const ACK = 'isolated-pg16-role-535';
const URL = 'postgres://sher_app:sher_app_test@127.0.0.1:55683/sher_test';
const ADMIN_URL = 'postgres://postgres:dev@127.0.0.1:55683/sher_test';
const PERMISSIONS = [
  Permission.PURCHASE_CREATE, Permission.PURCHASE_EDIT, Permission.PURCHASE_VIEW,
  Permission.PRODUCT_VIEW, Permission.PRODUCT_CREATE, Permission.PRODUCT_EDIT,
  Permission.PRODUCT_DEACTIVATE, Permission.UNIT_MANAGE,
  Permission.SUPPLIER_VIEW, Permission.SUPPLIER_CREATE, Permission.COST_VIEW,
];
const HEADER_KEYS = ['grandTotalMinor', 'itemsTotalMinor', 'paidMinor',
  'dueMinor', 'discountMinor', 'extraCostMinor', 'landedCosts',
  'paidAccountCode', 'paidAccountName', 'payments'] as const;
const LINE_KEYS = ['unitPriceMinor', 'lineTotalMinor', 'discountShareMinor',
  'extraCostShareMinor', 'actualUnitCost'] as const;
let app: INestApplication;
let pool: pg.Pool;
let tenant: SeededTenant;
let ownerToken: string;
let viewerToken: string;
let noViewToken: string;
let supplierId: string;
let productId: string;
let purchaseId: string;

function assertIsolated(): void {
  const expected = {
    DATABASE_URL: URL, ADMIN_DATABASE_URL: ADMIN_URL,
    JWT_SECRET: TEST_JWT_SECRET, HISABIQ_P6_ROLE_QA_ACK: ACK,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (process.env[key] !== value) {
      throw new Error('P6 role test database/secret guard failed: ' + key);
    }
  }
  const verified = spawnSync('podman', [
    'inspect', '--format',
    '{{index .Config.Labels "hisabiq.qa"}}|{{index .Config.Labels "hisabiq.owner"}}|{{.State.Running}}',
    'hisabiq-mod008-p6-role-pg16',
  ], { encoding: 'utf8' });
  if (verified.status !== 0 ||
      verified.stdout.trim() !== 'mod008-p6-role-535|mod008-p6-roleqa-20261115|true') {
    throw new Error('P6 role test disposable PostgreSQL16 label/running guard failed');
  }
}

const api = () => request(app.getHttpServer());
const bearer = (token: string) => ({ Authorization: 'Bearer ' + token });
const post = (path: string, payload: object, token: string) =>
  api().post(path).set(bearer(token))
    .set('Idempotency-Key', Ulid.generate(clock)).send(payload);
const bill = (changes: Record<string, unknown> = {}) => ({
  supplierPartyId: supplierId,
  lines: [{ productId, qty: 1_000, unitPriceMinor: 10_000 }],
  discountMinor: 0, paidMinor: 0, paidAccountCode: null, ...changes,
});

async function roleToken(roleCode: string, permissions: readonly string[]): Promise<string> {
  const roleId = Ulid.generate(clock);
  const userId = Ulid.generate(clock);
  const now = clock.now();
  await asTenant(pool, tenant.tenantId, async db => {
    await db.query(
      'INSERT INTO roles (id, tenant_id, code, name, is_system, created_at, updated_at, created_by, updated_by, version) ' +
      'VALUES ($1, $2, $3, $4, FALSE, $5, $5, $6, $6, 1)',
      [roleId, tenant.tenantId, roleCode, roleCode, now, tenant.userId],
    );
    await db.query(
      'INSERT INTO users (id, tenant_id, role_id, email, display_name, created_at, updated_at, created_by, updated_by, version) ' +
      'VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $7, 1)',
      [userId, tenant.tenantId, roleId, 'role-' + userId + '@p6.example.test',
        roleCode, now, tenant.userId],
    );
    for (const permission of permissions) {
      await db.query(
        'INSERT INTO role_permissions (id, tenant_id, role_id, permission_code, created_at, updated_at, created_by, updated_by, version) ' +
        'VALUES ($1, $2, $3, $4, $5, $5, $6, $6, 1)',
        [Ulid.generate(clock), tenant.tenantId, roleId, permission, now, tenant.userId],
      );
    }
  });
  return signToken({ ...tenant, roleId, userId }, TEST_JWT_SECRET);
}

async function financialSnapshot() {
  return asTenant(pool, tenant.tenantId, async db => {
    const result = await db.query<{
      purchases: number; purchaseLines: number; journals: number;
      journalLines: number; stocks: number; lots: number;
      supplierPayments: number; audits: number; outbox: number;
    }>('SELECT ' +
      '(SELECT count(*)::int FROM purchases) AS purchases, ' +
      '(SELECT count(*)::int FROM purchase_lines) AS "purchaseLines", ' +
      '(SELECT count(*)::int FROM journal_entries) AS journals, ' +
      '(SELECT count(*)::int FROM journal_lines) AS "journalLines", ' +
      '(SELECT count(*)::int FROM stock_movements) AS stocks, ' +
      '(SELECT count(*)::int FROM inventory_lots) AS lots, ' +
      '(SELECT count(*)::int FROM supplier_payments) AS "supplierPayments", ' +
      '(SELECT count(*)::int FROM audit_events) AS audits, ' +
      '(SELECT count(*)::int FROM outbox) AS outbox');
    return result.rows[0];
  });
}

const roleSuite = process.env.HISABIQ_P6_ROLE_QA_ACK === ACK ? describe : describe.skip;
roleSuite('MOD-008 P6 signed nonowner purchase cost privacy', () => {
  beforeAll(async () => {
    assertIsolated();
    pool = testPool();
    await prepareTestDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AppErrorFilter());
    await app.init();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    tenant = await seedTenant(pool, {
      name: 'P6 isolated role shop', permissions: PERMISSIONS,
    });
    ownerToken = signToken(tenant, TEST_JWT_SECRET);

    const units = await post('/api/v1/catalog/units', { name: 'Piece' }, ownerToken);
    expect(units.status, JSON.stringify(units.body)).toBe(201);
    const unitId = units.body.data.units[0].id as string;
    const product = await post('/api/v1/products', {
      name: 'P6 Role Stock Item', baseUnitId: unitId,
      purchasePriceMinor: 10_000, sellingPriceMinor: 12_000, minStockQty: 0,
      brandId: null, categoryId: null, sku: null, barcode: null,
      description: null, defaultDiscountType: null, defaultDiscountValue: null,
      offerEnabled: false, offerPriceMinor: null,
      offerStartDate: null, offerEndDate: null,
      tracksExpiry: false, tracksSerial: false,
      conversionUnitId: null, conversionFactorQty: null,
    }, ownerToken);
    expect(product.status, JSON.stringify(product.body)).toBe(201);
    productId = product.body.data.id as string;

    const supplier = await post('/api/v1/parties', {
      name: 'P6 Role Supplier', roles: ['SUPPLIER'], phone: null, address: null,
      guardianName: null, nid: null, email: null, notes: null,
      customerGroupId: null, creditLimitMinor: null,
    }, ownerToken);
    expect(supplier.status, JSON.stringify(supplier.body)).toBe(201);
    supplierId = supplier.body.data.id as string;

    const posted = await post('/api/v1/purchases', bill(), ownerToken);
    expect(posted.status, JSON.stringify(posted.body)).toBe(201);
    expect(posted.body.data.grandTotalMinor).toBe(10_000);
    purchaseId = posted.body.data.id as string;

    viewerToken = await roleToken('P6_VIEW_ONLY', [Permission.PURCHASE_VIEW]);
    noViewToken = await roleToken('P6_NO_VIEW', []);
  }, 60_000);

  it('returns supplier and quantities but omits every money field for same-tenant VIEW-only user', async () => {
    const list = await api().get('/api/v1/purchases').set(bearer(viewerToken));
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.data).toHaveLength(1);
    const summary = list.body.summary as Record<string, unknown>;
    expect(summary.purchaseCount).toBe(1);
    for (const key of ['periodTotalMinor', 'unpaidTotalMinor', 'overdueTotalMinor']) {
      expect(summary).not.toHaveProperty(key);
    }
    const entry = list.body.data[0] as Record<string, unknown>;
    expect(entry.id).toBe(purchaseId);
    expect(entry.supplierPartyId).toBe(supplierId);
    for (const key of ['grandTotalMinor', 'paidMinor', 'dueMinor']) {
      expect(entry).not.toHaveProperty(key);
    }
    const detail = await api().get('/api/v1/purchases/' + purchaseId)
      .set(bearer(viewerToken));
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    const body = detail.body.data as Record<string, unknown>;
    expect(body.id).toBe(purchaseId);
    expect(body.supplierPartyId).toBe(supplierId);
    for (const key of HEADER_KEYS) expect(body).not.toHaveProperty(key);
    const lines = body.lines as Array<Record<string, unknown>>;
    expect(lines).toHaveLength(1);
    expect(lines[0]?.productId).toBe(productId);
    expect(lines[0]?.qty).toBe(1_000);
    for (const key of LINE_KEYS) expect(lines[0]).not.toHaveProperty(key);
  }, 35_000);

  it('rejects view-only create and correction with all financial, audit and outbox rows unchanged', async () => {
    const before = await financialSnapshot();
    expect(before.purchases).toBe(1);
    expect(before.journals).toBe(1);
    const create = await post('/api/v1/purchases', bill(), viewerToken);
    expect(create.status, JSON.stringify(create.body)).toBe(403);
    expect(await financialSnapshot()).toEqual(before);

    const correction = await post('/api/v1/purchases',
      bill({ correctionOf: purchaseId }), viewerToken);
    expect(correction.status, JSON.stringify(correction.body)).toBe(403);
    expect(await financialSnapshot()).toEqual(before);
    const ownerDetail = await api().get('/api/v1/purchases/' + purchaseId)
      .set(bearer(ownerToken));
    expect(ownerDetail.status).toBe(200);
    expect(ownerDetail.body.data.status).toBe('POSTED');
    expect(ownerDetail.body.data.grandTotalMinor).toBe(10_000);
  }, 35_000);

  it('refuses list/detail without PURCHASE_VIEW, independently of a valid signed token', async () => {
    const deniedList = await api().get('/api/v1/purchases').set(bearer(noViewToken));
    expect(deniedList.status, JSON.stringify(deniedList.body)).toBe(403);
    const deniedDetail = await api().get('/api/v1/purchases/' + purchaseId)
      .set(bearer(noViewToken));
    expect(deniedDetail.status, JSON.stringify(deniedDetail.body)).toBe(403);
  }, 35_000);
});
