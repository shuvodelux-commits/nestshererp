/*
 * MOD-005 #15 follow-on: pre-existing customer receivables and real receipts.
 * RED-FIRST. Genuine signed Nest API, isolated PostgreSQL16 and FORCE RLS.
 * No migrated/production database or direct seeded journal financial entries.
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
const DATABASE = 'hisabiq_mod005_openingar_20261114';
const PORT = '55743';
const SENTINEL = 'MOD005_HISTORICAL_AR_DISPOSABLE_20261114';
const suite = process.env['MOD005_OPENING_AR_TEST_ONLY'] === SENTINEL ? describe : describe.skip;

let app: INestApplication;
let pool: pg.Pool;
let tenant: SeededTenant;
let token: string;
let cashCode: string;
let customerId: string;
const op = (): string => Ulid.generate(clock);
const api = (): ReturnType<typeof request> => request(app.getHttpServer());
const signed = (t: request.Test, operationId = op()): request.Test =>
  t.set('Authorization', 'Bearer ' + token).set('Idempotency-Key', operationId);
const ok = (r: request.Response, label: string): request.Response => {
  expect(r.status, label + ': ' + JSON.stringify(r.body)).toBe(201);
  return r;
};
function exclusiveDatabase(): void {
  if (process.env['MOD005_OPENING_AR_TEST_ONLY'] !== SENTINEL) {
    throw new Error('Only explicit MOD005 opening AR QA allowed');
  }
  for (const key of ['DATABASE_URL', 'TEST_DATABASE_URL', 'ADMIN_DATABASE_URL']) {
    const raw = process.env[key];
    if (!raw) throw new Error('Missing exclusive QA database: ' + key);
    const uri = new URL(raw);
    if (uri.protocol !== 'postgres:' || uri.hostname !== '127.0.0.1' ||
      uri.port !== PORT || uri.pathname !== '/' + DATABASE ||
      uri.username !== (key === 'ADMIN_DATABASE_URL' ? 'postgres' : 'sher_app')) {
      throw new Error('Refusing non-exclusive database or elevated app role: ' + key);
    }
  }
}
async function balances(): Promise<{ totals: Record<string, number>; journalCount: number; sessionCount: number; receiptCount: number; }> {
  return asTenant(pool, tenant.tenantId, async db => {
    const rows = await db.query<{ account_code: string; balance: string }>(
      'SELECT account_code, SUM(amount_minor)::text AS balance FROM journal_lines GROUP BY account_code',
    );
    const count = await db.query<{ journal_count: number; session_count: number; receipt_count: number }>(
      'SELECT (SELECT count(*)::int FROM journal_entries) AS journal_count, ' +
      '(SELECT count(*)::int FROM cash_sessions) AS session_count, ' +
      '(SELECT count(*)::int FROM customer_receipts) AS receipt_count',
    );
    return {
      totals: Object.fromEntries(rows.rows.map(row => [row.account_code, Number(row.balance)])),
      journalCount: count.rows[0]!.journal_count,
      sessionCount: count.rows[0]!.session_count,
      receiptCount: count.rows[0]!.receipt_count,
    };
  });
}
async function collect(
  amountMinor: number, operationId = op(), saleIds: readonly string[] = [],
): Promise<request.Response> {
  return signed(api().post('/api/v1/customer-payments'), operationId).send({
    customerPartyId: customerId, accountCode: cashCode,
    amountMinor, saleIds, note: 'Collection against migrated customer balance',
  });
}
async function customerDue(): Promise<{ dueMinor: number; advanceMinor: number }> {
  const r = await signed(api().get('/api/v1/customers/' + customerId + '/standing'));
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const value = r.body.data as { dueMinor: number; advanceMinor: number };
  return { dueMinor: value.dueMinor, advanceMinor: value.advanceMinor };
}

async function createCreditInvoice(): Promise<string> {
  const unit = ok(await signed(api().post('/api/v1/catalog/units')).send({ name: 'Piece' }),
    'stock unit');
  const product = ok(await signed(api().post('/api/v1/products')).send({
    name: 'Old receivable mixed test part',
    baseUnitId: unit.body.data.units[0].id as string,
    purchasePriceMinor: 50_000, sellingPriceMinor: 100_000, minStockQty: 0,
    brandId: null, categoryId: null, sku: null, barcode: null, description: null,
    defaultDiscountType: null, defaultDiscountValue: null, offerEnabled: false,
    offerPriceMinor: null, offerStartDate: null, offerEndDate: null,
    tracksExpiry: false, tracksSerial: false, conversionUnitId: null, conversionFactorQty: null,
  }), 'sale product');
  const productId = product.body.data.id as string;
  ok(await signed(api().post('/api/v1/inventory/openings')).send({
    productId, qty: 10_000,
  }), 'opening stock');
  const sale = ok(await signed(api().post('/api/v1/sales')).send({
    partyId: customerId, customerName: null, customerPhone: null,
    lines: [{ productId, qty: 3_000, unitPriceMinor: 100_000, lineDiscountMinor: 0 }],
    payments: [], discountMinor: 0,
  }), 'new credit sale');
  return sale.body.data.id as string;
}

suite('MOD-005: historical Customer AR is collected, not turned into an advance', () => {
  beforeAll(async () => {
    exclusiveDatabase(); // strictly before DB creation, migrations, reads, or mutation.
    pool = testPool();
    await prepareTestDatabase();
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    app.useGlobalFilters(new AppErrorFilter());
    await app.init();
  }, 90_000);
  afterAll(async () => { await app?.close(); await pool?.end(); });
  beforeEach(async () => {
    await resetDatabase(pool);
    tenant = await seedTenant(pool, {
      name: 'Disposable opening AR settlement shop',
      permissions: [
        Permission.CASH_ACCOUNT_VIEW, Permission.CASH_ACCOUNT_MANAGE,
        Permission.CUSTOMER_VIEW, Permission.CUSTOMER_CREATE, Permission.CUSTOMER_EDIT,
        Permission.SALE_RECEIVE_PAYMENT, Permission.RECEIPT_VOID,
        Permission.SETTING_TOGGLE,
        Permission.SALE_CREATE, Permission.SALE_VIEW,
        Permission.PRODUCT_VIEW, Permission.PRODUCT_CREATE, Permission.PRODUCT_EDIT,
        Permission.UNIT_MANAGE, Permission.COST_VIEW, Permission.INVENTORY_LOT_VIEW,
      ],
    });
    token = signToken(tenant, TEST_JWT_SECRET);
    const cash = ok(await signed(api().post('/api/v1/money/accounts')).send({
      name: 'Real drawer', type: 'CASH', holderName: null, reference: null, isDrawer: true,
      openingAmountMinor: 100_000, openingDate: '2026-11-01', operationId: op(),
    }), 'cash asset');
    cashCode = 'CASH:' + cash.body.data.id;
    ok(await signed(api().post('/api/v1/settings/value')).send({
      key: 'cash_session_enabled', value: 'off',
    }), 'sessions disabled');
    const created = ok(await signed(api().post('/api/v1/parties')).send({
      name: 'Pre-onboarding debtor', roles: ['CUSTOMER'], phone: '01718000888',
      address: null, guardianName: null, nid: null, email: null, notes: null,
      customerGroupId: null, creditLimitMinor: null,
      opening: {
        role: 'CUSTOMER', direction: 'RECEIVABLE',
        amountMinor: 2_000_000, businessDate: todayIn(tenant.timezone),
      },
    }), 'opening receivable');
    customerId = created.body.data.id as string;
    const baseline = await balances();
    expect(baseline.totals.AR).toBe(2_000_000);
    expect(baseline.totals.OPENING_EQUITY).toBe(-2_100_000);
    expect(baseline.sessionCount).toBe(0);
    expect(await customerDue()).toEqual({ dueMinor: 2_000_000, advanceMinor: 0 });
  });
  afterEach(async () => {
    if (tenant?.tenantId) await assertGoldenInvariants(pool, tenant.tenantId);
  });

  it('collecting BDT 5,000 against BDT 20,000 opening reduces AR to BDT 15,000', async () => {
    const original = await balances();
    const operationId = op();
    const result = ok(await collect(500_000, operationId), 'real opening-AR receipt');
    expect(result.body.data.settledMinor).toBe(500_000);
    expect(result.body.data.advanceMinor).toBe(0);
    expect(result.body.data.allocations).toEqual([]);
    const after = await balances();
    expect(after.totals.AR).toBe(1_500_000);
    expect(after.totals.CUSTOMER_ADVANCE ?? 0).toBe(0);
    expect(after.totals[cashCode]).toBe(600_000);
    expect(after.totals.OPENING_EQUITY).toBe(original.totals.OPENING_EQUITY);
    expect(after.totals.SALES_REVENUE ?? 0).toBe(original.totals.SALES_REVENUE ?? 0);
    expect(after.sessionCount).toBe(0);
    expect(after.journalCount).toBe(original.journalCount + 1);
    expect(await customerDue()).toEqual({ dueMinor: 1_500_000, advanceMinor: 0 });
    const replay = ok(await collect(500_000, operationId), 'same operation replay');
    expect(replay.body.data).toEqual(result.body.data);
    expect(await balances()).toEqual(after);
  });

  it('BDT 25,000 received against BDT 20,000 opening creates only BDT 5,000 advance', async () => {
    const result = ok(await collect(2_500_000), 'opening + excess');
    expect(result.body.data.settledMinor).toBe(2_000_000);
    expect(result.body.data.advanceMinor).toBe(500_000);
    const after = await balances();
    expect(after.totals.AR ?? 0).toBe(0);
    expect(after.totals.CUSTOMER_ADVANCE).toBe(-500_000);
    expect(after.sessionCount).toBe(0);
    expect(await customerDue()).toEqual({ dueMinor: 0, advanceMinor: 500_000 });
  });

  it('correcting an opening receipt reverses old AR collection and reposts the new one', async () => {
    const first = ok(await collect(500_000), 'receipt before correction').body.data;
    const r = await signed(api().patch('/api/v1/customer-payments/' + first.id)).send({
      customerPartyId: customerId, accountCode: cashCode, amountMinor: 300_000,
      saleIds: [], note: 'Correct collected amount', version: first.version,
      reason: 'Actual cash counted BDT 3,000 instead of BDT 5,000',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.settledMinor).toBe(300_000);
    expect(r.body.data.advanceMinor).toBe(0);
    const after = await balances();
    expect(after.totals.AR).toBe(1_700_000);
    expect(after.totals[cashCode]).toBe(400_000);
    expect(after.totals.CUSTOMER_ADVANCE ?? 0).toBe(0);
    expect(await customerDue()).toEqual({ dueMinor: 1_700_000, advanceMinor: 0 });
    expect(after.receiptCount).toBe(1);
    expect(after.sessionCount).toBe(0);
  });

  it('successive collections exhaust historical AR first and then create only the excess advance', async () => {
    const original = await balances();
    const first = ok(await collect(500_000), 'first collection').body.data;
    const second = ok(await collect(700_000), 'second collection').body.data;
    const third = ok(await collect(1_000_000), 'receipt above remaining original AR').body.data;
    expect([first.settledMinor, second.settledMinor, third.settledMinor]).toEqual([
      500_000, 700_000, 800_000,
    ]);
    expect([first.advanceMinor, second.advanceMinor, third.advanceMinor]).toEqual([
      0, 0, 200_000,
    ]);
    expect(first.allocations).toEqual([]);
    expect(second.allocations).toEqual([]);
    expect(third.allocations).toEqual([]);
    const after = await balances();
    expect(after.totals.AR ?? 0).toBe(0);
    expect(after.totals.CUSTOMER_ADVANCE).toBe(-200_000);
    expect(after.totals[cashCode]).toBe(2_300_000);
    expect(after.totals.OPENING_EQUITY).toBe(original.totals.OPENING_EQUITY);
    expect(after.journalCount).toBe(original.journalCount + 3);
    expect(after.sessionCount).toBe(0);
    expect(await customerDue()).toEqual({ dueMinor: 0, advanceMinor: 200_000 });
  });

  it('voiding a posted historical collection reverses AR and Cash without editing opening equity', async () => {
    const original = await balances();
    const posted = ok(await collect(500_000), 'receipt before void').body.data;
    expect((await customerDue()).dueMinor).toBe(1_500_000);
    const response = await signed(api().post('/api/v1/customer-payments/' + posted.id + '/void')).send({
      version: posted.version,
      reason: 'Customer payment entered against the wrong day',
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.data.status).toBe('VOIDED');
    const after = await balances();
    expect(after.totals.AR).toBe(2_000_000);
    expect(after.totals[cashCode]).toBe(100_000);
    expect(after.totals.OPENING_EQUITY).toBe(original.totals.OPENING_EQUITY);
    expect(after.totals.CUSTOMER_ADVANCE ?? 0).toBe(0);
    expect(after.receiptCount).toBe(1);
    expect(after.sessionCount).toBe(0);
    expect(await customerDue()).toEqual({ dueMinor: 2_000_000, advanceMinor: 0 });
  });


  it('automatic oldest-first receipt settles historical AR before a newer invoice', async () => {
    const saleId = await createCreditInvoice();
    expect((await customerDue()).dueMinor).toBe(2_300_000);
    const first = ok(await collect(500_000), 'older opening first').body.data;
    expect(first.settledMinor).toBe(500_000);
    expect(first.advanceMinor).toBe(0);
    expect(first.allocations).toEqual([]);
    const second = ok(await collect(1_700_000), 'remaining opening + part of invoice').body.data;
    expect(second.settledMinor).toBe(1_700_000);
    expect(second.advanceMinor).toBe(0);
    expect(second.allocations).toMatchObject([{ saleId, amountMinor: 200_000 }]);
    expect((await customerDue()).dueMinor).toBe(100_000);
    const invoice = await signed(api().get('/api/v1/customers/' + customerId + '/standing'));
    expect(invoice.status).toBe(200);
    expect(invoice.body.data.openInvoices).toContainEqual(expect.objectContaining({
      id: saleId, outstandingMinor: 100_000,
    }));
    const after = await balances();
    expect(after.totals.AR).toBe(100_000);
    expect(after.totals.CUSTOMER_ADVANCE ?? 0).toBe(0);
    expect(after.sessionCount).toBe(0);
  });

  it('an explicitly named invoice is settled without silently diverting its payment to opening AR', async () => {
    const saleId = await createCreditInvoice();
    const receipt = ok(await collect(100_000, op(), [saleId]), 'invoice-targeted receipt').body.data;
    expect(receipt.settledMinor).toBe(100_000);
    expect(receipt.advanceMinor).toBe(0);
    expect(receipt.allocations).toMatchObject([{ saleId, amountMinor: 100_000 }]);
    const after = await balances();
    expect(after.totals.AR).toBe(2_200_000);
    expect(after.totals.CUSTOMER_ADVANCE ?? 0).toBe(0);
    expect(after.sessionCount).toBe(0);
    const standing = await signed(api().get('/api/v1/customers/' + customerId + '/standing'));
    expect(standing.status).toBe(200);
    expect(standing.body.data.openInvoices).toContainEqual(expect.objectContaining({
      id: saleId, outstandingMinor: 200_000,
    }));
  });

});
