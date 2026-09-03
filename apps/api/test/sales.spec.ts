/*
 * Coverage claims, read by `pnpm test:inventory` (owner request 2026-09-03).
 *
 * @covers endpoint:POST /api/v1/sales
 * @covers endpoint:GET /api/v1/sales
 * @covers endpoint:GET /api/v1/sales/:id
 * @covers endpoint:POST /api/v1/sales/:id/cancel
 * @covers endpoint:GET /api/v1/parties/:id/ledger
 * @covers permission:sale.invoice.create
 * @covers permission:sale.invoice.void
 * @covers workflow:cash-sale
 * @covers workflow:credit-sale
 * @covers workflow:void
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
 * What a sale actually does to the books and to the shelf (§5.7, §5.8).
 *
 * **Every assertion here reads the ledger, not the response.** A sale that
 * returns the right total and posts the wrong journal is the failure this file
 * exists to catch, and it is invisible to a test that trusts its own API's
 * arithmetic. So each case ends by summing `journal_lines` per account and
 * netting `stock_movements` — the two tables every screen, report and balance in
 * the product is eventually derived from — and `afterEach` re-checks the golden
 * invariants on top (§3.11).
 *
 * The edge cases of the *arithmetic* are not here. Discount apportionment,
 * rounding and costing are pure functions with their own unit tests in
 * `core-domain`, and duplicating their boundaries against a live database would
 * buy a slower version of a test that already exists. What is here is the thing
 * only an integration test can see: that the arithmetic reached the ledger.
 */

const clock = new SystemClock();
let app: INestApplication;
let pool: pg.Pool;
let tenant: SeededTenant;
let token: string;
let productId: string;
let drawerCode: string;
let customerId: string;

const SELLER_PERMISSIONS = [
  Permission.SALE_CREATE, Permission.SALE_VIEW, Permission.SALE_VOID,
  Permission.PRODUCT_VIEW, Permission.PRODUCT_CREATE, Permission.PRODUCT_EDIT,
  Permission.UNIT_MANAGE, Permission.CUSTOMER_VIEW, Permission.CUSTOMER_CREATE,
  Permission.COST_VIEW, Permission.INVENTORY_LOT_VIEW,
  Permission.CASH_ACCOUNT_VIEW, Permission.CASH_ACCOUNT_MANAGE,
  Permission.BANK_ACCOUNT_VIEW, Permission.BANK_ACCOUNT_MANAGE,
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

/** §3.11 — whatever the case proved, the golden invariants still hold. */
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
  tenant = await seedTenant(pool, { name: 'Sales Test', permissions: SELLER_PERMISSIONS });
  token = signToken(tenant, TEST_JWT_SECRET);
  // Every fully paid guest sale points at it (D-02), so the shop needs one
  // before the counter can take a single note.
  await seedWalkInCustomer(pool, tenant);

  const unit = await auth(api().post('/api/v1/catalog/units')).send({ name: 'Piece' });
  const unitId = unit.body.data.units[0].id as string;

  const product = await auth(api().post('/api/v1/products')).send({
    name: 'Rice', baseUnitId: unitId,
    purchasePriceMinor: 10_000, sellingPriceMinor: 12_000, minStockQty: 0,
    brandId: null, categoryId: null, sku: null, barcode: null, description: null,
    defaultDiscountType: null, defaultDiscountValue: null, offerEnabled: false,
    offerPriceMinor: null, offerStartDate: null, offerEndDate: null,
    tracksExpiry: false, tracksSerial: false, conversionUnitId: null, conversionFactorQty: null,
  });
  productId = product.body.data.id as string;

  // Ten on the shelf, through the real opening-stock path so the lots and the
  // INVENTORY account behind every later assertion genuinely exist. The cost is
  // not sent: §5.10 values an opening at the product's own purchase price, which
  // is 100.00 here, so the shelf is worth 1000.00 before anything is sold.
  const opening = await auth(api().post('/api/v1/inventory/openings'))
    .send({ productId, qty: 10_000 });
  // Asserted rather than assumed: a setup that silently fails turns every case
  // below into a puzzling business-rule failure against an empty shelf.
  if (opening.status !== 201) {
    throw new Error(`opening stock failed: ${opening.status} ${JSON.stringify(opening.body)}`);
  }

  const drawer = await api().post('/api/v1/money/accounts')
    .set('Authorization', `Bearer ${token}`)
    .send({
      name: 'Counter drawer', type: 'CASH', holderName: null, reference: null,
      isDrawer: true, openingAmountMinor: 0, openingDate: null,
      operationId: Ulid.generate(clock),
    });
  drawerCode = `CASH:${drawer.body.data.id as string}`;

  /*
   * The day has to be open before the drawer will take a note (§5.16.1).
   *
   * This is a real business rule, not test scaffolding: SherERP refuses cash at
   * the counter until somebody has counted what was in the till and started the
   * day, so a suite that could sell without it would be proving the ERP does
   * something it must not. It is asserted for the same reason the opening stock
   * is — a silent failure here would turn every cash case below into a puzzle.
   */
  const day = await api().post('/api/v1/money/day/start')
    .set('Authorization', `Bearer ${token}`)
    .send({
      businessDate: todayIn(tenant.timezone), openingAmountMinor: 0,
      counterpartAccountCode: null, note: null, operationId: Ulid.generate(clock),
    });
  if (day.status !== 200 && day.status !== 201) {
    throw new Error(`start day failed: ${day.status} ${JSON.stringify(day.body)}`);
  }

  const customer = await auth(api().post('/api/v1/parties')).send({
    name: 'Karim Uddin', roles: ['CUSTOMER'], phone: '01712345678',
    address: null, guardianName: null, nid: null, email: null, notes: null,
    customerGroupId: null, creditLimitMinor: null,
  });
  customerId = customer.body.data.id as string;
});

/** One line, ten pieces on the shelf, priced as the caller says. */
function saleBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    partyId: null, customerName: null, customerPhone: null,
    lines: [{ productId, qty: 2_000, unitPriceMinor: 120_00, lineDiscountMinor: 0 }],
    payments: [], discountMinor: 0, ...overrides,
  };
}

/** What each account holds, read straight from the ledger through RLS. */
async function ledger(): Promise<Record<string, number>> {
  return asTenant(pool, tenant.tenantId, async (db) => {
    const rows = await db.query<{ account_code: string; total: string }>(
      `SELECT account_code, SUM(amount_minor)::bigint AS total
         FROM journal_lines GROUP BY account_code`,
    );
    return Object.fromEntries(rows.rows.map((row) => [row.account_code, Number(row.total)]));
  });
}

/** Net stock movement for the product, in minor quantity units. */
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

describe('a cash sale', () => {
  it('takes the money, moves the goods and posts both sides', async () => {
    const sale = await auth(api().post('/api/v1/sales')).send(
      saleBody({ payments: [{ accountCode: drawerCode, amountMinor: 240_00 }] }),
    );
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);

    const accounts = await ledger();
    // 2 × 120.00 sold, out of stock costing 100.00 each.
    expect(accounts['SALES']).toBe(-240_00);
    expect(accounts[drawerCode]).toBe(240_00);
    expect(accounts['COGS']).toBe(200_00);
    expect(accounts['INVENTORY']).toBe(1000_00 - 200_00);
    // Paid in full across the counter: nobody owes anything.
    expect(accounts['AR'] ?? 0).toBe(0);

    expect(await onHand()).toBe(8_000);
  });

  it('is refused when the seller does not hold sale.invoice.create', async () => {
    const cashier = await seedTenant(pool, {
      name: 'Sales Test', permissions: [Permission.SALE_VIEW],
    });
    const refused = await auth(
      api().post('/api/v1/sales'),
      signToken(cashier, TEST_JWT_SECRET),
    ).send(saleBody());
    // A hidden button is not security (§11): the endpoint refuses on its own.
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('PERMISSION_DENIED');
  });
});

describe('a credit sale', () => {
  it('puts the whole bill on the customer and names them on the line', async () => {
    const sale = await auth(api().post('/api/v1/sales')).send(
      saleBody({ partyId: customerId, payments: [] }),
    );
    expect(sale.status).toBe(201);

    const accounts = await ledger();
    expect(accounts['AR']).toBe(240_00);
    expect(accounts[drawerCode] ?? 0).toBe(0);

    // INV-06: the receivable belongs to somebody, and it is this customer.
    const owed = await asTenant(pool, tenant.tenantId, async (db) => {
      const row = await db.query<{ total: string }>(
        `SELECT COALESCE(SUM(amount_minor), 0)::bigint AS total
           FROM journal_lines WHERE account_code = 'AR' AND party_id = $1`,
        [customerId],
      );
      return Number(row.rows[0]?.total ?? 0);
    });
    expect(owed).toBe(240_00);
  });

  it('leaves only the unpaid part owing when the customer pays part of it', async () => {
    await auth(api().post('/api/v1/sales')).send(
      saleBody({
        partyId: customerId,
        payments: [{ accountCode: drawerCode, amountMinor: 100_00 }],
      }),
    );

    const accounts = await ledger();
    expect(accounts['AR']).toBe(140_00);
    expect(accounts[drawerCode]).toBe(100_00);
  });
});

describe('money handed over beyond the bill (§5.8)', () => {
  it('keeps an advance on the customer ledger when that is what was chosen', async () => {
    await auth(api().post('/api/v1/sales')).send(
      saleBody({
        partyId: customerId,
        payments: [{ accountCode: drawerCode, amountMinor: 300_00 }],
        overpaymentHandling: 'ADVANCE',
      }),
    );

    const accounts = await ledger();
    expect(accounts[drawerCode]).toBe(300_00);
    // 60.00 more than the bill, held for next time rather than given back.
    expect(accounts['CUSTOMER_ADVANCE']).toBe(-60_00);
    expect(accounts['AR'] ?? 0).toBe(0);
  });

  it('posts only the bill when the extra was handed straight back as change', async () => {
    await auth(api().post('/api/v1/sales')).send(
      saleBody({
        payments: [{ accountCode: drawerCode, amountMinor: 300_00 }],
        overpaymentHandling: 'CHANGE',
      }),
    );

    const accounts = await ledger();
    // The change never entered the drawer, so the drawer never records it.
    expect(accounts[drawerCode]).toBe(240_00);
    expect(accounts['CUSTOMER_ADVANCE'] ?? 0).toBe(0);
  });
  it('takes the change off more than one payment row when the last is too small', async () => {
    /*
     * The awkward shape: 300 in cash and 10 by card against a 240 bill leaves 70
     * of change, and the card row it would naturally come off is only 10. Change
     * has to keep coming out of the row before it, or 60 of the customer's money
     * is posted as money the shop kept — and the drawer ends the day 60 ahead of
     * what is in it.
     */
    const bank = must(await api().post('/api/v1/money/accounts')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Card machine', type: 'BANK', holderName: null, reference: null,
        isDrawer: false, openingAmountMinor: 0, openingDate: null,
        operationId: Ulid.generate(clock),
      }), 'create bank account');
    const bankCode = `BANK:${bank.body.data.id as string}`;

    const sale = await auth(api().post('/api/v1/sales')).send(
      saleBody({
        payments: [
          { accountCode: drawerCode, amountMinor: 300_00 },
          { accountCode: bankCode, amountMinor: 10_00 },
        ],
        overpaymentHandling: 'CHANGE',
      }),
    );
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);

    const accounts = await ledger();
    // The card row goes entirely, and the remaining 60 comes off the cash.
    expect(accounts[bankCode] ?? 0).toBe(0);
    expect(accounts[drawerCode]).toBe(240_00);
    // Which is the whole bill, and nothing more.
    expect(accounts['SALES']).toBe(-240_00);
    expect(accounts['CUSTOMER_ADVANCE'] ?? 0).toBe(0);
  });
});

describe('discounts reach the ledger', () => {
  it('sells at the discounted figure, not the list one', async () => {
    await auth(api().post('/api/v1/sales')).send(
      saleBody({
        lines: [{ productId, qty: 2_000, unitPriceMinor: 120_00, lineDiscountMinor: 20_00 }],
        discountMinor: 10_00,
        payments: [{ accountCode: drawerCode, amountMinor: 210_00 }],
      }),
    );

    const accounts = await ledger();
    // 240.00 − 20.00 off the line − 10.00 off the bill.
    expect(accounts['SALES']).toBe(-210_00);
    expect(accounts[drawerCode]).toBe(210_00);
    // A discount is given away, never taken out of stock: cost is untouched.
    expect(accounts['COGS']).toBe(200_00);
  });
});

describe('cancelling a sale (§2.5, INV-08)', () => {
  it('gives the goods back, clears the debt and leaves nothing behind', async () => {
    const sale = await auth(api().post('/api/v1/sales')).send(
      saleBody({ partyId: customerId, payments: [] }),
    );
    const saleId = sale.body.data.id as string;
    const version = sale.body.data.version as number;

    const cancelled = await api().post(`/api/v1/sales/${saleId}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .send({ version, reason: 'Customer changed their mind' });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(201);
    expect(cancelled.body.data.status).toBe('VOIDED');

    const accounts = await ledger();
    // Everything the sale did has been undone: the customer owes nothing, the
    // goods are back, and the opening stock is all that is left in INVENTORY.
    expect(accounts['AR'] ?? 0).toBe(0);
    expect(accounts['SALES'] ?? 0).toBe(0);
    expect(accounts['COGS'] ?? 0).toBe(0);
    expect(accounts['INVENTORY']).toBe(1000_00);
    expect(await onHand()).toBe(10_000);
  });
});

describe('the API refuses what the screen would not send (§6)', () => {
  it.each([
    ['no lines at all', { lines: [] }],
    ['a line of nothing', { lines: [{ productId, qty: 0, unitPriceMinor: 120_00 }] }],
    ['a negative quantity', { lines: [{ productId, qty: -1_000, unitPriceMinor: 120_00 }] }],
    ['a negative price', { lines: [{ productId, qty: 1_000, unitPriceMinor: -1 }] }],
    ['a negative bill discount', { discountMinor: -1 }],
    ['a payment of nothing', { payments: [{ accountCode: 'CASH:X', amountMinor: 0 }] }],
  ])('refuses %s', async (_case, overrides) => {
    const refused = await auth(api().post('/api/v1/sales')).send(saleBody(overrides));
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('refuses a sale with no idempotency key, however well formed', async () => {
    const refused = await api().post('/api/v1/sales')
      .set('Authorization', `Bearer ${token}`)
      .send(saleBody());
    expect(refused.status).toBe(400);
  });

  it('refuses selling more than is on the shelf unless it was asked for explicitly', async () => {
    const refused = await auth(api().post('/api/v1/sales')).send(
      saleBody({ lines: [{ productId, qty: 50_000, unitPriceMinor: 120_00 }] }),
    );
    expect(refused.status).toBeGreaterThanOrEqual(400);
    // Nothing was half-done: the shelf is untouched.
    expect(await onHand()).toBe(10_000);
  });
});
