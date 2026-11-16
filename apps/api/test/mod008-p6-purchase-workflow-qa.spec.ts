/*
 * MOD-008 P6: real Nest/PostgreSQL purchasing-source QA.
 *
 * @covers endpoint:POST /api/v1/purchases
 * @covers endpoint:GET /api/v1/purchases
 * @covers endpoint:GET /api/v1/purchases/:id
 * @covers permission:purchase.bill.create
 *
 * Use ONLY with the dedicated, labelled disposable P6 PostgreSQL16 container.
 * Never connect a retained shop DB; real purchase journal/stock writes are
 * created ONLY inside the disposable test tenant and reset between cases.
 * The existing production purchasing contracts remain unchanged.
 * Opt-in: HISABIQ_P6_DISPOSABLE_ACK=isolated-pg16-only; skipped in ordinary CI.
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
const MISSING_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAX';
const PERMISSIONS = [
  Permission.PURCHASE_CREATE, Permission.PURCHASE_VIEW,
  Permission.PRODUCT_VIEW, Permission.PRODUCT_CREATE,
  Permission.PRODUCT_EDIT, Permission.PRODUCT_DEACTIVATE,
  Permission.UNIT_MANAGE, Permission.SUPPLIER_VIEW,
  Permission.SUPPLIER_CREATE, Permission.CUSTOMER_CREATE,
  Permission.CUSTOMER_VIEW, Permission.COST_VIEW,
  // P6 void dependency QA exercises existing signed Class-T routes only.
  Permission.PURCHASE_VOID, Permission.PURCHASE_PAY,
  Permission.PURCHASE_RETURN_CREATE, Permission.PURCHASE_RETURN_VIEW,
  Permission.CASH_ACCOUNT_VIEW, Permission.CASH_ACCOUNT_MANAGE,
  Permission.BANK_ACCOUNT_VIEW, Permission.BANK_ACCOUNT_MANAGE,
];

let app: INestApplication;
let pool: pg.Pool;
let a: SeededTenant;
let b: SeededTenant;
let tokenA: string;
let tokenB: string;
let productId: string;
let supplierId: string;
let customerId: string;

function checkDisposable(): void {
  const expected = {
    DATABASE_URL: 'postgres://sher_app:sher_app_test@127.0.0.1:55713/sher_test',
    ADMIN_DATABASE_URL: 'postgres://postgres:dev@127.0.0.1:55713/sher_test',
    JWT_SECRET: TEST_JWT_SECRET,
    HISABIQ_P6_DISPOSABLE_ACK: 'isolated-pg16-only',
  };
  for (const [key, value] of Object.entries(expected)) {
    if (process.env[key] !== value) throw Error('P6 isolated database/secret guard failed: ' + key);
  }
  const checked = spawnSync('podman', ['inspect', '--format',
    '{{index .Config.Labels "hisabiq.qa"}}|{{.State.Running}}',
    'hisabiq-mod008-p6-due-313-pg16'], { encoding: 'utf8' });
  if (checked.status !== 0 || checked.stdout.trim() !== 'mod008-p6-due-313|true') {
    throw Error('P6 task-owned disposable PostgreSQL label/running guard failed');
  }
}

const api = () => request(app.getHttpServer());
const bearer = (token: string) => ({ Authorization: 'Bearer ' + token });
const post = (path: string, body: unknown, token = tokenA, key = Ulid.generate(clock)) =>
  api().post(path).set(bearer(token)).set('Idempotency-Key', key).send(body as object);
const bill = (overrides: Record<string, unknown> = {}) => ({
  supplierPartyId: supplierId,
  lines: [{ productId, qty: 1_000, unitPriceMinor: 10_000 }],
  discountMinor: 0, paidMinor: 0, paidAccountCode: null, ...overrides,
});

async function postingRows(tenant: SeededTenant) {
  return asTenant(pool, tenant.tenantId, async db => {
    const counts = await db.query(`SELECT
      (SELECT count(*)::int FROM purchases) purchases,
      (SELECT count(*)::int FROM journal_entries) journals,
      (SELECT count(*)::int FROM stock_movements) stocks,
      (SELECT count(*)::int FROM inventory_lots) lots,
      (SELECT count(*)::int FROM supplier_payments) payments`);
    return counts.rows[0] as {
      purchases: number; journals: number; stocks: number;
      lots: number; payments: number;
    };
  });
}
const zero = { purchases: 0, journals: 0, stocks: 0, lots: 0, payments: 0 };

/**
 * Baseline all tenant-visible write sources before a deliberately rejected
 * advanced transport request. Fixture creation may have already written audit
 * and outbox rows, so compare before/after rather than asserting zero there.
 */
async function purchaseMutationSnapshot(tenant: SeededTenant) {
  return asTenant(pool, tenant.tenantId, async db => {
    const rows = await db.query<{
      purchases: number; purchaseLines: number; journals: number;
      journalLines: number; stocks: number; lots: number;
      supplierPayments: number; purchaseReturns: number;
      paymentAllocations: number; cashMovements: number;
      audits: number; outbox: number;
    }>(`SELECT
      (SELECT count(*)::int FROM purchases) AS purchases,
      (SELECT count(*)::int FROM purchase_lines) AS "purchaseLines",
      (SELECT count(*)::int FROM journal_entries) AS journals,
      (SELECT count(*)::int FROM journal_lines) AS "journalLines",
      (SELECT count(*)::int FROM stock_movements) AS stocks,
      (SELECT count(*)::int FROM inventory_lots) AS lots,
      (SELECT count(*)::int FROM supplier_payments) AS "supplierPayments",
      (SELECT count(*)::int FROM purchase_returns) AS "purchaseReturns",
      (SELECT count(*)::int FROM payment_allocations) AS "paymentAllocations",
      (SELECT count(*)::int FROM cash_movements) AS "cashMovements",
      (SELECT count(*)::int FROM audit_events) AS audits,
      (SELECT count(*)::int FROM outbox) AS outbox`);
    return rows.rows[0];
  });
}

/** Verify each real journal entry balances without undeclared workspace imports. */
async function assertBalancedEntries(tenant: SeededTenant) {
  const imbalances = await asTenant(pool, tenant.tenantId, async db => {
    const found = await db.query(`
      SELECT journal_entry_id, sum(amount_minor)::bigint AS imbalance
      FROM journal_lines GROUP BY journal_entry_id
      HAVING sum(amount_minor) <> 0`);
    return found.rows;
  });
  expect(imbalances).toEqual([]);
}

const p6Suite = process.env.HISABIQ_P6_DISPOSABLE_ACK === 'isolated-pg16-only'
  ? describe : describe.skip;
p6Suite('MOD-008 P6 real source/financial acceptance', () => {
beforeAll(async () => {
  checkDisposable();
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
  a = await seedTenant(pool, { name: 'P6 isolated supplier shop A', permissions: PERMISSIONS });
  b = await seedTenant(pool, { name: 'P6 isolated other shop B', permissions: PERMISSIONS });
  tokenA = signToken(a, TEST_JWT_SECRET);
  tokenB = signToken(b, TEST_JWT_SECRET);

  const units = await post('/api/v1/catalog/units', { name: 'Piece' });
  expect(units.status).toBe(201);
  const unitId = units.body.data.units[0].id as string;
  const product = await post('/api/v1/products', {
    name: 'P6 Stock Item', baseUnitId: unitId,
    purchasePriceMinor: 10_000, sellingPriceMinor: 12_000, minStockQty: 0,
    brandId: null, categoryId: null, sku: null, barcode: null,
    description: null, defaultDiscountType: null, defaultDiscountValue: null,
    offerEnabled: false, offerPriceMinor: null,
    offerStartDate: null, offerEndDate: null,
    tracksExpiry: false, tracksSerial: false,
    conversionUnitId: null, conversionFactorQty: null,
  });
  expect(product.status).toBe(201);
  productId = product.body.data.id as string;
  const supplier = await post('/api/v1/parties', {
    name: 'P6 Supplier A', roles: ['SUPPLIER'], phone: null, address: null,
    guardianName: null, nid: null, email: null, notes: null,
    customerGroupId: null, creditLimitMinor: null,
  });
  expect(supplier.status).toBe(201);
  supplierId = supplier.body.data.id as string;
  const customer = await post('/api/v1/parties', {
    name: 'P6 Customer A', roles: ['CUSTOMER'], phone: '01790000123', address: null,
    guardianName: null, nid: null, email: null, notes: null,
    customerGroupId: null, creditLimitMinor: null,
  });
  expect(customer.status).toBe(201);
  customerId = customer.body.data.id as string;
}, 45_000);

  it.each([
    ['missing supplier', () => bill({ supplierPartyId: MISSING_ID })],
    ['wrong-role customer', () => bill({ supplierPartyId: customerId })],
    ['missing product', () => bill({ lines: [{ productId: MISSING_ID, qty: 1_000, unitPriceMinor: 10_000 }] })],
    ['overpayment', () => bill({ paidMinor: 10_001, paidAccountCode: null })],
  ])('rejects %s without creating financial, lot or payment rows', async (_label, makeBody) => {
    expect(await postingRows(a)).toEqual(zero);
    const result = await post('/api/v1/purchases', makeBody());
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.status).toBeLessThan(500);
    expect(await postingRows(a)).toEqual(zero);
    await assertBalancedEntries(a);
  }, 35_000);

  it('rejects inactive product and preserves an empty posting ledger', async () => {
    const changed = await post('/api/v1/products/' + productId + '/status',
      { status: 'INACTIVE' });
    expect(changed.status).toBe(200);
    const refused = await post('/api/v1/purchases', bill());
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.status).toBeLessThan(500);
    expect(await postingRows(a)).toEqual(zero);
  }, 35_000);

  it('enforces PostgreSQL tenant isolation on purchase list, detail and foreign source create', async () => {
    const created = await post('/api/v1/purchases', bill());
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.data.id as string;
    const listB = await api().get('/api/v1/purchases').set(bearer(tokenB));
    expect(listB.status).toBe(200);
    expect(listB.body.data).toEqual([]);
    const detailB = await api().get('/api/v1/purchases/' + id).set(bearer(tokenB));
    expect(detailB.status).toBe(404);
    const cross = await post('/api/v1/purchases', bill(), tokenB);
    expect(cross.status).toBeGreaterThanOrEqual(400);
    expect(cross.status).toBeLessThan(500);
    expect(await postingRows(b)).toEqual(zero);
    expect((await postingRows(a)).purchases).toBe(1);
    await assertBalancedEntries(a);
    await assertBalancedEntries(b);
  }, 35_000);

  it('reads a signed posted purchase from the owning list and detail without mutation', async () => {
    const created = await post('/api/v1/purchases', bill({ discountMinor: 750 }));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.data.id as string;
    const beforeA = await purchaseMutationSnapshot(a);
    const beforeB = await purchaseMutationSnapshot(b);

    const list = await api().get('/api/v1/purchases?limit=25').set(bearer(tokenA));
    const detail = await api().get('/api/v1/purchases/' + id).set(bearer(tokenA));
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    const row = (list.body.data as Array<{
      id: string; supplierName: string; status: string; number: string;
    }>).find(source => source.id === id);
    expect(row).toMatchObject({
      id, status: 'POSTED', supplierName: 'P6 Supplier A',
    });
    expect(detail.body.data).toMatchObject({
      id, supplierPartyId: supplierId, grandTotalMinor: 9_250,
    });
    expect(detail.body.data.lines).toHaveLength(1);
    expect(detail.body.data.lines[0].productId).toBe(productId);
    expect(detail.body.data.number).toBe(row?.number);

    const listReplay = await api().get('/api/v1/purchases?limit=25').set(bearer(tokenA));
    const detailReplay = await api().get('/api/v1/purchases/' + id).set(bearer(tokenA));
    expect(listReplay.status).toBe(200);
    expect(detailReplay.status).toBe(200);
    expect(listReplay.body).toEqual(list.body);
    expect(detailReplay.body).toEqual(detail.body);
    expect(await purchaseMutationSnapshot(a)).toEqual(beforeA);
    expect(await purchaseMutationSnapshot(b)).toEqual(beforeB);
    await assertBalancedEntries(a);
  }, 35_000);

  it('fails closed for unsigned, missing and foreign posted purchase reads', async () => {
    const posted = await post('/api/v1/purchases', bill());
    expect(posted.status, JSON.stringify(posted.body)).toBe(201);
    const id = posted.body.data.id as string;
    const beforeA = await purchaseMutationSnapshot(a);
    const beforeB = await purchaseMutationSnapshot(b);
    const anonymous = await api().get('/api/v1/purchases/' + id);
    const malformed = await api().get('/api/v1/purchases/' + id)
      .set({ Authorization: 'Bearer invalid' });
    const missing = await api().get('/api/v1/purchases/' + MISSING_ID)
      .set(bearer(tokenA));
    const foreign = await api().get('/api/v1/purchases/' + id).set(bearer(tokenB));
    const foreignList = await api().get('/api/v1/purchases?limit=25')
      .set(bearer(tokenB));
    expect(anonymous.status).toBe(401);
    expect(malformed.status).toBe(401);
    expect(missing.status).toBe(404);
    expect(foreign.status).toBe(404);
    expect(foreignList.status).toBe(200);
    expect(foreignList.body.data).toEqual([]);
    for (const denied of [anonymous, malformed, missing, foreign]) {
      expect(JSON.stringify(denied.body)).not.toContain(id);
      expect(JSON.stringify(denied.body)).not.toContain('P6 Supplier A');
    }
    expect(await purchaseMutationSnapshot(a)).toEqual(beforeA);
    expect(await purchaseMutationSnapshot(b)).toEqual(beforeB);
    await assertBalancedEntries(a);
    await assertBalancedEntries(b);
  }, 35_000);

  it('posts discounted purchase exactly once with balanced inventory and AP', async () => {
    const response = await post('/api/v1/purchases', bill({ discountMinor: 2_000 }));
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.data.grandTotalMinor).toBe(8_000);
    const totals = await asTenant(pool, a.tenantId, async db => {
      const result = await db.query<{account_code:string; net:string}>(`
        SELECT account_code, sum(amount_minor)::bigint AS net
        FROM journal_lines WHERE account_code IN ('INVENTORY', 'AP')
        GROUP BY account_code`);
      return Object.fromEntries(result.rows.map(row => [row.account_code, Number(row.net)]));
    });
    expect(totals).toEqual({ INVENTORY: 8_000, AP: -8_000 });
    expect((await postingRows(a)).purchases).toBe(1);
    await assertBalancedEntries(a);
  }, 35_000);

  it('replays the same signed creation intent without duplicating stock or AP', async () => {
    const key = Ulid.generate(clock);
    const payload = bill();
    const first = await post('/api/v1/purchases', payload, tokenA, key);
    expect(first.status).toBe(201);
    const again = await post('/api/v1/purchases', payload, tokenA, key);
    expect(again.status).toBe(201);
    expect(again.body.data.id).toBe(first.body.data.id);
    const changed = await post('/api/v1/purchases', bill({ discountMinor: 100 }), tokenA, key);
    expect(changed.status).toBe(409);
    const counts = await postingRows(a);
    expect(counts).toMatchObject({ purchases: 1, journals: 1, stocks: 1, lots: 1 });
    await assertBalancedEntries(a);
  }, 35_000);

  it('refuses unsupported advanced split payments and independent unit parts before posting', async () => {
    const unsupported = [
      bill({ payments: [{ accountCode: 'CASH:unknown', amountMinor: 1_000 }] }),
      bill({ lines: [{ productId, unitParts: [{ unitId: MISSING_ID,
        quantityMilli: 1_000, unitPriceTakaX10000: 100_000 }] }] }),
    ];
    for (const body of unsupported) {
      const refused = await post('/api/v1/purchases', body);
      expect(refused.status).toBe(400);
      expect(refused.body.error.code).toBe('VALIDATION_FAILED');
      expect(await postingRows(a)).toEqual(zero);
    }
  }, 35_000);

  it.each([
    ['standalone canonical unpaid paymentLegs array', () => ({
      supplierPartyId: supplierId, lines: [{ productId, qty: 1_000, unitPriceMinor: 10_000 }],
      discountMinor: 0, paymentLegs: [],
    })],
    ['standalone canonical CASH+BANK split payments', () => ({
      supplierPartyId: supplierId, lines: [{ productId, qty: 1_000, unitPriceMinor: 10_000 }],
      discountMinor: 0, paymentLegs: [
        { accountCode: 'CASH:' + MISSING_ID, amountMinor: 2_000 },
        { accountCode: 'BANK:01ARZ3NDEKTSV4RRFFQ69G5FAY', amountMinor: 1_000 },
      ],
    })],
    ['canonical MFS-only paymentLegs', () => ({
      supplierPartyId: supplierId, lines: [{ productId, qty: 1_000, unitPriceMinor: 10_000 }],
      discountMinor: 0, paymentLegs: [
        { accountCode: 'MFS:' + MISSING_ID, amountMinor: 1_000 },
      ],
    })],
    ['mixed legacy paidMinor/paidAccountCode and canonical paymentLegs', () =>
      bill({ paymentLegs: [{ accountCode: 'CASH:' + MISSING_ID, amountMinor: 1_000 }] })],
  ])('rejects %s in the unactivated live API without any tenant write', async (_label, requestBody) => {
    // This proves present-day strict rejection; it is NOT a green split-payment
    // posting test. Legacy one-account purchase behavior remains unchanged.
    const beforeA = await purchaseMutationSnapshot(a);
    const beforeB = await purchaseMutationSnapshot(b);
    expect(await postingRows(a)).toEqual(zero);
    const refused = await post('/api/v1/purchases', requestBody());
    expect(refused.status, JSON.stringify(refused.body)).toBe(400);
    expect(refused.body.error.code).toBe('VALIDATION_FAILED');
    expect(await purchaseMutationSnapshot(a)).toEqual(beforeA);
    expect(await purchaseMutationSnapshot(b)).toEqual(beforeB);
    expect(await postingRows(a)).toEqual(zero);
    await assertBalancedEntries(a);
    await assertBalancedEntries(b);
  }, 35_000);

  it('derives supplier due from each posted unpaid bill and never posts money for a GET', async () => {
    const full = await post('/api/v1/purchases', bill());
    const discounted = await post('/api/v1/purchases', bill({ discountMinor: 1_250 }));
    expect(full.status, JSON.stringify(full.body)).toBe(201);
    expect(discounted.status, JSON.stringify(discounted.body)).toBe(201);

    // The source of truth is two posted bills: 10000 + (10000 - 1250).
    // A read must not allocate, receive or settle either amount.
    const before = await purchaseMutationSnapshot(a);
    const firstRead = await api().get('/api/v1/suppliers/' + supplierId + '/due')
      .set(bearer(tokenA));
    const repeatRead = await api().get('/api/v1/suppliers/' + supplierId + '/due')
      .set(bearer(tokenA));
    expect(firstRead.status, JSON.stringify(firstRead.body)).toBe(200);
    expect(repeatRead.status).toBe(200);
    expect(repeatRead.body).toEqual(firstRead.body);
    expect(firstRead.body.data.supplierPartyId).toBe(supplierId);
    expect(firstRead.body.data.outstandingMinor).toBe(18_750);
    expect(firstRead.body.data.bills).toHaveLength(2);
    expect(Object.fromEntries(firstRead.body.data.bills.map(
      (source: { id: string; dueMinor: number }) => [source.id, source.dueMinor],
    ))).toEqual({
      [full.body.data.id as string]: 10_000,
      [discounted.body.data.id as string]: 8_750,
    });
    expect((await postingRows(a)).payments).toBe(0);
    expect(await purchaseMutationSnapshot(a)).toEqual(before);
    await assertBalancedEntries(a);
  }, 35_000);

  it('hides supplier due and bill references from a foreign tenant without mutation', async () => {
    const posted = await post('/api/v1/purchases', bill());
    expect(posted.status, JSON.stringify(posted.body)).toBe(201);
    const beforeA = await purchaseMutationSnapshot(a);
    const beforeB = await purchaseMutationSnapshot(b);

    const foreign = await api().get('/api/v1/suppliers/' + supplierId + '/due')
      .set(bearer(tokenB));
    expect(foreign.status).toBe(404);
    expect(JSON.stringify(foreign.body)).not.toContain(posted.body.data.id as string);
    expect(JSON.stringify(foreign.body)).not.toContain('P6 Supplier A');
    expect(await purchaseMutationSnapshot(a)).toEqual(beforeA);
    expect(await purchaseMutationSnapshot(b)).toEqual(beforeB);
    await assertBalancedEntries(a);
    await assertBalancedEntries(b);
  }, 35_000);

  it('does not treat a CUSTOMER-only Party as a supplier with payable records', async () => {
    const before = await purchaseMutationSnapshot(a);
    const wrongRole = await api().get('/api/v1/suppliers/' + customerId + '/due')
      .set(bearer(tokenA));
    expect(wrongRole.status).toBe(404);
    expect(wrongRole.body.data).toBeUndefined();
    expect(await purchaseMutationSnapshot(a)).toEqual(before);
    expect(await postingRows(a)).toEqual(zero);
  }, 35_000);

  it('refuses void after a source-allocated supplier payment without any reversal', async () => {
    // Historical opening balance is an account fixture, not an active drawer.
    const bank = await post('/api/v1/money/accounts', {
      name: 'P6 settlement source bank', type: 'BANK', holderName: 'P6 Shop',
      reference: null, isDrawer: false, openingAmountMinor: 20_000,
      openingDate: '2026-01-01', operationId: Ulid.generate(clock),
    });
    expect(bank.status, JSON.stringify(bank.body)).toBe(201);
    const accountCode = 'BANK:' + (bank.body.data.id as string);
    const created = await post('/api/v1/purchases', bill());
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const purchaseId = created.body.data.id as string;
    const version = created.body.data.version as number;

    const payment = await post('/api/v1/suppliers/payments', {
      supplierPartyId: supplierId, purchaseId, amountMinor: 2_500,
      accountCode, note: null,
    });
    expect(payment.status, JSON.stringify(payment.body)).toBe(201);
    const due = await api().get('/api/v1/suppliers/' + supplierId + '/due')
      .set(bearer(tokenA));
    expect(due.status).toBe(200);
    expect(due.body.data.outstandingMinor).toBe(7_500);
    const beforeA = await purchaseMutationSnapshot(a);
    const beforeB = await purchaseMutationSnapshot(b);
    expect(beforeA.paymentAllocations).toBe(1);
    expect(beforeA.supplierPayments).toBe(1);

    const refused = await post('/api/v1/purchases/' + purchaseId + '/void',
      { version, reason: 'Cannot cancel an allocated payment' });
    expect(refused.status, JSON.stringify(refused.body)).toBe(400);
    expect(refused.body.error?.code).toBe('VALIDATION_FAILED');
    const foreign = await post('/api/v1/purchases/' + purchaseId + '/void',
      { version, reason: 'Other tenant must not reverse' }, tokenB);
    expect(foreign.status).toBe(404);
    expect(JSON.stringify(foreign.body)).not.toContain(purchaseId);
    expect(await purchaseMutationSnapshot(a)).toEqual(beforeA);
    expect(await purchaseMutationSnapshot(b)).toEqual(beforeB);
    await assertBalancedEntries(a);
    await assertBalancedEntries(b);
  }, 45_000);

  it('refuses void after partial supplier return consumes source stock without mutation', async () => {
    const created = await post('/api/v1/purchases', bill({
      lines: [{ productId, qty: 5_000, unitPriceMinor: 1_000 }],
    }));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const purchaseId = created.body.data.id as string;
    const lineId = created.body.data.lines[0].id as string;
    const version = created.body.data.version as number;
    const returned = await post('/api/v1/purchase-returns', {
      purchaseId, lines: [{ sourceLineId: lineId, qty: 1_000 }],
      reason: 'DAMAGED', note: null, receivedMinor: 0, receiptAccountCode: null,
    });
    expect(returned.status, JSON.stringify(returned.body)).toBe(201);
    const before = await purchaseMutationSnapshot(a);
    expect(before.purchaseReturns).toBe(1);
    const refused = await post('/api/v1/purchases/' + purchaseId + '/void',
      { version, reason: 'Return already references a consumed receipt lot' });
    expect(refused.status, JSON.stringify(refused.body)).toBe(400);
    expect(refused.body.error?.code).toBe('VALIDATION_FAILED');
    expect(await purchaseMutationSnapshot(a)).toEqual(before);
    await assertBalancedEntries(a);
  }, 45_000);

  it('voids a clean unpaid bill exactly once and rejects stale, foreign and repeated reversal', async () => {
    const created = await post('/api/v1/purchases', bill());
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const purchaseId = created.body.data.id as string;
    const version = created.body.data.version as number;
    const before = await purchaseMutationSnapshot(a);
    const beforeB = await purchaseMutationSnapshot(b);

    const stale = await post('/api/v1/purchases/' + purchaseId + '/void',
      { version: version + 1, reason: 'Stale editor version' });
    expect(stale.status).toBeGreaterThanOrEqual(400);
    expect(stale.status).toBeLessThan(500);
    const foreign = await post('/api/v1/purchases/' + purchaseId + '/void',
      { version, reason: 'Other tenant denial' }, tokenB);
    expect(foreign.status).toBe(404);
    expect(await purchaseMutationSnapshot(a)).toEqual(before);
    expect(await purchaseMutationSnapshot(b)).toEqual(beforeB);

    const voided = await post('/api/v1/purchases/' + purchaseId + '/void',
      { version, reason: 'Duplicate receiving record' });
    expect(voided.status, JSON.stringify(voided.body)).toBe(201);
    expect(voided.body.data.status).toBe('VOIDED');
    const after = await purchaseMutationSnapshot(a);
    expect(after.purchases).toBe(1);
    expect(after.journals).toBe(before.journals + 1);
    expect(after.stocks).toBe(before.stocks + 1);
    expect(after.lots).toBe(before.lots);
    expect(after.supplierPayments).toBe(0);
    expect(after.paymentAllocations).toBe(0);
    expect(after.purchaseReturns).toBe(0);

    const totals = await asTenant(pool, a.tenantId, async db =>
      (await db.query<{ account_code: string; total: string }>(`
        SELECT account_code, sum(amount_minor)::bigint AS total
        FROM journal_lines WHERE account_code IN ('AP', 'INVENTORY')
        GROUP BY account_code`)).rows);
    expect(totals.every(row => Number(row.total) === 0)).toBe(true);
    const due = await api().get('/api/v1/suppliers/' + supplierId + '/due')
      .set(bearer(tokenA));
    expect(due.status).toBe(200);
    expect(due.body.data.outstandingMinor).toBe(0);

    const repeated = await post('/api/v1/purchases/' + purchaseId + '/void',
      { version, reason: 'Must not reverse twice' });
    expect(repeated.status).toBe(400);
    expect(await purchaseMutationSnapshot(a)).toEqual(after);
    expect(await purchaseMutationSnapshot(b)).toEqual(beforeB);
    await assertBalancedEntries(a);
    await assertBalancedEntries(b);
  }, 45_000);

  it('validates list query keys rather than treating arbitrary filters as trusted', async () => {
    const response = await api().get('/api/v1/purchases?surpriseFilter=TRUE')
      .set(bearer(tokenA));
    expect(response.status).toBe(400);
    expect(await postingRows(a)).toEqual(zero);
  }, 35_000);
});
