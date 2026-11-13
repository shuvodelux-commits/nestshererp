/*
 * MOD-006 P2-C real Nest + disposable PostgreSQL16 acceptance.
 * Mandatory hard gate BEFORE migration or table reset. No retained database.
 * All account/settings/movement POSTs here provision synthetic test fixtures;
 * the real React Money Accounts read journey itself must never make such writes.
 */
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Permission } from '@sher/core-contracts';
import { SystemClock, Ulid } from '@sher/shared-utils';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { AppErrorFilter } from '../src/common/app-error.filter';
import { asTenant, prepareTestDatabase, resetDatabase, testPool } from './support/database';

const clock = new SystemClock();
const name = 'hisabiq_mod006_p2c_qa_20261113';
const day = clock.businessDate('Asia/Dhaka');
const opening = '2026-01-01';
let app: INestApplication;
let pool: pg.Pool;
const api = () => request(app.getHttpServer());

interface Identity {
  tenantId: string;
  userId: string;
  access: string;
  refresh: string;
}
function assertDisposable(): void {
  if (process.env['MOD006_P2C_TEST_ONLY'] !== 'MOD006_P2C_DISPOSABLE_DB_ONLY_20261113')
    throw new Error('P2-C refuses unapproved/disposable-DB test execution');
  const admin = process.env['ADMIN_DATABASE_URL'];
  const test = process.env['TEST_DATABASE_URL'];
  for (const value of [admin, test]) {
    if (!value) throw new Error('P2-C refuses missing explicit connection URLs');
    const url = new URL(value);
    if (!['127.0.0.1','localhost'].includes(url.hostname) ||
        url.port !== '55656' || url.pathname !== '/' + name)
      throw new Error('P2-C refuses any host/port/database outside isolated PostgreSQL16');
  }
  if (new URL(admin!).username !== 'postgres' || new URL(test!).username !== 'sher_app')
    throw new Error('P2-C requires separate migration owner and nonprivileged RLS app role');
}
async function registered(label: string): Promise<Identity> {
  const identifier = 'p2c-' + label + '@isolated.invalid';
  const password = 'P2cOnlyPassw0rd!1';
  const otp = await api().post('/api/v1/auth/registration/otp').send({identifier});
  expect(otp.status,JSON.stringify(otp.body)).toBe(200);
  const code = otp.body?.data?.devCode as string | undefined;
  if (!/^[0-9]{6}$/.test(code ?? '')) throw new Error('Dev OTP unavailable: no registration bypass allowed');
  const created = await api().post('/api/v1/auth/registration').send({
    identifier,otpCode:code,businessName:'P2C Synthetic '+label,
    username:'p2c'+label,password,pin:'472906',
  });
  expect(created.status,JSON.stringify(created.body)).toBe(201);
  const login = await api().post('/api/v1/auth/login').send({identifier,password});
  expect(login.status,JSON.stringify(login.body)).toBe(200);
  const access = login.body.data.accessToken as string;
  const me = await api().get('/api/v1/me').set('Authorization','Bearer '+access);
  expect(me.status,JSON.stringify(me.body)).toBe(200);
  expect(me.body.data.user.id).toBe(created.body.data.user.id);
  expect(me.body.data.tenantId).toBe(created.body.data.tenant.id);
  return {tenantId:me.body.data.tenantId as string,userId:me.body.data.user.id as string,
    access,refresh:login.body.data.refreshToken as string};
}
const get = (actor: Identity, path: string) =>
  api().get(path).set('Authorization','Bearer '+actor.access);
async function enableBank(actor: Identity): Promise<void> {
  const response = await api().post('/api/v1/settings/value')
    .set('Authorization','Bearer '+actor.access)
    .send({key:'bank_accounts_enabled',value:'on'});
  expect(response.status,JSON.stringify(response.body)).toBe(201);
}
async function account(actor: Identity, label: string,
  type: 'CASH'|'BANK'|'MFS'|'LOAN', amount: number, missing = false, inactive = false): Promise<string> {
  const operationId = Ulid.generate(clock);
  const created = await api().post('/api/v1/money/accounts')
    .set('Authorization','Bearer '+actor.access)
    .set('Idempotency-Key',operationId)
    .send({name:label,type,holderName:null,reference:null,isDrawer:false,
      openingAmountMinor:amount,openingDate:missing?null:opening,operationId});
  expect(created.status,JSON.stringify(created.body)).toBe(201);
  const id = created.body.data.id as string;
  expect(id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  if (inactive) {
    const response = await api().post('/api/v1/money/accounts/'+id+'/deactivate')
      .set('Authorization','Bearer '+actor.access)
      .send({version:created.body.data.version as number});
    expect(response.status,JSON.stringify(response.body)).toBe(200);
  }
  return id;
}
async function restrict(actor: Identity, codes: readonly string[]): Promise<void> {
  await asTenant(pool,actor.tenantId,async db => {
    const rows = await db.query<{id:string}>(
      "SELECT id FROM roles WHERE tenant_id=$1 AND code='OWNER'",[actor.tenantId]);
    expect(rows.rows).toHaveLength(1);
    const roleId = rows.rows[0]!.id;
    await db.query('DELETE FROM role_permissions WHERE tenant_id=$1 AND role_id=$2',[actor.tenantId,roleId]);
    for (const code of codes) {
      const now = clock.now();
      await db.query(
        'INSERT INTO role_permissions (id,tenant_id,role_id,permission_code,created_at,updated_at,created_by,updated_by,version) VALUES ($1,$2,$3,$4,$5,$5,$6,$6,1)',
        [Ulid.generate(clock),actor.tenantId,roleId,code,now,actor.userId],
      );
    }
  });
}
// Ordinary CI cannot access the one named disposable Postgres instance.
// It skips this isolated suite; the explicit test env opts in and keeps the hard guard.
const p2cSuite = process.env['MOD006_P2C_TEST_ONLY'] ===
  'MOD006_P2C_DISPOSABLE_DB_ONLY_20261113' ? describe : describe.skip;
p2cSuite('P2-C actual authenticated PostgreSQL16 Money Accounts reads',() => {
beforeAll(async () => {
  assertDisposable();
  pool = testPool();
  await prepareTestDatabase();
  const moduleRef = await Test.createTestingModule({imports:[AppModule]}).compile();
  app = moduleRef.createNestApplication();
  app.useGlobalFilters(new AppErrorFilter());
  await app.init();
},60000);
afterAll(async () => {
  await app?.close();
  await pool?.end();
});


  it('protects identity, tenant, account family and role-dependent balance totals',async () => {
    await resetDatabase(pool);
    const a=await registered('a');
    const b=await registered('b');
    expect(a.tenantId).not.toBe(b.tenantId);
    await enableBank(a);
    await enableBank(b);
    const cash=await account(a,'Same account name','CASH',12500);
    const bank=await account(a,'Distinct bank name','BANK',24000);
    const mobile=await account(a,'Mobile wallet','MFS',3300);
    const lender=await account(a,'Lender loan','LOAN',777700);
    const unknown=await account(a,'Missing opening','CASH',0,true);
    const inactive=await account(a,'Dormant cash','CASH',0,true,true);
    const foreign=await account(b,'Same account name','CASH',9000);
    const list=await get(a,'/api/v1/money/accounts');
    expect(list.status,JSON.stringify(list.body)).toBe(200);
    expect(list.body.accounts).toHaveLength(5);
    expect(list.body.accounts.map((x:{id:string})=>x.id))
      .toEqual(expect.arrayContaining([cash,bank,mobile,lender,unknown]));
    expect(list.body.accounts.find((x:{id:string})=>x.id===inactive)).toBeUndefined();
    expect(list.body.accounts.find((x:{id:string})=>x.id===lender).balanceMinor).toBe(-777700);
    expect(list.body.totalLoanMinor).toBe(777700);
    expect(list.body.accounts.find((x:{id:string})=>x.id===unknown).openingAmountMinor).toBeNull();
    const full=await get(a,'/api/v1/money/accounts?includeInactive=true');
    expect(full.status).toBe(200);
    expect(full.body.accounts.find((x:{id:string})=>x.id===inactive).status).toBe('INACTIVE');
    expect((await get(a,'/api/v1/money/accounts/'+foreign+'/statement')).status).toBe(404);
    expect((await get(b,'/api/v1/money/accounts/'+cash+'/statement')).status).toBe(404);
    await restrict(a,[Permission.CASH_ACCOUNT_VIEW]);
    const cashier=await get(a,'/api/v1/money/accounts');
    expect(cashier.status).toBe(200);
    expect(cashier.body.accounts.every((x:{type:string})=>x.type==='CASH')).toBe(true);
    expect([cashier.body.totalBankMinor,cashier.body.totalMfsMinor,cashier.body.totalLoanMinor]).toEqual([0,0,0]);
    expect(JSON.stringify(cashier.body)).not.toContain('Lender loan');
    expect(JSON.stringify(cashier.body)).not.toContain(bank);
    expect(JSON.stringify(cashier.body)).not.toContain(mobile);
    expect((await get(a,'/api/v1/money/accounts/'+bank+'/statement')).status).toBe(403);
    expect((await get(a,'/api/v1/money/accounts/'+lender+'/statement')).status).toBe(403);
    expect((await get(a,'/api/v1/money/accounts/'+cash+'/statement')).status).toBe(200);
    await restrict(a,[Permission.BANK_ACCOUNT_VIEW]);
    const banks=await get(a,'/api/v1/money/accounts');
    expect(banks.status).toBe(200);
    expect(banks.body.accounts.map((x:{type:string})=>x.type).sort()).toEqual(['BANK','MFS']);
    await restrict(a,[Permission.LOAN_ACCOUNT_MANAGE]);
    const loans=await get(a,'/api/v1/money/accounts');
    expect(loans.status).toBe(200);
    expect(loans.body.accounts).toHaveLength(1);
    expect(loans.body.totalLoanMinor).toBe(777700);
    await restrict(a,[]);
    const denied=await get(a,'/api/v1/money/accounts');
    expect(denied.status).toBe(403);
    expect(JSON.stringify(denied.body)).not.toContain('Same account name');
    // Genuine per-tenant unique-name constraint disallows same-tenant duplicate labels.
    // Matching labels across DIFFERENT tenants still exercise ULID and RLS isolation.
  },60000);

  it('respects source-linked signed journal lines and true keyset cursor pages',async () => {
    await resetDatabase(pool);
    const actor=await registered('ledger');
    await enableBank(actor);
    const bank=await account(actor,'Main bank','BANK',600000);
    const mfs=await account(actor,'MFS wallet','MFS',0,true);
    const original=await get(actor,'/api/v1/money/accounts/'+bank+'/statement?limit=1');
    expect(original.status,JSON.stringify(original.body)).toBe(200);
    expect(original.body.rows).toHaveLength(1);
    expect(original.body.rows[0].sourceType).toBe('ACCOUNT_OPENING');
    expect(original.body.rows[0].debitMinor).toBe(600000);
    for(let i=0;i<3;i++){
      const operationId=Ulid.generate(clock);
      const res=await api().post('/api/v1/money/movements')
        .set('Authorization','Bearer '+actor.access)
        .set('Idempotency-Key',operationId)
        .send({kind:'TRANSFER',fromAccountCode:'BANK:'+bank,toAccountCode:'MFS:'+mfs,
          amountMinor:500,businessDate:day,reference:null,note:'P2C fixture '+i,operationId});
      expect(res.status,JSON.stringify(res.body)).toBe(201);
    }
    const page1=await get(actor,'/api/v1/money/accounts/'+bank+'/statement?limit=2');
    expect(page1.status,JSON.stringify(page1.body)).toBe(200);
    expect(page1.body.rows).toHaveLength(2);
    expect(page1.body.page.hasMore).toBe(true);
    expect(page1.body.page.nextCursor).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    const page2=await get(actor,'/api/v1/money/accounts/'+bank+
      '/statement?limit=2&cursor='+page1.body.page.nextCursor);
    expect(page2.status,JSON.stringify(page2.body)).toBe(200);
    expect(page2.body.rows).toHaveLength(2);
    expect(page2.body.page.hasMore).toBe(false);
    const all=[...page1.body.rows,...page2.body.rows] as Array<{
      journalLineId:string;amountMinor:number;debitMinor:number;
      creditMinor:number;runningBalanceMinor:number;
    }>;
    expect(new Set(all.map(x=>x.journalLineId)).size).toBe(4);
    for(const page of [page1.body,page2.body]){
      let running=page.openingBalanceMinor as number;
      let sumDebit=0,sumCredit=0;
      for(const row of page.rows as typeof all){
        running+=row.amountMinor;
        sumDebit+=row.debitMinor;
        sumCredit+=row.creditMinor;
        expect(row.debitMinor-row.creditMinor).toBe(row.amountMinor);
        expect(row.runningBalanceMinor).toBe(running);
        expect(Math.min(row.debitMinor,row.creditMinor)).toBe(0);
      }
      expect(page.totalInMinor).toBe(sumDebit);
      expect(page.totalOutMinor).toBe(sumCredit);
    }
    expect(page1.body.closingBalanceMinor).toBe(598500);
    expect(page2.body.closingBalanceMinor).toBe(598500);
    expect(all.at(-1)?.runningBalanceMinor).toBe(598500);
    const bounded=await get(actor,'/api/v1/money/accounts/'+bank+
      '/statement?fromDate=2026-01-01&toDate='+day);
    expect(bounded.status).toBe(200);
  },60000);
});
