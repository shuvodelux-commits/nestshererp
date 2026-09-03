/*
 * Coverage claims, read by `pnpm test:inventory` (owner request 2026-09-03).
 *
 * @covers endpoint:POST /api/v1/sales-returns
 * @covers endpoint:GET /api/v1/sales-returns
 * @covers endpoint:GET /api/v1/sales-returns/returnable/:saleId
 * @covers endpoint:POST /api/v1/purchase-returns
 * @covers endpoint:GET /api/v1/purchase-returns
 * @covers endpoint:GET /api/v1/purchase-returns/returnable/:purchaseId
 * @covers permission:sales.return.create
 * @covers permission:purchase.return.create
 * @covers workflow:sales-return
 * @covers workflow:purchase-return
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
  asTenant, prepareTestDatabase, resetDatabase, seedTenant, seedWalkInCustomer, testPool, todayIn,
} from './support/database';
import { assertGoldenInvariants } from './support/invariants';

/**
 * Goods coming back, in both directions (§5.11).
 *
 * A return is the transaction most likely to be got subtly wrong, because it
 * has to undo part of a document rather than all of it: the stock has to move
 * the other way, the party balance has to move by the returned value and not by
 * the whole bill, and the money has to go back out of the same account it came
 * into — or stay on account, which is a different posting entirely. Each case
 * here checks the ledger and the shelf, never the response.
 */

const clock = new SystemClock();

/** Accounts are opened before the shop trades, so the balance has a date. */
const openingDay = '2026-01-01';
let app: INestApplication;
let pool: pg.Pool;
let tenant: SeededTenant;
let token: string;
let productId: string;
let customerId: string;
let supplierId: string;
let drawerCode: string;

const PERMISSIONS = [
  Permission.SALE_CREATE, Permission.SALE_VIEW,
  Permission.SALES_RETURN_CREATE, Permission.SALES_RETURN_VIEW,
  Permission.PURCHASE_CREATE, Permission.PURCHASE_VIEW,
  Permission.PURCHASE_RETURN_CREATE, Permission.PURCHASE_RETURN_VIEW,
  Permission.PRODUCT_VIEW, Permission.PRODUCT_CREATE, Permission.PRODUCT_EDIT,
  Permission.UNIT_MANAGE, Permission.CUSTOMER_VIEW, Permission.CUSTOMER_CREATE,
  Permission.SUPPLIER_VIEW, Permission.SUPPLIER_CREATE,
  Permission.COST_VIEW, Permission.INVENTORY_LOT_VIEW,
  Permission.CASH_ACCOUNT_VIEW, Permission.CASH_ACCOUNT_MANAGE,
  Permission.CASH_SESSION_START, Permission.CASH_DAILY_VIEW,
];

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

afterEach(async () => {
  await assertGoldenInvariants(pool, tenant.tenantId);
});

const api = (): ReturnType<typeof request> => request(app.getHttpServer());
const auth = (test: request.Test, as = token): request.Test =>
  test.set('Authorization', `Bearer ${as}`).set('Idempotency-Key', Ulid.generate(clock));

function must(response: request.Response, what: string): request.Response {
  if (response.status >= 400) {
    throw new Error(`${what} failed: ${String(response.status)} ${JSON.stringify(response.body)}`);
  }
  return response;
}

beforeEach(async () => {
  await resetDatabase(pool);
  tenant = await seedTenant(pool, { name: 'Returns Test', permissions: PERMISSIONS });
  token = signToken(tenant, TEST_JWT_SECRET);
  await seedWalkInCustomer(pool, tenant);

  const unit = must(await auth(api().post('/api/v1/catalog/units')).send({ name: 'Piece' }), 'unit');
  const unitId = unit.body.data.units[0].id as string;

  const product = must(await auth(api().post('/api/v1/products')).send({
    name: 'Rice', baseUnitId: unitId,
    purchasePriceMinor: 100_00, sellingPriceMinor: 120_00, minStockQty: 0,
    brandId: null, categoryId: null, sku: null, barcode: null, description: null,
    defaultDiscountType: null, defaultDiscountValue: null, offerEnabled: false,
    offerPriceMinor: null, offerStartDate: null, offerEndDate: null,
    tracksExpiry: false, tracksSerial: false, conversionUnitId: null, conversionFactorQty: null,
  }), 'product');
  productId = product.body.data.id as string;

  const customer = must(await auth(api().post('/api/v1/parties')).send({
    name: 'Karim Uddin', roles: ['CUSTOMER'], phone: '01712345678',
    address: null, guardianName: null, nid: null, email: null, notes: null,
    customerGroupId: null, creditLimitMinor: null,
  }), 'customer');
  customerId = customer.body.data.id as string;

  const supplier = must(await auth(api().post('/api/v1/parties')).send({
    name: 'Dhaka Wholesale', roles: ['SUPPLIER'], phone: '01812345678',
    address: null, guardianName: null, nid: null, email: null, notes: null,
    customerGroupId: null, creditLimitMinor: null,
  }), 'supplier');
  supplierId = supplier.body.data.id as string;

  const drawer = must(await api().post('/api/v1/money/accounts')
    .set('Authorization', `Bearer ${token}`)
    .send({
      name: 'Counter drawer', type: 'CASH', holderName: null, reference: null,
      isDrawer: true, openingAmountMinor: 100000_00, openingDate: openingDay,
      operationId: Ulid.generate(clock),
    }), 'drawer');
  drawerCode = `CASH:${drawer.body.data.id as string}`;

  must(await api().post('/api/v1/money/day/start')
    .set('Authorization', `Bearer ${token}`)
    .send({
      businessDate: todayIn(tenant.timezone), openingAmountMinor: 100000_00,
      counterpartAccountCode: null, note: null, operationId: Ulid.generate(clock),
    }), 'start day');
});

async function ledger(): Promise<Record<string, number>> {
  return asTenant(pool, tenant.tenantId, async (db) => {
    const rows = await db.query<{ account_code: string; total: string }>(
      `SELECT account_code, SUM(amount_minor)::bigint AS total
         FROM journal_lines GROUP BY account_code`,
    );
    return Object.fromEntries(rows.rows.map((row) => [row.account_code, Number(row.total)]));
  });
}

async function onHand(): Promise<number> {
  return asTenant(pool, tenant.tenantId, async (db) => {
    const row = await db.query<{ net: string }>(
      `SELECT COALESCE(SUM(CASE direction WHEN 'IN' THEN qty ELSE -qty END), 0)::bigint AS net
         FROM stock_movements WHERE product_id = $1`,
      [productId],
    );
    return Number(row.rows[0]?.net ?? 0);
  });
}

/** Ten pieces bought at 100.00 on credit, which everything below starts from. */
async function buyTen(): Promise<{ purchaseId: string; lineId: string }> {
  const bill = must(await auth(api().post('/api/v1/purchases')).send({
    supplierPartyId: supplierId,
    lines: [{ productId, qty: 10_000, unitPriceMinor: 100_00 }],
    discountMinor: 0, paidMinor: 0, paidAccountCode: null,
  }), 'purchase');
  return {
    purchaseId: bill.body.data.id as string,
    lineId: bill.body.data.lines[0].id as string,
  };
}

/** Four of them sold on credit at 120.00. */
async function sellFour(): Promise<{ saleId: string; lineId: string }> {
  const sale = must(await auth(api().post('/api/v1/sales')).send({
    partyId: customerId, customerName: null, customerPhone: null,
    lines: [{ productId, qty: 4_000, unitPriceMinor: 120_00, lineDiscountMinor: 0 }],
    payments: [], discountMinor: 0,
  }), 'sale');
  return {
    saleId: sale.body.data.id as string,
    lineId: sale.body.data.lines[0].id as string,
  };
}

describe('a customer brings goods back (§5.11)', () => {
  it('puts them back on the shelf and takes the value off what they owe', async () => {
    await buyTen();
    const sale = await sellFour();

    const returned = await auth(api().post('/api/v1/sales-returns')).send({
      saleId: sale.saleId,
      lines: [{ sourceLineId: sale.lineId, qty: 1_000 }],
      reason: 'CHANGED_MIND', note: null, refundMinor: 0, refundAccountCode: null,
    });
    expect(returned.status, JSON.stringify(returned.body)).toBe(201);

    const accounts = await ledger();
    // Bought ten, sold four, one came back: seven were sold or are held, and
    // the shelf holds seven.
    expect(await onHand()).toBe(7_000);
    // The customer owed 480.00 for four; one at 120.00 came back, so 360.00.
    expect(accounts['AR']).toBe(360_00);
    // The goods are worth 100.00 back in stock, and that cost leaves COGS.
    expect(accounts['COGS']).toBe(300_00);
    expect(accounts['INVENTORY']).toBe(1000_00 - 300_00);
  });

  it('hands cash back out of the drawer when the sale was paid for in cash', async () => {
    await buyTen();
    // Paid across the counter, so a return owes the customer money rather than
    // a smaller bill — which is the posting that differs.
    const sale = must(await auth(api().post('/api/v1/sales')).send({
      partyId: customerId, customerName: null, customerPhone: null,
      lines: [{ productId, qty: 4_000, unitPriceMinor: 120_00, lineDiscountMinor: 0 }],
      payments: [{ accountCode: drawerCode, amountMinor: 480_00 }], discountMinor: 0,
    }), 'cash sale');
    const before = await ledger();
    expect(before[drawerCode]).toBe(100000_00 + 480_00);

    const returned = await auth(api().post('/api/v1/sales-returns')).send({
      saleId: sale.body.data.id as string,
      lines: [{ sourceLineId: sale.body.data.lines[0].id as string, qty: 1_000 }],
      reason: 'DAMAGED', note: null,
      refundMinor: 120_00, refundAccountCode: drawerCode,
    });
    expect(returned.status, JSON.stringify(returned.body)).toBe(201);

    const accounts = await ledger();
    // The 120.00 physically left the till, so the till says so.
    expect(accounts[drawerCode]).toBe(100000_00 + 480_00 - 120_00);
    // Refunded in full, so nothing is left sitting on the customer's account.
    expect(accounts['AR'] ?? 0).toBe(0);
    expect(accounts['CUSTOMER_ADVANCE'] ?? 0).toBe(0);
    expect(await onHand()).toBe(7_000);
  });

  it('is refused without sales.return.create', async () => {
    await buyTen();
    const sale = await sellFour();
    const clerk = await seedTenant(pool, {
      name: 'Returns Test', permissions: [Permission.SALES_RETURN_VIEW],
    });
    const refused = await auth(
      api().post('/api/v1/sales-returns'), signToken(clerk, TEST_JWT_SECRET),
    ).send({
      saleId: sale.saleId, lines: [{ sourceLineId: sale.lineId, qty: 1_000 }],
      reason: 'DAMAGED', note: null, refundMinor: 0, refundAccountCode: null,
    });
    expect(refused.status).toBe(403);
  });

  it('refuses more than was sold', async () => {
    await buyTen();
    const sale = await sellFour();
    const refused = await auth(api().post('/api/v1/sales-returns')).send({
      saleId: sale.saleId, lines: [{ sourceLineId: sale.lineId, qty: 9_000 }],
      reason: 'DAMAGED', note: null, refundMinor: 0, refundAccountCode: null,
    });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.status).toBeLessThan(500);
    // The four that were sold are still sold.
    expect(await onHand()).toBe(6_000);
  });
});

describe('the shop sends goods back to its supplier (§5.11)', () => {
  it('takes them off the shelf and off what the shop owes', async () => {
    const purchase = await buyTen();

    const returned = await auth(api().post('/api/v1/purchase-returns')).send({
      purchaseId: purchase.purchaseId,
      lines: [{ sourceLineId: purchase.lineId, qty: 2_000 }],
      reason: 'DAMAGED', note: null, receivedMinor: 0, receiptAccountCode: null,
    });
    expect(returned.status, JSON.stringify(returned.body)).toBe(201);

    const accounts = await ledger();
    expect(await onHand()).toBe(8_000);
    expect(accounts['INVENTORY']).toBe(800_00);
    // Owed 1000.00, sent 200.00 of it back.
    expect(accounts['AP']).toBe(-800_00);
  });

  it('refuses more than was bought', async () => {
    const purchase = await buyTen();
    const refused = await auth(api().post('/api/v1/purchase-returns')).send({
      purchaseId: purchase.purchaseId,
      lines: [{ sourceLineId: purchase.lineId, qty: 20_000 }],
      reason: 'DAMAGED', note: null, receivedMinor: 0, receiptAccountCode: null,
    });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.status).toBeLessThan(500);
    expect(await onHand()).toBe(10_000);
  });

  it('is refused without purchase.return.create', async () => {
    const purchase = await buyTen();
    const clerk = await seedTenant(pool, {
      name: 'Returns Test', permissions: [Permission.PURCHASE_RETURN_VIEW],
    });
    const refused = await auth(
      api().post('/api/v1/purchase-returns'), signToken(clerk, TEST_JWT_SECRET),
    ).send({
      purchaseId: purchase.purchaseId,
      lines: [{ sourceLineId: purchase.lineId, qty: 1_000 }],
      reason: 'DAMAGED', note: null, receivedMinor: 0, receiptAccountCode: null,
    });
    expect(refused.status).toBe(403);
  });
});
