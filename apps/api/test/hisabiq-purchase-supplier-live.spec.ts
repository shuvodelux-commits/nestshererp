/**
 * MOD-008 P-SEC-S02: opt-in, real HTTP acceptance of the actual HisabIQ React
 * Supplier reader against signed Nest and PostgreSQL16 (non-owner RLS).
 *
 * This is NOT a browser UI test. An explicit local React source checkout is
 * required; the default backend CI does not acquire another repository.
 * Do not run against a shared or production database.
 */
import 'reflect-metadata';

import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Permission, SettingKey } from '@sher/core-contracts';
import { SystemClock, Ulid } from '@sher/shared-utils';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { AppErrorFilter } from '../src/common/app-error.filter';
import { signToken, TEST_JWT_SECRET } from './support/auth';
import type { SeededTenant } from './support/database';
import { asTenant, prepareTestDatabase, resetDatabase, seedTenant, testPool } from './support/database';

interface Supplier {
  id: string;
  name: string;
  roles: string[];
  balance: { netMinor: number; direction: string; outstandingMinor: number; advanceMinor: number };
}
interface SupplierList {
  data: Supplier[];
  summary: { ungrouped: null };
}
interface ReactSupplierReads {
  readPurchaseSuppliers: (token: string, query?: { status?: 'ACTIVE' }) => Promise<SupplierList>;
  readPurchaseSupplier: (token: string, id: string) => Promise<{ data: Supplier }>;
}

const reactRoot = process.env['HISABIQ_REACT_SOURCE_DIR'];
const run = reactRoot ? describe : describe.skip;
const clock = new SystemClock();
let app: INestApplication;
let pool: pg.Pool;
let tenant: SeededTenant;
let token: string;
let react: ReactSupplierReads;
let originalLocation: PropertyDescriptor | undefined;
let originalFetch: typeof fetch;
let origin = '';
let observed: string[] = [];

const grants = [
  Permission.CUSTOMER_VIEW, Permission.CUSTOMER_CREATE,
  Permission.SUPPLIER_VIEW, Permission.SUPPLIER_CREATE, Permission.SUPPLIER_EDIT,
  Permission.SETTING_VIEW, Permission.SETTING_EDIT, Permission.SETTING_TOGGLE,
];

async function restrict(codes: readonly string[]): Promise<void> {
  await asTenant(pool, tenant.tenantId, async (client) => {
    await client.query(
      'DELETE FROM role_permissions WHERE tenant_id=$1 AND role_id=$2',
      [tenant.tenantId, tenant.roleId],
    );
    const now = clock.now();
    for (const code of codes) {
      await client.query(
        'INSERT INTO role_permissions (id,tenant_id,role_id,permission_code,created_at,updated_at,created_by,updated_by,version) VALUES ($1,$2,$3,$4,$5,$5,$6,$6,1)',
        [Ulid.generate(clock), tenant.tenantId, tenant.roleId, code, now, tenant.userId],
      );
    }
  });
}
async function createSharedSupplier(): Promise<string> {
  const auth = { Authorization: 'Bearer ' + token };
  // Keep the fixture source-backed; private field switches are real settings.
  for (const key of [
    SettingKey.CUSTOMER_FIELD_ADDRESS_VISIBLE,
    SettingKey.CUSTOMER_FIELD_GUARDIAN_VISIBLE,
    SettingKey.CUSTOMER_FIELD_NID_VISIBLE,
    SettingKey.CUSTOMER_FIELD_EMAIL_VISIBLE,
    SettingKey.CUSTOMER_FIELD_NOTES_VISIBLE,
  ]) {
    await request(app.getHttpServer()).post('/api/v1/settings/value')
      .set(auth).send({ key, value: 'on' }).expect(201);
  }
  const created = await request(app.getHttpServer()).post('/api/v1/parties')
    .set(auth).set('Idempotency-Key', Ulid.generate(clock))
    .send({
      name: 'Supplier Role Acceptance',
      roles: ['CUSTOMER', 'SUPPLIER'],
      phone: '01712345678',
      address: 'Private address', guardianName: 'Private guardian',
      nid: 'QA-NID-NEVER-DISCLOSE', email: 'private@example.test',
      notes: 'Private notes',
      customerGroupId: null, creditLimitMinor: null,
    }).expect(201);
  const id = created.body.data.id as string;
  await request(app.getHttpServer()).post('/api/v1/parties/' + id + '/opening')
    .set(auth).set('Idempotency-Key', Ulid.generate(clock))
    .send({
      role: 'SUPPLIER', direction: 'PAYABLE', amountMinor: 315_000,
      businessDate: clock.businessDate('Asia/Dhaka'),
    }).expect(201);
  return id;
}

run('MOD-008 P-SEC-S02 — real React Supplier reader + signed Nest + PostgreSQL16', () => {
  beforeAll(async () => {
    if (!reactRoot || !isAbsolute(reactRoot) ||
        !existsSync(join(reactRoot, 'src/integration/purchase-suppliers.ts')))
      throw new Error('HISABIQ_REACT_SOURCE_DIR must be an existing absolute source root');
    const testUrl = process.env['TEST_DATABASE_URL'] ?? '';
    if (!testUrl.includes('127.0.0.1:') || !testUrl.endsWith('/sher_test') ||
        process.env['ADMIN_DATABASE_URL']?.includes('127.0.0.1:') !== true)
      throw new Error('Requires an explicitly pinned disposable loopback sher_test database');

    const module = await import(
      /* @vite-ignore */ pathToFileURL(join(reactRoot, 'src/integration/purchase-suppliers.ts')).href
    );
    react = {
      readPurchaseSuppliers: module.readPurchaseSuppliers,
      readPurchaseSupplier: module.readPurchaseSupplier,
    };
    pool = testPool();
    await prepareTestDatabase();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AppErrorFilter());
    await app.listen(0, '127.0.0.1');
    origin = await app.getUrl();
    originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
    Object.defineProperty(globalThis, 'location', {
      configurable: true, value: { origin },
    });
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe(origin);
      expect(init?.method).toBe('GET');
      expect(init?.body).toBeUndefined();
      expect(init?.redirect).toBe('error');
      observed.push(url.pathname + url.search);
      return originalFetch(input, init); // Real network, never a mocked API body.
    };
  }, 90_000);
  afterAll(async () => {
    if (originalFetch) globalThis.fetch = originalFetch;
    if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation);
    else Reflect.deleteProperty(globalThis, 'location');
    if (app) await app.close();
    if (pool) await pool.end();
  });
  beforeEach(async () => {
    await resetDatabase(pool);
    tenant = await seedTenant(pool, {
      name: 'Supplier V2 live QA tenant A', permissions: grants,
    });
    token = signToken(tenant, TEST_JWT_SECRET);
    observed = [];
  });

  it('reads only Supplier fields and source-linked payable from actual signed HTTP', async () => {
    const id = await createSharedSupplier();
    await restrict([Permission.SUPPLIER_VIEW]);
    const listed = await react.readPurchaseSuppliers(token, { status: 'ACTIVE' });
    const detail = await react.readPurchaseSupplier(token, id);
    expect(listed.data).toHaveLength(1);
    expect(listed.summary.ungrouped).toBeNull();
    for (const row of [listed.data[0]!, detail.data]) {
      expect(row.id).toBe(id);
      expect(row.roles).toEqual(['SUPPLIER']);
      expect(row.balance).toEqual({
        netMinor: -315_000, direction: 'PAYABLE', outstandingMinor: 0, advanceMinor: 315_000,
      });
      for (const key of ['nid', 'address', 'guardianName', 'notes',
        'profile', 'globalHistory', 'hasLedgerEntries', 'customerGroupId']) {
        expect(Object.hasOwn(row, key)).toBe(false);
      }
    }
    const serialized = JSON.stringify({ listed, detail });
    expect(serialized).not.toContain('QA-NID-NEVER-DISCLOSE');
    expect(serialized).not.toContain('Private guardian');
    expect(observed).toEqual([
      '/api/v2/parties?role=SUPPLIER&status=ACTIVE',
      '/api/v2/parties/' + id + '?role=SUPPLIER',
    ]);
  }, 90_000);

  it('revokes Supplier read rights without a V1 retry', async () => {
    const id = await createSharedSupplier();
    await restrict([]);
    await expect(react.readPurchaseSuppliers(token)).rejects.toMatchObject({
      kind: 'http', status: 403,
    });
    await expect(react.readPurchaseSupplier(token, id)).rejects.toMatchObject({
      kind: 'http', status: 403,
    });
    expect(observed).toEqual([
      '/api/v2/parties?role=SUPPLIER',
      '/api/v2/parties/' + id + '?role=SUPPLIER',
    ]);
  }, 90_000);

  it('keeps another signed tenant outside the Supplier source and cannot reveal an ID', async () => {
    const id = await createSharedSupplier();
    const other = await seedTenant(pool, {
      name: 'Supplier V2 live QA tenant B',
      permissions: [Permission.SUPPLIER_VIEW],
    });
    const signedOther = signToken(other, TEST_JWT_SECRET);
    const listed = await react.readPurchaseSuppliers(signedOther);
    expect(listed.data).toEqual([]);
    await expect(react.readPurchaseSupplier(signedOther, id))
      .rejects.toMatchObject({ kind: 'http', status: 404 });
    expect(observed).toEqual([
      '/api/v2/parties?role=SUPPLIER',
      '/api/v2/parties/' + id + '?role=SUPPLIER',
    ]);
  }, 90_000);
});
