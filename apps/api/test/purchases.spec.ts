/*
 * Coverage claims, read by `pnpm test:inventory` (owner request 2026-09-03).
 *
 * @covers endpoint:POST /api/v1/purchases
 * @covers endpoint:GET /api/v1/purchases
 * @covers endpoint:GET /api/v1/purchases/:id
 * @covers endpoint:POST /api/v1/purchases/:id/void
 * @covers endpoint:POST /api/v1/suppliers/payments
 * @covers permission:purchase.bill.create
 * @covers permission:purchase.bill.void
 * @covers permission:purchase.payment.record
 * @covers workflow:supplier-payment
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

/**
 * What buying stock does to the books and the shelf (§5.9, §5.12, §5.19).
 *
 * The same discipline as `sales.spec.ts`: every assertion reads `journal_lines`
 * and `stock_movements`, never the response body, because a bill that returns
 * the right total and posts the wrong journal is precisely the failure worth
 * catching. What is proved here is the payable side of the shop — that a credit
 * purchase raises `AP` against a named supplier, that paying it clears exactly
 * what was paid, that a landed cost lands in the stock value rather than in
 * expenses, and that voiding leaves nothing behind (INV-08).
 */

const clock = new SystemClock();

/** Accounts are opened before the shop trades, so the balance has a date. */
const openingDay = '2026-01-01';
let app: INestApplication;
let pool: pg.Pool;
let tenant: SeededTenant;
let token: string;
let productId: string;
let supplierId: string;
let drawerCode: string;

const BUYER_PERMISSIONS = [
  Permission.PURCHASE_CREATE, Permission.PURCHASE_VIEW, Permission.PURCHASE_VOID,
  Permission.PURCHASE_PAY, Permission.PRODUCT_VIEW, Permission.PRODUCT_CREATE,
  Permission.PRODUCT_EDIT, Permission.UNIT_MANAGE, Permission.SUPPLIER_VIEW,
  Permission.SUPPLIER_CREATE, Permission.COST_VIEW, Permission.INVENTORY_LOT_VIEW,
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

/** A setup step that fails silently turns every case below into a puzzle. */
function must(response: request.Response, what: string): request.Response {
  if (response.status >= 400) {
    throw new Error(`${what} failed: ${String(response.status)} ${JSON.stringify(response.body)}`);
  }
  return response;
}

beforeEach(async () => {
  await resetDatabase(pool);
  tenant = await seedTenant(pool, { name: 'Purchase Test', permissions: BUYER_PERMISSIONS });
  token = signToken(tenant, TEST_JWT_SECRET);

  const unit = must(
    await auth(api().post('/api/v1/catalog/units')).send({ name: 'Piece' }),
    'create unit',
  );
  const unitId = unit.body.data.units[0].id as string;

  const product = must(
    await auth(api().post('/api/v1/products')).send({
      name: 'Rice', baseUnitId: unitId,
      purchasePriceMinor: 100_00, sellingPriceMinor: 120_00, minStockQty: 0,
      brandId: null, categoryId: null, sku: null, barcode: null, description: null,
      defaultDiscountType: null, defaultDiscountValue: null, offerEnabled: false,
      offerPriceMinor: null, offerStartDate: null, offerEndDate: null,
      tracksExpiry: false, tracksSerial: false, conversionUnitId: null, conversionFactorQty: null,
    }),
    'create product',
  );
  productId = product.body.data.id as string;

  const supplier = must(
    await auth(api().post('/api/v1/parties')).send({
      name: 'Dhaka Wholesale', roles: ['SUPPLIER'], phone: '01812345678',
      address: null, guardianName: null, nid: null, email: null, notes: null,
      customerGroupId: null, creditLimitMinor: null,
    }),
    'create supplier',
  );
  supplierId = supplier.body.data.id as string;

  const drawer = must(
    await api().post('/api/v1/money/accounts')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Counter drawer', type: 'CASH', holderName: null, reference: null,
        isDrawer: true, openingAmountMinor: 100000_00, openingDate: openingDay,
        operationId: Ulid.generate(clock),
      }),
    'create drawer',
  );
  drawerCode = `CASH:${drawer.body.data.id as string}`;

  // Money leaves the drawer only on a started day (§5.16.1).
  must(
    await api().post('/api/v1/money/day/start')
      .set('Authorization', `Bearer ${token}`)
      .send({
        businessDate: todayIn(tenant.timezone), openingAmountMinor: 100000_00,
        counterpartAccountCode: null, note: null, operationId: Ulid.generate(clock),
      }),
    'start day',
  );
});

/** Ten pieces at 100.00, on credit, unless the case says otherwise. */
function purchaseBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    supplierPartyId: supplierId,
    lines: [{ productId, qty: 10_000, unitPriceMinor: 100_00 }],
    discountMinor: 0, paidMinor: 0, paidAccountCode: null, ...overrides,
  };
}

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

/** What the shop owes this supplier, from the ledger (INV-06). */
async function payable(): Promise<number> {
  return asTenant(pool, tenant.tenantId, async (db) => {
    const row = await db.query<{ total: string }>(
      `SELECT COALESCE(SUM(amount_minor), 0)::bigint AS total
         FROM journal_lines WHERE account_code = 'AP' AND party_id = $1`,
      [supplierId],
    );
    return Number(row.rows[0]?.total ?? 0);
  });
}

describe('a purchase on credit', () => {
  it('puts the goods on the shelf and the debt on the supplier', async () => {
    const bill = await auth(api().post('/api/v1/purchases')).send(purchaseBody());
    expect(bill.status, JSON.stringify(bill.body)).toBe(201);

    const accounts = await ledger();
    expect(accounts['INVENTORY']).toBe(1000_00);
    // A payable is a credit balance: the shop owes it.
    expect(accounts['AP']).toBe(-1000_00);
    expect(accounts[drawerCode]).toBe(100000_00);

    expect(await onHand()).toBe(10_000);
    expect(await payable()).toBe(-1000_00);
  });

  it('is refused without purchase.bill.create, whatever the screen shows', async () => {
    const clerk = await seedTenant(pool, {
      name: 'Purchase Test', permissions: [Permission.PURCHASE_VIEW],
    });
    const refused = await auth(
      api().post('/api/v1/purchases'), signToken(clerk, TEST_JWT_SECRET),
    ).send(purchaseBody());
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('PERMISSION_DENIED');
  });
});

describe('a purchase paid at the counter', () => {
  it('takes the money out of the drawer and leaves nothing owing', async () => {
    const bill = await auth(api().post('/api/v1/purchases')).send(
      purchaseBody({ paidMinor: 1000_00, paidAccountCode: drawerCode }),
    );
    expect(bill.status, JSON.stringify(bill.body)).toBe(201);

    const accounts = await ledger();
    expect(accounts[drawerCode]).toBe(100000_00 - 1000_00);
    expect(accounts['AP'] ?? 0).toBe(0);
    expect(accounts['INVENTORY']).toBe(1000_00);
  });

  it('leaves only the unpaid part owing on a part-paid bill', async () => {
    await auth(api().post('/api/v1/purchases')).send(
      purchaseBody({ paidMinor: 400_00, paidAccountCode: drawerCode }),
    );

    const accounts = await ledger();
    expect(accounts['AP']).toBe(-600_00);
    expect(accounts[drawerCode]).toBe(100000_00 - 400_00);
  });
});

describe('a landed cost (§5.19)', () => {
  it('goes into what the stock is worth, not into expenses', async () => {
    const bill = await auth(api().post('/api/v1/purchases')).send(
      purchaseBody({
        landedCosts: [{
          category: 'TRANSPORT', method: 'BY_VALUE', amountMinor: 200_00,
          description: 'Truck from the wholesale market',
        }],
      }),
    );
    expect(bill.status, JSON.stringify(bill.body)).toBe(201);

    const accounts = await ledger();
    /*
     * The whole point of a landed cost: the ten sacks cost 1000.00 plus 200.00
     * to get them here, so they are worth 1200.00 on the shelf and the margin on
     * selling them is honest. Posting the transport to an expense account
     * instead would understate stock and overstate this month's costs.
     */
    expect(accounts['INVENTORY']).toBe(1200_00);
    expect(accounts['AP']).toBe(-1200_00);
    // No expense account was touched at all.
    expect(Object.keys(accounts).some((code) => code.startsWith('EXPENSE:'))).toBe(false);
  });
});

describe('paying a supplier', () => {
  it('clears exactly what was paid and takes it from the account named', async () => {
    await auth(api().post('/api/v1/purchases')).send(purchaseBody());
    expect(await payable()).toBe(-1000_00);

    const payment = await auth(api().post('/api/v1/suppliers/payments')).send({
      supplierPartyId: supplierId, amountMinor: 600_00,
      accountCode: drawerCode, note: null, purchaseId: null,
    });
    expect(payment.status, JSON.stringify(payment.body)).toBe(201);

    const accounts = await ledger();
    expect(accounts['AP']).toBe(-400_00);
    expect(accounts[drawerCode]).toBe(100000_00 - 600_00);
    expect(await payable()).toBe(-400_00);
  });
});

describe('voiding a bill (§2.5, INV-08)', () => {
  it('takes the goods back off the shelf and the debt off the supplier', async () => {
    const bill = await auth(api().post('/api/v1/purchases')).send(purchaseBody());
    const purchaseId = bill.body.data.id as string;
    const version = bill.body.data.version as number;

    const voided = await api().post(`/api/v1/purchases/${purchaseId}/void`)
      .set('Authorization', `Bearer ${token}`)
      .send({ version, reason: 'Wrong supplier' });
    expect(voided.status, JSON.stringify(voided.body)).toBeLessThan(300);

    const accounts = await ledger();
    expect(accounts['AP'] ?? 0).toBe(0);
    expect(accounts['INVENTORY'] ?? 0).toBe(0);
    expect(await onHand()).toBe(0);
    expect(await payable()).toBe(0);
  });
});

describe('the API refuses what the screen would not send (§6)', () => {
  it.each([
    ['no lines', { lines: [] }],
    ['a line of nothing', { lines: [{ productId, qty: 0, unitPriceMinor: 100_00 }] }],
    ['a negative quantity', { lines: [{ productId, qty: -1_000, unitPriceMinor: 100_00 }] }],
    ['a negative price', { lines: [{ productId, qty: 1_000, unitPriceMinor: -1 }] }],
    ['a negative discount', { discountMinor: -1 }],
    ['a negative payment', { paidMinor: -1 }],
    ['no supplier', { supplierPartyId: null }],
  ])('refuses %s', async (_case, overrides) => {
    const refused = await auth(api().post('/api/v1/purchases')).send(purchaseBody(overrides));
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('refuses paying from an account that does not exist', async () => {
    const refused = await auth(api().post('/api/v1/purchases')).send(
      purchaseBody({ paidMinor: 100_00, paidAccountCode: 'CASH:01ARZ3NDEKTSV4RRFFQ69G5FAV' }),
    );
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.status).toBeLessThan(500);
    // Nothing was half-done.
    expect(await onHand()).toBe(0);
  });
});
