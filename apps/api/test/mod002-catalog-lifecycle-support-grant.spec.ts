/**
 * MOD-002 #344 — signed vendor-support principal provenance regression.
 * Run ONLY against disposable PostgreSQL16/sher_test at 127.0.0.1:55965.
 * This is an intentionally RED-first test: support actor storage must retain
 * 'support:<operator ULID>' through the row, audit and outbox, not truncate it.
 */
import 'reflect-metadata';

import { generateKeyPairSync, sign } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SystemClock, Ulid } from '@sher/shared-utils';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { AppErrorFilter } from '../src/common/app-error.filter';
import {
  SUPPORT_GRANT_HEADER, SUPPORT_GRANT_PREFIX, canonicalSupportGrant,
} from '../src/management/support-grant';
import type { SupportGrant } from '../src/management/support-grant';
import { managementState } from '../src/management/management-state';
import {
  asTenant, prepareTestDatabase, seedTenant, testPool,
} from './support/database';
import type { SeededTenant } from './support/database';

const clock = new SystemClock();
const id = () => Ulid.generate(clock);
const kindNames = ['unit', 'brand', 'category'] as const;
type Kind = typeof kindNames[number];
const tables = { unit: 'units', brand: 'brands', category: 'categories' } as const;
const plural = { unit: 'units', brand: 'brands', category: 'categories' } as const;
const route = (kind: Kind) => '/api/v1/catalog/lifecycle-v1/' + plural[kind];
const signedActorOperator = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const fullActor = 'support:' + signedActorOperator;

function requireDisposableDatabase(): void {
  for (const key of ['DATABASE_URL', 'TEST_DATABASE_URL', 'ADMIN_DATABASE_URL']) {
    const value = process.env[key];
    if (!value) throw new Error('Missing isolated ' + key);
    const url = new URL(value);
    const dedicatedLocal = url.hostname === '127.0.0.1' && url.port === '55965';
    const hostedCi = process.env['GITHUB_ACTIONS'] === 'true' &&
      process.env['CI'] === 'true' &&
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost') && url.port === '5432';
    if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
        (!dedicatedLocal && !hostedCi) || url.pathname !== '/sher_test' ||
        url.username !== (key === 'ADMIN_DATABASE_URL' ? 'postgres' : 'sher_app')) {
      throw new Error('#344 support test refuses shared/development/production PostgreSQL');
    }
  }
  if (process.env['NODE_ENV'] !== 'test')
    throw new Error('#344 test refuses to run outside NODE_ENV=test');
}

let app: INestApplication;
let pool: pg.Pool;
let tenantA: SeededTenant;
let tenantB: SeededTenant;
let previousSupportPublicKey: string | undefined;
let previousEntitlementSource: string | undefined;

function timestamp(offsetMs: number): string {
  const value = clock.now();
  value.setTime(value.getTime() + offsetMs);
  return value.toISOString();
}
const { privateKey, publicKey } = generateKeyPairSync('ed25519');

function grantFor(tenant: SeededTenant, override: Partial<SupportGrant> = {}): string {
  // Clock-port time, not the ambient wall clock (R-B no-ambient-clock).
  const grant: SupportGrant = {
    session_id: id(),
    operator_id: signedActorOperator,
    operator_name: 'Regression QA',
    tenant_id: id(),
    erp_tenant_id: tenant.tenantId,
    installation_id: id(),
    issued_at: timestamp(-60_000),
    expires_at: timestamp(600_000),
    absolute_expires_at: timestamp(3_600_000),
    reason: 'Test support provenance and isolation',
    scope: 'SUPER_SUPPORT',
    signing_key_id: 'test-only-key',
    ...override,
  };
  const bytes = Buffer.from(SUPPORT_GRANT_PREFIX + '.' + canonicalSupportGrant(grant), 'utf8');
  const signature = sign(null, bytes, privateKey).toString('base64url');
  return Buffer.from(JSON.stringify({ grant, signature })).toString('base64');
}

async function addMaster(tenant: SeededTenant, kind: Kind, name: string): Promise<string> {
  const masterId = id();
  const now = clock.now();
  const extraColumn = kind === 'unit' ? ', symbol' : '';
  const extraValue = kind === 'unit' ? ", 'pcs'" : '';
  await asTenant(pool, tenant.tenantId, async client => {
    await client.query(
      'INSERT INTO ' + tables[kind] +
      '(id, tenant_id, name, name_bn, is_active, created_at, updated_at,' +
      'created_by, updated_by, version' + extraColumn + ')' +
      ' VALUES ($1, $2, $3, NULL, TRUE, $4, $4, $5, $5, 1' + extraValue + ')',
      [masterId, tenant.tenantId, name, now, tenant.userId],
    );
  });
  return masterId;
}
function get(kind: Kind, supportGrant: string) {
  return request(app.getHttpServer()).get(route(kind))
    .set(SUPPORT_GRANT_HEADER, supportGrant);
}
function patch(kind: Kind, masterId: string, supportGrant: string, expectedVersion = 1) {
  return request(app.getHttpServer()).patch(route(kind) + '/' + masterId + '/status')
    .set(SUPPORT_GRANT_HEADER, supportGrant)
    .send({ expectedVersion, desiredState: 'INACTIVE' });
}
async function sideEffects(tenant: SeededTenant): Promise<{
  audits: { created_by: string }[];
  outbox: { created_by: string }[];
  journal: number;
  stock: number;
  cash: number;
}> {
  return asTenant(pool, tenant.tenantId, async client => {
    const audits = await client.query<{ created_by: string }>(
      'SELECT created_by FROM audit_events WHERE tenant_id = $1 ORDER BY created_at',
      [tenant.tenantId],
    );
    const outbox = await client.query<{ created_by: string }>(
      'SELECT created_by FROM outbox WHERE tenant_id = $1 ORDER BY created_at',
      [tenant.tenantId],
    );
    const sums = await client.query<{ journal: number; stock: number; cash: number }>(
      'SELECT (SELECT count(*)::int FROM journal_entries) journal,' +
      ' (SELECT count(*)::int FROM stock_movements) stock,' +
      ' (SELECT count(*)::int FROM cash_movements) cash',
    );
    return { audits: audits.rows, outbox: outbox.rows, ...sums.rows[0]! };
  });
}

beforeAll(async () => {
  requireDisposableDatabase();
  previousSupportPublicKey = process.env['SUPPORT_PUBLIC_KEY'];
  previousEntitlementSource = process.env['ENTITLEMENT_SOURCE'];
  process.env['ENTITLEMENT_SOURCE'] = 'subscription';
  process.env['SUPPORT_PUBLIC_KEY'] = publicKey.export({
    format: 'der', type: 'spki',
  }).toString('base64');
  managementState.setInstallationTimezone('Asia/Dhaka');
  pool = testPool();
  await prepareTestDatabase();
  const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = module.createNestApplication();
  app.useGlobalFilters(new AppErrorFilter());
  await app.init();
}, 90_000);
afterAll(async () => {
  await app?.close();
  await pool?.end();
  if (previousSupportPublicKey === undefined) delete process.env['SUPPORT_PUBLIC_KEY'];
  else process.env['SUPPORT_PUBLIC_KEY'] = previousSupportPublicKey;
  if (previousEntitlementSource === undefined) delete process.env['ENTITLEMENT_SOURCE'];
  else process.env['ENTITLEMENT_SOURCE'] = previousEntitlementSource;
});
beforeEach(async () => {
  // Fresh tenant ULIDs isolate every case without repeatedly TRUNCATE-CASCADE
  // locking 98+ migrated tables while the Nest app holds pooled connections.
  // The whole dedicated sher_test database is disposed after the suite.
  // No ordinary shop role permissions: support permissions come from the signed
  // support ceiling, not a forged users row or an inherited owner token.
  tenantA = await seedTenant(pool, { name: 'Support tenant A', permissions: [] });
  tenantB = await seedTenant(pool, { name: 'Support tenant B', permissions: [] });
});

describe('MOD-002 #344 support-grant lifecycle with real PG16 FORCE RLS', () => {
  it('preserves the exact 26-character shop actor after widening provenance columns', async () => {
    const result = await asTenant(pool, tenantA.tenantId, client =>
      client.query<{ created_by: string }>(
        'SELECT created_by FROM users WHERE tenant_id=$1 AND id=$2',
        [tenantA.tenantId, tenantA.userId],
      ),
    );
    // PostgreSQL CHAR(34) pads a 26-char operator; application reads must
    // continue to compare exactly against the canonical ULID, with no spaces.
    expect(result.rows[0]?.created_by).toBe(tenantA.userId);
  });

  it.each(kindNames)('GET %s accepts a valid signed support grant without JWT and isolates tenants', async kind => {
    const own = await addMaster(tenantA, kind, 'Own ' + kind);
    const foreign = await addMaster(tenantB, kind, 'Foreign ' + kind);
    const response = await get(kind, grantFor(tenantA));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.entries.map((x: { id: string }) => x.id)).toEqual([own]);
    expect(response.text).not.toContain(foreign);
    expect(response.text).not.toContain(tenantB.tenantId);
    expect(await sideEffects(tenantA)).toEqual({
      audits: [], outbox: [], journal: 0, stock: 0, cash: 0,
    });
  });

  it.each(kindNames)('PATCH %s preserves full signed support actor through master/audit/outbox', async kind => {
    const masterId = await addMaster(tenantA, kind, 'Patch ' + kind);
    const grant = grantFor(tenantA);
    const changed = await patch(kind, masterId, grant);
    // RED before actor migration: PostgreSQL rejects the 34-character
    // support principal at one or more CHAR(26) provenance columns.
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body.data).toMatchObject({
      outcome: 'CHANGED', state: 'INACTIVE', version: 2,
    });
    const saved = await asTenant(pool, tenantA.tenantId, client =>
      client.query<{ updated_by: string; is_active: boolean; version: number }>(
        'SELECT updated_by, is_active, version FROM ' + tables[kind] + ' WHERE id=$1', [masterId],
      ),
    );
    expect(saved.rows[0]).toMatchObject({ updated_by: fullActor, is_active: false, version: 2 });
    expect(await sideEffects(tenantA)).toEqual({
      audits: [{ created_by: fullActor }], outbox: [{ created_by: fullActor }],
      journal: 0, stock: 0, cash: 0,
    });

    const noChange = await patch(kind, masterId, grant, 2);
    expect(noChange.status).toBe(200);
    expect(noChange.body.data.outcome).toBe('UNCHANGED');
    const stale = await patch(kind, masterId, grant, 1);
    expect(stale.status).toBe(409);
    expect(await sideEffects(tenantA)).toEqual({
      audits: [{ created_by: fullActor }], outbox: [{ created_by: fullActor }],
      journal: 0, stock: 0, cash: 0,
    });
  });

  it.each(kindNames)('PATCH %s is tenant-isolated and cannot write a foreign master', async kind => {
    const foreign = await addMaster(tenantB, kind, 'Foreign ' + kind);
    const hidden = await patch(kind, foreign, grantFor(tenantA));
    expect(hidden.status).toBe(404);
    const data = await asTenant(pool, tenantB.tenantId, client =>
      client.query<{ version: number; is_active: boolean }>(
        'SELECT version,is_active FROM ' + tables[kind] + ' WHERE id=$1', [foreign],
      ),
    );
    expect(data.rows[0]).toMatchObject({ version: 1, is_active: true });
  });

  it('rejects modified signed support grants, expired grants and forbidden identity routes', async () => {
    const original = grantFor(tenantA);
    const envelope = JSON.parse(Buffer.from(original, 'base64').toString('utf8')) as {
      grant: SupportGrant; signature: string;
    };
    envelope.grant = { ...envelope.grant, erp_tenant_id: tenantB.tenantId };
    const forged = Buffer.from(JSON.stringify(envelope)).toString('base64');
    expect((await get('unit', forged)).status).toBe(401);
    const expired = grantFor(tenantA, {
      expires_at: timestamp(-60_000),
    });
    expect((await get('unit', expired)).status).toBe(401);
    // This is a correctly signed, previously schema-valid identifier. It is
    // too wide for a support: prefix plus the 34-char persisted actor field.
    const oversized = grantFor(tenantA, { operator_id: 'X'.repeat(64) });
    expect((await get('unit', oversized)).status).toBe(401);
    const forbidden = await request(app.getHttpServer()).get('/api/v1/users')
      .set(SUPPORT_GRANT_HEADER, grantFor(tenantA));
    expect(forbidden.status).toBe(403);
    expect(await sideEffects(tenantA)).toEqual({
      audits: [], outbox: [], journal: 0, stock: 0, cash: 0,
    });
  });
});
