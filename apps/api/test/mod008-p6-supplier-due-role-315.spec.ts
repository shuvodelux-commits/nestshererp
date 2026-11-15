/*
 * MOD-008 P1 #315: supplier-role authorization on signed live Supplier Due.
 * RED-first QA: never use a retained database or another worker's container.
 * Opt-in: HISABIQ_MOD008_DUE_ROLE_315_ACK=isolated-pg16-role-315
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
const PORT = '55715';
const ACK = 'isolated-pg16-role-315';
const NAME = 'hisabiq-mod008-p6-role-315-pg16';
const LABEL = 'mod008-role-315';
const MISSING_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAX';
const FULL_PERMISSIONS = [
  Permission.PURCHASE_VIEW, Permission.SUPPLIER_VIEW,
  Permission.SUPPLIER_CREATE, Permission.SUPPLIER_DEACTIVATE,
  Permission.CUSTOMER_VIEW, Permission.CUSTOMER_CREATE,
];
let app: INestApplication;
let pool: pg.Pool;
let a: SeededTenant;
let b: SeededTenant;
let tokenA: string;
let tokenB: string;
let supplierId: string;
let customerId: string;
let bothRolesId: string;

function assertDisposable(): void {
  const url = 'postgres://sher_app:sher_app_test@127.0.0.1:' + PORT + '/sher_test';
  const admin = 'postgres://postgres:dev@127.0.0.1:' + PORT + '/sher_test';
  const expected = {
    DATABASE_URL: url, ADMIN_DATABASE_URL: admin,
    JWT_SECRET: TEST_JWT_SECRET, HISABIQ_MOD008_DUE_ROLE_315_ACK: ACK,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (process.env[key] !== value) throw new Error('MOD008 #315 disposable guard: ' + key);
  }
  const checked = spawnSync('podman', [
    'inspect', '--format',
    '{{index .Config.Labels "hisabiq.qa"}}|{{index .Config.Labels "hisabiq.owner"}}|{{.State.Running}}',
    NAME,
  ], { encoding: 'utf8' });
  if (checked.status !== 0 ||
      checked.stdout.trim() !== LABEL + '|mod008-security-315-20261115|true') {
    throw new Error('MOD008 #315 labelled, task-owned PostgreSQL guard failed');
  }
}

const api = () => request(app.getHttpServer());
const auth = (token: string) => ({ Authorization: 'Bearer ' + token });
const createParty = async (roles: string[], name: string, token = tokenA) => {
  const result = await api().post('/api/v1/parties')
    .set(auth(token)).set('Idempotency-Key', Ulid.generate(clock))
    .send({
      name, roles,
      phone: roles.includes('CUSTOMER')
        ? (name === 'Customer-only identity' ? '01790000123' : '01790000124') : null,
      address: null, guardianName: null,
      nid: null, email: null, notes: null, customerGroupId: null,
      creditLimitMinor: null,
    });
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  return result.body.data.id as string;
};
const due = (id: string, token = tokenA) =>
  api().get('/api/v1/suppliers/' + id + '/due').set(auth(token));

async function postingSnapshot(tenant: SeededTenant) {
  return asTenant(pool, tenant.tenantId, async db => {
    const rows = await db.query(`SELECT
      (SELECT count(*)::int FROM purchases) AS purchases,
      (SELECT count(*)::int FROM journal_entries) AS journals,
      (SELECT count(*)::int FROM journal_lines) AS lines,
      (SELECT count(*)::int FROM stock_movements) AS stocks,
      (SELECT count(*)::int FROM supplier_payments) AS payments,
      (SELECT count(*)::int FROM audit_events) AS audits,
      (SELECT count(*)::int FROM outbox) AS outbox`);
    return rows.rows[0];
  });
}

const suite = process.env.HISABIQ_MOD008_DUE_ROLE_315_ACK === ACK ? describe : describe.skip;
suite('MOD-008 #315 signed Supplier Due role and tenant authorization', () => {
  beforeAll(async () => {
    assertDisposable();
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
    a = await seedTenant(pool, { name: 'P6 Supplier Due A', permissions: FULL_PERMISSIONS });
    b = await seedTenant(pool, {
      name: 'P6 Supplier Due B', permissions: [
        Permission.PURCHASE_VIEW, Permission.SUPPLIER_VIEW, Permission.SUPPLIER_CREATE,
      ],
    });
    tokenA = signToken(a, TEST_JWT_SECRET);
    tokenB = signToken(b, TEST_JWT_SECRET);
    supplierId = await createParty(['SUPPLIER'], 'Valid supplier');
    customerId = await createParty(['CUSTOMER'], 'Customer-only identity');
    bothRolesId = await createParty(['CUSTOMER', 'SUPPLIER'], 'Dual-role identity');
  }, 45_000);

  it('reads a valid supplier, preserving a nonposting response', async () => {
    const before = await postingSnapshot(a);
    const first = await due(supplierId);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.data).toMatchObject({
      supplierPartyId: supplierId, supplierName: 'Valid supplier',
      outstandingMinor: 0, bills: [],
    });
    expect((await due(supplierId)).body).toEqual(first.body);
    expect(await postingSnapshot(a)).toEqual(before);
  }, 35_000);

  it('rejects CUSTOMER-only identities without disclosure or posting', async () => {
    const before = await postingSnapshot(a);
    const response = await due(customerId);
    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).not.toContain('Customer-only identity');
    expect(response.body.data).toBeUndefined();
    expect(await postingSnapshot(a)).toEqual(before);
  }, 35_000);

  it('permits one identity holding both SUPPLIER and CUSTOMER roles', async () => {
    const response = await due(bothRolesId);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data).toMatchObject({
      supplierPartyId: bothRolesId, outstandingMinor: 0, bills: [],
    });
    expect(response.body.data.roles).toBeUndefined();
  }, 35_000);

  it('fails closed for missing and cross-tenant supplier identities', async () => {
    const beforeA = await postingSnapshot(a);
    const beforeB = await postingSnapshot(b);
    expect((await due(MISSING_ID)).status).toBe(404);
    expect((await due(supplierId, tokenB)).status).toBe(404);
    expect(await postingSnapshot(a)).toEqual(beforeA);
    expect(await postingSnapshot(b)).toEqual(beforeB);
  }, 35_000);

  it('does not disclose inactive supplier identities as active due sources', async () => {
    const status = await api().post('/api/v1/parties/' + supplierId + '/status')
      .set(auth(tokenA)).send({ status: 'INACTIVE' });
    expect(status.status, JSON.stringify(status.body)).toBe(200);
    const before = await postingSnapshot(a);
    const response = await due(supplierId);
    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).not.toContain('Valid supplier');
    expect(await postingSnapshot(a)).toEqual(before);
  }, 35_000);

  it('requires PURCHASE_VIEW before reading an owned supplier', async () => {
    const noPurchase = await seedTenant(pool, {
      name: 'No Purchase Read Tenant C',
      permissions: [Permission.SUPPLIER_CREATE, Permission.SUPPLIER_VIEW],
    });
    const restrictedToken = signToken(noPurchase, TEST_JWT_SECRET);
    const ownSupplier = await createParty(['SUPPLIER'], 'Supplier C', restrictedToken);
    const before = await postingSnapshot(noPurchase);
    const denied = await due(ownSupplier, restrictedToken);
    expect(denied.status).toBe(403);
    expect(await postingSnapshot(noPurchase)).toEqual(before);
  }, 35_000);

  it('requires SUPPLIER_VIEW even when purchase viewing is granted', async () => {
    const viewer = await seedTenant(pool, {
      name: 'No Supplier Read Tenant C',
      permissions: [Permission.PURCHASE_VIEW, Permission.SUPPLIER_CREATE],
    });
    const restrictedToken = signToken(viewer, TEST_JWT_SECRET);
    const supplierC = await createParty(['SUPPLIER'], 'Restricted supplier', restrictedToken);
    const before = await postingSnapshot(viewer);
    const denied = await due(supplierC, restrictedToken);
    expect(denied.status).toBe(403);
    expect(await postingSnapshot(viewer)).toEqual(before);
  }, 35_000);
});
