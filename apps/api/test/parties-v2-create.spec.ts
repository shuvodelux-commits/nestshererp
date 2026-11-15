/**
 * MOD-004 SEC-N02B (#308), signed non-owner Nest/PG16 acceptance.
 * RED-first for a future strict Party V2 directory-only POST.
 * @covers endpoint:POST /api/v2/parties
 */
import 'reflect-metadata';

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
import {
  asTenant, prepareTestDatabase, resetDatabase, seedTenant, testPool,
} from './support/database';

const clock = new SystemClock();
const permissions = [
  Permission.CUSTOMER_CREATE, Permission.CUSTOMER_VIEW,
  Permission.SUPPLIER_CREATE, Permission.SUPPLIER_VIEW,
  Permission.VENDOR_CREATE,
  Permission.SETTING_VIEW, Permission.SETTING_EDIT, Permission.SETTING_TOGGLE,
];
let app: INestApplication;
let pool: pg.Pool;
let tenant: SeededTenant;
let token: string;

const data = () => ({
  selectedRole: 'CUSTOMER', name: 'নতুন ক্রেতা',
  roles: ['CUSTOMER'], phone: '01712345678',
  address: null, guardianName: null, nid: null, email: null, notes: null,
  customerGroupId: null, creditLimitMinor: null,
});
const newId = () => Ulid.generate(clock);
const auth = (jwt = token) => ({ Authorization: 'Bearer ' + jwt });
const post = (body: unknown = data(), op = newId(), jwt = token) =>
  request(app.getHttpServer()).post('/api/v2/parties')
    .set(auth(jwt)).set('Idempotency-Key', op).send(body);
async function restrict(codes: readonly string[]): Promise<void> {
  await asTenant(pool, tenant.tenantId, async (client) => {
    await client.query('DELETE FROM role_permissions WHERE tenant_id=$1 AND role_id=$2',
      [tenant.tenantId, tenant.roleId]);
    const now = clock.now();
    for (const code of codes) {
      await client.query(
        'INSERT INTO role_permissions (id,tenant_id,role_id,permission_code,created_at,updated_at,created_by,updated_by,version) VALUES ($1,$2,$3,$4,$5,$5,$6,$6,1)',
        [newId(), tenant.tenantId, tenant.roleId, code, now, tenant.userId],
      );
    }
  });
}
interface Counts { parties: number; audit: number; outbox: number; idempotency: number; journal: number }
async function counts(t = tenant): Promise<Counts> {
  return asTenant(pool, t.tenantId, async (client) => {
    const count = async (table: string): Promise<number> => {
      const result = await client.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM ' + table + ' WHERE tenant_id=$1', [t.tenantId],
      );
      return result.rows[0]!.n;
    };
    return {
      parties: await count('parties'),
      audit: await count('audit_events'),
      outbox: await count('outbox'),
      idempotency: await count('idempotency_keys'),
      journal: await count('journal_entries'),
    };
  });
}
const isReceipt = (body: unknown): boolean => {
  if (!body || typeof body !== 'object' || !('data' in body)) return false;
  const row = (body as { data?: Record<string, unknown> }).data;
  return !!row && Object.keys(body).length === 1 &&
    Object.keys(row).sort().join(',') === 'id,selectedRole,status,version' &&
    typeof row.id === 'string' && row.id.length === 26 &&
    row.selectedRole === 'CUSTOMER' &&
    row.status === 'ACTIVE' && row.version === 1;
};

beforeAll(async () => {
  pool = testPool();
  await prepareTestDatabase();
  const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = module.createNestApplication();
  app.useGlobalFilters(new AppErrorFilter());
  await app.init();
}, 90_000);
afterAll(async () => { if (app) await app.close(); if (pool) await pool.end(); });
beforeEach(async () => {
  await resetDatabase(pool);
  tenant = await seedTenant(pool, { name: 'V2 Party Writer Tenant A', permissions });
  token = signToken(tenant, TEST_JWT_SECRET);
});

describe('MOD-004 SEC-N02B V2 Party creation isolation', () => {
  it('permits Customer CREATE without VIEW/private grants and returns only minimal receipt', async () => {
    await restrict([Permission.CUSTOMER_CREATE]);
    const before = await counts();
    const res = await post().expect(201);
    expect(isReceipt(res.body)).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('নতুন ক্রেতা');
    expect(JSON.stringify(res.body)).not.toContain('hasLedgerEntries');
    expect(JSON.stringify(res.body)).not.toContain('balance');
    await request(app.getHttpServer()).get('/api/v2/parties?role=CUSTOMER')
      .set(auth()).expect(403);
    const after = await counts();
    expect(after).toEqual({
      parties: before.parties + 1,
      audit: before.audit + 1,
      outbox: before.outbox + 1,
      idempotency: before.idempotency + 1,
      journal: before.journal,
    });
  });

  it('requires CREATE on every requested role before any side effects', async () => {
    await restrict([Permission.CUSTOMER_CREATE]);
    const before = await counts();
    const denied = await post({
      ...data(), roles: ['CUSTOMER', 'SUPPLIER'],
      selectedRole: 'CUSTOMER',
    }).expect(403);
    expect(denied.body.error.code).toBe('PERMISSION_DENIED');
    expect(await counts()).toEqual(before);
  });

  it('allows a shared identity with independently authorized roles but never echoes them', async () => {
    await restrict([Permission.CUSTOMER_CREATE, Permission.SUPPLIER_CREATE]);
    const res = await post({
      ...data(), roles: ['CUSTOMER', 'SUPPLIER'], selectedRole: 'CUSTOMER',
    }).expect(201);
    expect(isReceipt(res.body)).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('SUPPLIER');
    await restrict([Permission.CUSTOMER_VIEW]);
    const detail = await request(app.getHttpServer())
      .get('/api/v2/parties/' + res.body.data.id + '?role=CUSTOMER').set(auth()).expect(200);
    expect(detail.body.data.roles).toEqual(['CUSTOMER']);
    expect(detail.body.data.profile).toEqual({ state: 'WITHHELD' });
    expect(detail.body.data.globalHistory).toEqual({ state: 'WITHHELD' });
  });

  it('denies attempted NID input without private-profile authority without storing a Party', async () => {
    await request(app.getHttpServer()).post('/api/v1/settings/value')
      .set(auth()).send({ key: SettingKey.CUSTOMER_FIELD_NID_VISIBLE, value: 'on' }).expect(201);
    await restrict([Permission.CUSTOMER_CREATE]);
    const before = await counts();
    const denied = await post({ ...data(), nid: 'NID-PRIVATE-N02B' }).expect(403);
    expect(denied.body.error.code).toBe('PERMISSION_DENIED');
    expect(await counts()).toEqual(before);
  });

  it('allows authorized private input without echoing NID, profile or global history', async () => {
    await request(app.getHttpServer()).post('/api/v1/settings/value')
      .set(auth()).send({ key: SettingKey.CUSTOMER_FIELD_NID_VISIBLE, value: 'on' }).expect(201);
    await restrict([Permission.CUSTOMER_CREATE, Permission.PARTY_PROFILE_VIEW]);
    const res = await post({ ...data(), nid: 'NID-PRIVATE-N02B' }).expect(201);
    expect(isReceipt(res.body)).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('NID-PRIVATE-N02B');
    const stored = await asTenant(pool, tenant.tenantId, c => c.query<{ nid: string }>(
      'SELECT nid FROM parties WHERE tenant_id=$1 AND id=$2',
      [tenant.tenantId, res.body.data.id],
    ));
    expect(stored.rows[0]?.nid).toBe('NID-PRIVATE-N02B');
  });

  it('replays the same public receipt once, rejects changed fingerprint and permission revocation', async () => {
    await restrict([Permission.CUSTOMER_CREATE]);
    const op = newId();
    const first = await post(data(), op).expect(201);
    const after = await counts();
    expect(isReceipt(first.body)).toBe(true);
    const second = await post(data(), op).expect(201);
    expect(second.body).toEqual(first.body);
    expect(await counts()).toEqual(after);
    const conflict = await post({ ...data(), name: 'A different person' }, op).expect(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await counts()).toEqual(after);
    await restrict([]);
    const denied = await post(data(), op).expect(403);
    expect(denied.body.error.code).toBe('PERMISSION_DENIED');
    expect(await counts()).toEqual(after);
  });

  it('never treats a V2 operation ID as a V1 raw PartyResponse replay', async () => {
    const op = newId();
    const created = await post(data(), op).expect(201);
    expect(isReceipt(created.body)).toBe(true);
    const { selectedRole: _notV1, ...v1body } = data();
    const v1 = await request(app.getHttpServer()).post('/api/v1/parties')
      .set(auth()).set('Idempotency-Key', op).send(v1body).expect(409);
    expect(v1.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await counts()).parties).toBeGreaterThan(0);
  });

  it('rejects V1-idempotency collisions when V1 was created first', async () => {
    const op = newId();
    const { selectedRole: _v2, ...v1body } = data();
    await request(app.getHttpServer()).post('/api/v1/parties')
      .set(auth()).set('Idempotency-Key', op).send(v1body).expect(201);
    const result = await post(data(), op).expect(409);
    expect(result.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('rejects absent/invalid key, incorrect relationship, duplicate roles and all opening payloads', async () => {
    const before = await counts();
    await request(app.getHttpServer()).post('/api/v2/parties')
      .set(auth()).send(data()).expect(400);
    await request(app.getHttpServer()).post('/api/v2/parties')
      .set(auth()).set('Idempotency-Key', 'short').send(data()).expect(400);
    for (const invalid of [
      { ...data(), selectedRole: 'SUPPLIER' },
      { ...data(), roles: ['CUSTOMER', 'CUSTOMER'] },
      { ...data(), roles: ['CUSTOMER', 'PAYEE'] },
      { ...data(), opening: null },
      { ...data(), opening: { role: 'CUSTOMER', amountMinor: 1000, direction: 'RECEIVABLE', businessDate: '2026-11-15' } },
    ]) {
      await post(invalid).expect(400);
    }
    expect(await counts()).toEqual(before);
  });

  it('honors Vendor feature-off before a new create and returns no private data', async () => {
    await restrict([Permission.VENDOR_CREATE]);
    const before = await counts();
    const denied = await post({
      ...data(), selectedRole: 'VENDOR', roles: ['VENDOR'], phone: null,
    }).expect(403);
    expect(denied.body.error.code).toBe('FEATURE_DISABLED');
    expect(await counts()).toEqual(before);
  });

  it('separates tenant identities and operation IDs even when two shops submit the same key', async () => {
    const other = await seedTenant(pool, {
      name: 'V2 Party Writer Tenant B', permissions: [Permission.CUSTOMER_CREATE],
    });
    const op = newId();
    const first = await post(data(), op).expect(201);
    const second = await post(data(), op, signToken(other, TEST_JWT_SECRET)).expect(201);
    expect(second.body.data.id).not.toBe(first.body.data.id);
    expect(isReceipt(second.body)).toBe(true);
    expect((await counts(tenant)).journal).toBe(0);
    expect((await counts(other)).journal).toBe(0);
  });

  it('never serves an unauthenticated writer', async () => {
    await request(app.getHttpServer()).post('/api/v2/parties')
      .set('Idempotency-Key', newId()).send(data()).expect(401);
  });
});
