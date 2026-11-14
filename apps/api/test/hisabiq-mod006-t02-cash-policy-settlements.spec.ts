/*
 * MOD-006 T02 Super Build — RED-first cash-session ON/OFF settlement tests.
 * Actual signed Nest API and isolated PostgreSQL16, never a retained shop DB.
 * Source owner for payment-account resolver is backend issue #15: TESTS ONLY.
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
  asTenant, prepareTestDatabase, resetDatabase, seedTenant, testPool, todayIn,
} from './support/database';
import { assertGoldenInvariants } from './support/invariants';

const clock = new SystemClock();
const database = 'hisabiq_mod006_t02_settlement_20261113';
const port = '55742';
const sentinel = 'MOD006_T02_PAYMENT_DISPOSABLE_ONLY_20261113';
const suite = process.env['MOD006_T02_TEST_ONLY'] === sentinel ? describe : describe.skip;
let app: INestApplication;
let pool: pg.Pool;
let tenant: SeededTenant;
let token: string;
let day: string;
let drawer: string;
let bank: string;
let categoryId: string;
let categoryCode: string;
const api = (): ReturnType<typeof request> => request(app.getHttpServer());
const signed = (r: request.Test): request.Test =>
  r.set('Authorization', 'Bearer ' + token).set('Idempotency-Key', Ulid.generate(clock));
const id = (): string => Ulid.generate(clock);

function requireDisposable(): void {
  if (process.env['MOD006_T02_TEST_ONLY'] !== sentinel) throw new Error('Opt-in T02 only');
  for (const key of ['DATABASE_URL', 'TEST_DATABASE_URL', 'ADMIN_DATABASE_URL']) {
    const raw = process.env[key];
    if (!raw) throw new Error('Missing explicit T02 database URL: ' + key);
    const uri = new URL(raw);
    if (uri.protocol !== 'postgres:' || uri.hostname !== '127.0.0.1' ||
        uri.port !== port || uri.pathname !== '/' + database ||
        uri.username !== (key === 'ADMIN_DATABASE_URL' ? 'postgres' : 'sher_app')) {
      throw new Error('T02 refuses a non-dedicated database, host, port or role');
    }
  }
}
function ok(r: request.Response, label: string): request.Response {
  expect(r.status, label + ': ' + JSON.stringify(r.body)).toBe(201);
  return r;
}
const expense = (accountCode: string, amountMinor: number): request.Test =>
  signed(api().post('/api/v1/expenses')).send({
    categoryId, amountMinor, accountCode, payeePartyId: null, note: 'T02 rent',
  });
const toggle = (value: 'on' | 'off'): request.Test =>
  signed(api().post('/api/v1/settings/value')).send({ key: 'cash_session_enabled', value });
async function startDay(): Promise<string> {
  return ok(await signed(api().post('/api/v1/money/day/start')).send({
    businessDate: day, openingAmountMinor: 100_000,
    counterpartAccountCode: null, note: null, operationId: id(),
  }), 'start day').body.data.id as string;
}
async function snapshot(): Promise<{
  totals: Record<string, number>; entries: number; expenses: number;
  suppliers: number; purchases: number; sessions: number; audit: number;
}> {
  return asTenant(pool, tenant.tenantId, async (db) => {
    const j = await db.query<{ account_code: string; net: string }>(
      'SELECT account_code, SUM(amount_minor)::bigint AS net FROM journal_lines GROUP BY account_code',
    );
    const n = await db.query<{
      entries: number; expenses: number; suppliers: number; purchases: number;
      sessions: number; audit: number;
    }>(
      'SELECT (SELECT COUNT(*)::int FROM journal_entries) AS entries, ' +
      '(SELECT COUNT(*)::int FROM expenses) AS expenses, ' +
      '(SELECT COUNT(*)::int FROM supplier_payments) AS suppliers, ' +
      '(SELECT COUNT(*)::int FROM purchases) AS purchases, ' +
      '(SELECT COUNT(*)::int FROM cash_sessions) AS sessions, ' +
      '(SELECT COUNT(*)::int FROM audit_events) AS audit',
    );
    return {
      totals: Object.fromEntries(j.rows.map(r => [r.account_code, Number(r.net)])),
      ...n.rows[0]!,
    };
  });
}
async function productAndSupplier(): Promise<{ productId: string; supplierId: string }> {
  const unit = ok(await signed(api().post('/api/v1/catalog/units'))
    .send({ name: 'Piece' }), 'unit');
  const product = ok(await signed(api().post('/api/v1/products')).send({
    name: 'Test fasteners', baseUnitId: unit.body.data.units[0].id as string,
    purchasePriceMinor: 10_000, sellingPriceMinor: 12_000, minStockQty: 0,
    brandId: null, categoryId: null, sku: null, barcode: null, description: null,
    defaultDiscountType: null, defaultDiscountValue: null, offerEnabled: false,
    offerPriceMinor: null, offerStartDate: null, offerEndDate: null,
    tracksExpiry: false, tracksSerial: false, conversionUnitId: null, conversionFactorQty: null,
  }), 'product');
  const supplier = ok(await signed(api().post('/api/v1/parties')).send({
    name: 'Supplier under test', roles: ['SUPPLIER'], phone: '01812345679',
    address: null, guardianName: null, nid: null, email: null, notes: null,
    customerGroupId: null, creditLimitMinor: null,
  }), 'supplier');
  return { productId: product.body.data.id as string, supplierId: supplier.body.data.id as string };
}
function purchase(supplierPartyId: string, productId: string,
  paidMinor: number, paidAccountCode: string | null): request.Test {
  return signed(api().post('/api/v1/purchases')).send({
    supplierPartyId, lines: [{ productId, qty: 10_000, unitPriceMinor: 10_000 }],
    discountMinor: 0, paidMinor, paidAccountCode,
  });
}

suite('MOD-006 T02: drawer session policy on real financial settlements', () => {
  beforeAll(async () => {
    requireDisposable(); // BEFORE migrations, reset or any transactional writes.
    pool = testPool();
    await prepareTestDatabase();
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalFilters(new AppErrorFilter());
    await app.init();
  }, 60_000);
  afterAll(async () => { await app?.close(); await pool?.end(); });
  beforeEach(async () => {
    await resetDatabase(pool);
    tenant = await seedTenant(pool, {
      name: 'T02 synthetic payment shop', permissions: [
        Permission.CASH_ACCOUNT_VIEW, Permission.CASH_ACCOUNT_MANAGE,
        Permission.BANK_ACCOUNT_VIEW, Permission.BANK_ACCOUNT_MANAGE,
        Permission.CASH_SESSION_START, Permission.CASH_SESSION_CLOSE,
        Permission.CASH_DAILY_VIEW, Permission.EXPENSE_RECORD, Permission.EXPENSE_VIEW,
        Permission.PURCHASE_CREATE, Permission.PURCHASE_VIEW, Permission.PURCHASE_PAY,
        Permission.CUSTOMER_VIEW, Permission.CUSTOMER_CREATE,
        Permission.SALE_RECEIVE_PAYMENT,
        Permission.PRODUCT_VIEW, Permission.PRODUCT_CREATE, Permission.PRODUCT_EDIT,
        Permission.UNIT_MANAGE, Permission.SUPPLIER_VIEW, Permission.SUPPLIER_CREATE,
        Permission.COST_VIEW, Permission.INVENTORY_LOT_VIEW,
        Permission.SETTING_TOGGLE,
      ],
    });
    token = signToken(tenant, TEST_JWT_SECRET);
    day = todayIn(tenant.timezone);
    const cash = ok(await signed(api().post('/api/v1/money/accounts')).send({
      name: 'Counted till', type: 'CASH', holderName: null, reference: null, isDrawer: true,
      openingAmountMinor: 100_000, openingDate: '2026-01-01', operationId: id(),
    }), 'cash');
    drawer = 'CASH:' + cash.body.data.id;
    const bankRow = ok(await signed(api().post('/api/v1/money/accounts')).send({
      name: 'Settlement bank', type: 'BANK', holderName: null, reference: null, isDrawer: false,
      openingAmountMinor: 50_000, openingDate: '2026-01-01', operationId: id(),
    }), 'bank');
    bank = 'BANK:' + bankRow.body.data.id;
    const cat = ok(await signed(api().post('/api/v1/expenses/categories'))
      .send({ name: 'Rent' }), 'expense category');
    categoryId = cat.body.data.id as string;
    categoryCode = cat.body.data.code as string;
  });
  afterEach(async () => {
    if (tenant?.tenantId) await assertGoldenInvariants(pool, tenant.tenantId);
  });

  it('ON: blocks an unopened drawer expense without posting', async () => {
    const before = await snapshot();
    const r = await expense(drawer, 1_000);
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(r.body.error?.details?.reason ?? r.body.error?.reason).toBe('CASH_DAY_NOT_STARTED');
    expect(await snapshot()).toEqual(before);
  });

  it('OFF drawer rent posts balanced expense without starting a cash day', async () => {
    ok(await toggle('off'), 'set cash sessions OFF');
    const before = await snapshot();
    const r = await expense(drawer, 2_000);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const after = await snapshot();
    expect(after.totals[drawer]).toBe(98_000);
    expect(after.totals['EXPENSE:' + categoryCode]).toBe(2_000);
    expect(after.entries).toBe(before.entries + 1);
    expect(after.expenses).toBe(before.expenses + 1);
    expect(after.sessions).toBe(0);
    const rows = await asTenant(pool, tenant.tenantId, db =>
      db.query<{ session_id: string | null }>('SELECT session_id FROM expenses'));
    expect(rows.rows).toEqual([{ session_id: null }]);
  });

  it('ON: bank expense is session-independent even when the drawer is unopened', async () => {
    const r = await expense(bank, 3_000);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const after = await snapshot();
    expect(after.totals[bank]).toBe(47_000);
    expect(after.totals['EXPENSE:' + categoryCode]).toBe(3_000);
    expect(after.sessions).toBe(0);
  });

  it('OFF: an actual customer advance reaches Cash without creating a counted session', async () => {
    ok(await toggle('off'), 'cash sessions OFF');
    const customer = ok(await signed(api().post('/api/v1/parties')).send({
      name: 'Cash advance test customer', roles: ['CUSTOMER'], phone: '01812345001',
      address: null, guardianName: null, nid: null, email: null, notes: null,
      customerGroupId: null, creditLimitMinor: null,
    }), 'customer');
    const before = await snapshot();
    const payment = await signed(api().post('/api/v1/customer-payments')).send({
      customerPartyId: customer.body.data.id as string,
      accountCode: drawer, amountMinor: 5_000, saleIds: [], note: null,
    });
    ok(payment, 'customer advance');
    const after = await snapshot();
    expect(after.totals[drawer]).toBe(105_000);
    // There is no invoice to settle: this is correctly held as an advance,
    // never manufactured as sale revenue or a historical AR settlement.
    expect(after.totals.CUSTOMER_ADVANCE).toBe(-5_000);
    expect(after.totals.REVENUE ?? 0).toBe(before.totals.REVENUE ?? 0);
    expect(after.entries).toBe(before.entries + 1);
    expect(after.sessions).toBe(0);
    const rows = await asTenant(pool, tenant.tenantId, db =>
      db.query<{ session_id: string | null }>('SELECT session_id FROM customer_receipts'));
    expect(rows.rows).toEqual([{ session_id: null }]);
  });

  it('ON: customer receipt into a tracked unopened drawer is refused without posting', async () => {
    const customer = ok(await signed(api().post('/api/v1/parties')).send({
      name: 'Cash day required customer', roles: ['CUSTOMER'], phone: '01812345002',
      address: null, guardianName: null, nid: null, email: null, notes: null,
      customerGroupId: null, creditLimitMinor: null,
    }), 'customer');
    const before = await snapshot();
    const payment = await signed(api().post('/api/v1/customer-payments')).send({
      customerPartyId: customer.body.data.id as string,
      accountCode: drawer, amountMinor: 5_000, saleIds: [], note: null,
    });
    expect(payment.status, JSON.stringify(payment.body)).toBe(400);
    expect(payment.body.error?.details?.reason).toBe('CASH_DAY_NOT_STARTED');
    expect(await snapshot()).toEqual(before);
  });

  it('ON: an eligible OPEN physical day links drawer expense to its session', async () => {
    const sessionId = await startDay();
    const r = await expense(drawer, 1_000);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const rows = await asTenant(pool, tenant.tenantId, db =>
      db.query<{ session_id: string | null }>('SELECT session_id FROM expenses'));
    expect(rows.rows).toEqual([{ session_id: sessionId }]);
    expect((await snapshot()).totals[drawer]).toBe(99_000);
  });

  it('OFF: cash shortage is still rejected before any journal', async () => {
    ok(await toggle('off'), 'cash sessions OFF');
    const before = await snapshot();
    const r = await expense(drawer, 100_001);
    expect(r.status).toBe(400);
    expect(r.body.error?.details?.reason ?? r.body.error?.reason).toBe('CASH_ACCOUNT_SHORT');
    expect(await snapshot()).toEqual(before);
  });

  it('OFF paid-now purchase posts inventory without any cash session', async () => {
    ok(await toggle('off'), 'cash sessions OFF');
    const { productId, supplierId } = await productAndSupplier();
    const before = await snapshot();
    const r = await purchase(supplierId, productId, 100_000, drawer);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const after = await snapshot();
    expect(after.purchases).toBe(before.purchases + 1);
    expect(after.totals.INVENTORY).toBe(100_000);
    expect(after.totals.AP ?? 0).toBe(0);
    expect(after.totals[drawer]).toBe(0);
    expect(after.sessions).toBe(0);
  });

  it('OFF supplier payment clears only allocated payable without a day', async () => {
    ok(await toggle('off'), 'cash sessions OFF');
    const { productId, supplierId } = await productAndSupplier();
    ok(await purchase(supplierId, productId, 0, null), 'credit purchase');
    const before = await snapshot();
    expect(before.totals.AP).toBe(-100_000);
    const r = await signed(api().post('/api/v1/suppliers/payments')).send({
      supplierPartyId: supplierId, amountMinor: 40_000,
      accountCode: drawer, note: null, purchaseId: null,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const after = await snapshot();
    expect(after.totals.AP).toBe(-60_000);
    expect(after.totals[drawer]).toBe(60_000);
    expect(after.sessions).toBe(0);
    expect(after.suppliers).toBe(before.suppliers + 1);
  });
});
