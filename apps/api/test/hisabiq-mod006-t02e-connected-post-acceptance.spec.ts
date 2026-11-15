/**
 * MOD-006 T02-E — signed Counter GET → single source-owned POST → GET acceptance.
 *
 * Never run against a retained/shared database. This is NOT a browser-mounted
 * Counter or an authorization to post real merchant money.
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
const DATABASE = 'hisabiq_mod006_t02e_post_20261115';
const PORT = '55778';
const SENTINEL = 'MOD006_T02E_DISPOSABLE_20261115';
const suite = process.env['MOD006_T02E_TEST_ONLY'] === SENTINEL ? describe : describe.skip;
const GRANTS = [
  Permission.CUSTOMER_VIEW, Permission.CUSTOMER_CREATE,
  Permission.SUPPLIER_VIEW, Permission.SUPPLIER_CREATE,
  Permission.SALE_RECEIVE_PAYMENT, Permission.PURCHASE_PAY,
  Permission.CASH_ACCOUNT_VIEW, Permission.CASH_ACCOUNT_MANAGE,
  Permission.BANK_ACCOUNT_VIEW, Permission.BANK_ACCOUNT_MANAGE,
  Permission.SETTING_VIEW, Permission.SETTING_EDIT, Permission.SETTING_TOGGLE,
  Permission.PURCHASE_CREATE, Permission.PURCHASE_VIEW,
  Permission.PRODUCT_VIEW, Permission.PRODUCT_CREATE, Permission.PRODUCT_EDIT,
  Permission.UNIT_MANAGE, Permission.COST_VIEW, Permission.INVENTORY_LOT_VIEW,
];
let app: INestApplication;
let pool: pg.Pool;
let shop: SeededTenant;
let token: string;
let bankId: string;
let mfsId: string;
const uid = () => Ulid.generate(clock);
const api = () => request(app.getHttpServer());
const bearer = (as = token) => ({ Authorization: 'Bearer ' + as });
const signed = (r: request.Test, key = uid(), as = token): request.Test =>
  r.set(bearer(as)).set('Idempotency-Key', key);
const who = (as = token) => api().get('/api/v1/me').set(bearer(as));
const sourceList = (as = token) => api().get('/api/v1/money/accounts').set(bearer(as));
const partyDetail = (id: string, role: 'CUSTOMER' | 'SUPPLIER', as = token) =>
  api().get('/api/v2/parties/' + id + '?role=' + role).set(bearer(as));

function requireIsolatedDatabase(): void {
  if (process.env['MOD006_T02E_TEST_ONLY'] !== SENTINEL) {
    throw new Error('T02-E refuses to run without exact disposable sentinel');
  }
  for (const key of ['DATABASE_URL', 'TEST_DATABASE_URL', 'ADMIN_DATABASE_URL']) {
    const raw = process.env[key];
    if (!raw) throw new Error('Missing disposable test URL ' + key);
    const uri = new URL(raw);
    const role = key === 'ADMIN_DATABASE_URL' ? 'postgres' : 'sher_app';
    if (uri.protocol !== 'postgres:' || uri.hostname !== '127.0.0.1' ||
        uri.port !== PORT || uri.pathname !== '/' + DATABASE || uri.username !== role) {
      throw new Error('Refusing a shared, external or privileged application DB');
    }
  }
}
function created(r: request.Response, context: string): request.Response {
  expect(r.status, context + ': ' + JSON.stringify(r.body)).toBe(201);
  return r;
}
async function setBankEnabled(): Promise<void> {
  const r = await signed(api().post('/api/v1/settings/value'))
    .send({ key: 'bank_accounts_enabled', value: 'on' });
  created(r, 'enable source bank accounts');
}
async function account(
  type: 'BANK' | 'MFS',
  opening: number,
): Promise<string> {
  const operationId = uid();
  const result = await signed(api().post('/api/v1/money/accounts'), operationId).send({
    name: 'T02E ' + type + ' source', type, holderName: null, reference: null,
    isDrawer: false, openingAmountMinor: opening, openingDate: '2026-01-01',
    operationId,
  });
  created(result, type + ' account');
  return result.body.data.id as string;
}
async function tradingParty(
  role: 'CUSTOMER' | 'SUPPLIER',
): Promise<string> {
  const r = await signed(api().post('/api/v1/parties')).send({
    name: 'T02E ' + role + ' trading party', roles: [role], phone: '01712345678',
    address: null, guardianName: null, nid: null, email: null, notes: null,
    customerGroupId: null, creditLimitMinor: null,
  });
  created(r, role + ' trading Party');
  return r.body.data.id as string;
}
async function unpaidPurchase(supplierPartyId: string): Promise<void> {
  const unit = created(await signed(api().post('/api/v1/catalog/units'))
    .send({name:'Piece'}), 'unit');
  const product = created(await signed(api().post('/api/v1/products')).send({
    name: 'T02E Test Item', baseUnitId: unit.body.data.units[0].id as string,
    purchasePriceMinor: 10_000, sellingPriceMinor: 12_000, minStockQty: 0,
    brandId: null, categoryId: null, sku: null, barcode: null, description: null,
    defaultDiscountType: null, defaultDiscountValue: null, offerEnabled: false,
    offerPriceMinor: null, offerStartDate: null, offerEndDate: null,
    tracksExpiry: false, tracksSerial: false,
    conversionUnitId: null, conversionFactorQty: null,
  }), 'product');
  created(await signed(api().post('/api/v1/purchases')).send({
    supplierPartyId,
    lines: [{productId:product.body.data.id as string, qty:10_000, unitPriceMinor:10_000}],
    discountMinor:0, paidMinor:0, paidAccountCode:null,
  }), 'unpaid purchase');
}
function accountFrom(body: unknown, accountId: string): {balanceMinor:number;type:string;status:string} {
  const accounts = (body as {accounts:Array<{id:string;balanceMinor:number;type:string;status:string}>}).accounts;
  const value = accounts.find(a=>a.id===accountId);
  expect(value, 'signed source account must exist').toBeDefined();
  return value!;
}
async function dbSnapshot(): Promise<{
  entries:number; lines:number; customers:number; suppliers:number; sessions:number;
  totals:Record<string,number>;
}> {
  return asTenant(pool, shop.tenantId, async db=>{
    const n = await db.query<{
      entries:number; lines:number; customers:number; suppliers:number; sessions:number;
    }>(
      'SELECT (SELECT COUNT(*)::int FROM journal_entries) entries, ' +
      '(SELECT COUNT(*)::int FROM journal_lines) lines, ' +
      '(SELECT COUNT(*)::int FROM customer_receipts) customers, ' +
      '(SELECT COUNT(*)::int FROM supplier_payments) suppliers, ' +
      '(SELECT COUNT(*)::int FROM cash_sessions) sessions',
    );
    const j = await db.query<{account_code:string;net:string}>(
      'SELECT account_code,SUM(amount_minor)::bigint AS net FROM journal_lines GROUP BY account_code',
    );
    return {
      ...n.rows[0]!,
      totals:Object.fromEntries(j.rows.map(r=>[r.account_code,Number(r.net)])),
    };
  });
}
async function removePermission(code: string): Promise<void> {
  await asTenant(pool, shop.tenantId, db=>db.query(
    'DELETE FROM role_permissions WHERE tenant_id=$1 AND role_id=$2 AND permission_code=$3',
    [shop.tenantId,shop.roleId,code],
  ));
}
function customerPost(
  partyId:string, amountMinor:number, key=uid(), sourceId=bankId, as=token,
): request.Test {
  return signed(api().post('/api/v1/customer-payments'),key,as).send({
    customerPartyId:partyId, accountCode:'BANK:'+sourceId,
    amountMinor,saleIds:[],note:null,
  });
}
function supplierPost(
  partyId:string, amountMinor:number, key=uid(), sourceId=mfsId, as=token,
): request.Test {
  return signed(api().post('/api/v1/suppliers/payments'),key,as).send({
    supplierPartyId:partyId,accountCode:'BANK:'+sourceId,
    amountMinor,purchaseId:null,note:null,
  });
}

suite('MOD-006 T02-E: signed Counter source-owned BANK/MFS posting and RLS', ()=>{
  beforeAll(async()=>{
    requireIsolatedDatabase(); // BEFORE migrations, resetting or any fixture writes
    pool=testPool();
    await prepareTestDatabase();
    const mod=await Test.createTestingModule({imports:[AppModule]}).compile();
    app=mod.createNestApplication();
    app.useGlobalFilters(new AppErrorFilter());
    await app.init();
  },60_000);
  afterAll(async()=>{await app?.close();await pool?.end();});
  beforeEach(async()=>{
    await resetDatabase(pool);
    shop=await seedTenant(pool,{name:'T02E Synthetic Counter Shop',permissions:GRANTS});
    token=signToken(shop,TEST_JWT_SECRET);
    await setBankEnabled();
    bankId=await account('BANK',50_000);
    mfsId=await account('MFS',40_000);
  });
  afterEach(async()=>{if(shop?.tenantId)await assertGoldenInvariants(pool,shop.tenantId);});

  it('BANK customer signed GET→POST→GET creates exactly one journal and genuine advance, no cash day',async()=>{
    const customerId=await tradingParty('CUSTOMER');
    const identity=await who().expect(200);
    expect(identity.body.data.tenantId).toBe(shop.tenantId);
    expect(identity.body.data.permissions).toContain(Permission.SALE_RECEIVE_PAYMENT);
    const beforeSource=accountFrom((await sourceList().expect(200)).body,bankId);
    const beforeParty=(await partyDetail(customerId,'CUSTOMER').expect(200)).body.data;
    expect(beforeSource.balanceMinor).toBe(50_000);
    expect(beforeParty.balance.netMinor).toBe(0);
    const before=await dbSnapshot();
    const receipt=created(await customerPost(customerId,2_350),'customer bank advance');
    expect(receipt.body.data.customerPartyId).toBe(customerId);
    expect(receipt.body.data.amountMinor).toBe(2_350);
    expect(receipt.body.data.accountCode).toBe('BANK:'+bankId);
    const afterSource=accountFrom((await sourceList().expect(200)).body,bankId);
    const afterParty=(await partyDetail(customerId,'CUSTOMER').expect(200)).body.data;
    const after=await dbSnapshot();
    expect(afterSource.balanceMinor).toBe(52_350);
    expect(afterParty.balance.netMinor).toBe(-2_350);
    expect(afterParty.balance.advanceMinor).toBe(2_350);
    expect(after.totals['BANK:'+bankId]).toBe(52_350);
    expect(after.totals.CUSTOMER_ADVANCE).toBe(-2_350);
    expect(after.totals.REVENUE??0).toBe(before.totals.REVENUE??0);
    expect(after.entries).toBe(before.entries+1);
    expect(after.customers).toBe(before.customers+1);
    expect(after.sessions).toBe(0);
  },60_000);

  it('MFS supplier signed GET→POST→GET reduces real purchase AP; no cash session',async()=>{
    const supplierId=await tradingParty('SUPPLIER');
    await unpaidPurchase(supplierId);
    const beforeParty=(await partyDetail(supplierId,'SUPPLIER').expect(200)).body.data;
    const beforeSource=accountFrom((await sourceList().expect(200)).body,mfsId);
    const before=await dbSnapshot();
    expect(before.totals.AP).toBe(-100_000);
    expect(beforeSource.balanceMinor).toBe(40_000);
    const payment=created(await supplierPost(supplierId,20_000),'supplier MFS payment');
    expect(payment.body.data.accountCode).toBe('BANK:'+mfsId);
    const afterParty=(await partyDetail(supplierId,'SUPPLIER').expect(200)).body.data;
    const afterSource=accountFrom((await sourceList().expect(200)).body,mfsId);
    const after=await dbSnapshot();
    expect(afterSource.balanceMinor).toBe(20_000);
    expect(after.totals['BANK:'+mfsId]).toBe(20_000);
    expect(after.totals.AP).toBe(-80_000);
    expect(afterParty.balance.netMinor-beforeParty.balance.netMinor).toBe(20_000);
    expect(after.entries).toBe(before.entries+1);
    expect(after.suppliers).toBe(before.suppliers+1);
    expect(after.sessions).toBe(0);
  },60_000);

  it('same-key exact retry is idempotent; changed amount conflicts without a second journal',async()=>{
    const customerId=await tradingParty('CUSTOMER');
    const key=uid();
    created(await customerPost(customerId,1_000,key),'original payment');
    const after=await dbSnapshot();
    const replay=await customerPost(customerId,1_000,key);
    expect(replay.status,JSON.stringify(replay.body)).toBe(201);
    expect(await dbSnapshot()).toEqual(after);
    const changed=await customerPost(customerId,1_001,key);
    expect(changed.status,JSON.stringify(changed.body)).toBe(409);
    expect(await dbSnapshot()).toEqual(after);
  },60_000);

  it('revoking payment permission between signed GET and POST denies without journal mutation',async()=>{
    const customerId=await tradingParty('CUSTOMER');
    await who().expect(200);
    await partyDetail(customerId,'CUSTOMER').expect(200);
    await sourceList().expect(200);
    const before=await dbSnapshot();
    await removePermission(Permission.SALE_RECEIVE_PAYMENT);
    const now=await who().expect(200);
    expect(now.body.data.permissions).not.toContain(Permission.SALE_RECEIVE_PAYMENT);
    await customerPost(customerId,1_000).expect(403);
    expect(await dbSnapshot()).toEqual(before);
  },60_000);

  it('foreign tenant cannot post a receipt against another tenant Party/account',async()=>{
    const customerId=await tradingParty('CUSTOMER');
    const before=await dbSnapshot();
    const foreign=await seedTenant(pool,{
      name:'T02E Other Synthetic Tenant',
      permissions:[Permission.CUSTOMER_VIEW,Permission.SALE_RECEIVE_PAYMENT,Permission.BANK_ACCOUNT_VIEW],
    });
    const otherToken=signToken(foreign,TEST_JWT_SECRET);
    expect((await who(otherToken).expect(200)).body.data.tenantId).toBe(foreign.tenantId);
    await partyDetail(customerId,'CUSTOMER',otherToken).expect(404);
    const attempt=await customerPost(customerId,1_000,uid(),bankId,otherToken);
    expect([400,403,404]).toContain(attempt.status);
    expect(await dbSnapshot()).toEqual(before);
  },60_000);

  it('BANK may overdraw under current source policy; supplier AP and journal stay balanced',async()=>{
    const supplierId=await tradingParty('SUPPLIER');
    await unpaidPurchase(supplierId);
    const before=await dbSnapshot();
    expect(before.totals.AP).toBe(-100_000);
    expect(before.totals['BANK:'+bankId]).toBe(50_000);
    // Current resolvePaymentAccount checks insufficient funds for CASH only.
    // Do not invent a BANK shortage rule or change money policy in this test.
    const posted=created(await supplierPost(supplierId,60_000,uid(),bankId),
      'BANK supplier settlement under current overdraft policy');
    expect(posted.body.data.accountCode).toBe('BANK:'+bankId);
    const after=await dbSnapshot();
    const account=accountFrom((await sourceList().expect(200)).body,bankId);
    expect(account.balanceMinor).toBe(-10_000);
    expect(after.totals['BANK:'+bankId]).toBe(-10_000);
    expect(after.totals.AP).toBe(-40_000);
    expect(after.entries).toBe(before.entries+1);
    expect(after.suppliers).toBe(before.suppliers+1);
    expect(after.sessions).toBe(0);
  },60_000);
});
