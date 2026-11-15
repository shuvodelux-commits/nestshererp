/**
 * MOD-004 T09C-P2 — signed Party V2 HTTP and real PostgreSQL16/RLS regression.
 * Isolated test DATABASE_URL and ADMIN_DATABASE_URL must point to an ephemeral
 * non-production container. V1 disclosures are documented, NOT certified safe.
 * @covers endpoint:GET /api/v2/parties/:id/ledger
 * @covers endpoint:GET /api/v2/parties/:id/opening
 */
import 'reflect-metadata';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  partyLedgerResponseSchema,
  partyOpeningResponseSchema,
  partyReadV2ListResponseSchema,
  partyReadV2Schema,
  Permission,
  SettingKey,
} from '@sher/core-contracts';
import { SystemClock, Ulid } from '@sher/shared-utils';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { AppErrorFilter } from '../src/common/app-error.filter';
import { signToken, TEST_JWT_SECRET } from './support/auth';
import type { SeededTenant } from './support/database';
import { asTenant, prepareTestDatabase, resetDatabase, seedTenant, testPool } from './support/database';

const clock = new SystemClock();
const PROFILE = 'party.profile.view';
const HISTORY = 'party.history.global.view';
const OWNER_FIXTURE_GRANTS = [
  Permission.CUSTOMER_VIEW, Permission.CUSTOMER_CREATE, Permission.CUSTOMER_EDIT,
  Permission.CUSTOMER_DEACTIVATE, Permission.SUPPLIER_VIEW, Permission.SUPPLIER_CREATE,
  Permission.SUPPLIER_EDIT, Permission.SUPPLIER_DEACTIVATE,
  Permission.VENDOR_CREATE, Permission.VENDOR_VIEW,
  Permission.SETTING_VIEW, Permission.SETTING_EDIT, Permission.SETTING_TOGGLE,
];

let app: INestApplication;
let pool: pg.Pool;
let tenant: SeededTenant;
let token: string;

const auth = (as = token) => ({ Authorization: 'Bearer ' + as });

function v2List(role: string, as = token): request.Test {
  return request(app.getHttpServer()).get('/api/v2/parties?role=' + role).set(auth(as));
}
function v2Get(id: string, role = 'CUSTOMER', as = token): request.Test {
  return request(app.getHttpServer()).get('/api/v2/parties/' + id + '?role=' + role).set(auth(as));
}

/** Direct test-only role grant provisioning; never constructs financial rows. */
async function restrict(codes: readonly string[]): Promise<void> {
  await asTenant(pool, tenant.tenantId, async (client) => {
    await client.query(
      'DELETE FROM role_permissions WHERE tenant_id = $1 AND role_id = $2',
      [tenant.tenantId, tenant.roleId],
    );
    const now = clock.now();
    for (const code of codes) {
      await client.query(
        'INSERT INTO role_permissions (id, tenant_id, role_id, permission_code, created_at, updated_at, created_by, updated_by, version) VALUES ($1, $2, $3, $4, $5, $5, $6, $6, 1)',
        [Ulid.generate(clock), tenant.tenantId, tenant.roleId, code, now, tenant.userId],
      );
    }
  });
}

async function enableProfileFields(): Promise<void> {
  for (const key of [
    SettingKey.CUSTOMER_FIELD_ADDRESS_VISIBLE,
    SettingKey.CUSTOMER_FIELD_GUARDIAN_VISIBLE,
    SettingKey.CUSTOMER_FIELD_NID_VISIBLE,
    SettingKey.CUSTOMER_FIELD_EMAIL_VISIBLE,
    SettingKey.CUSTOMER_FIELD_NOTES_VISIBLE,
  ]) {
    await request(app.getHttpServer())
      .post('/api/v1/settings/value').set(auth()).send({ key, value: 'on' }).expect(201);
  }
}

/** Create a shared relationship, posting Supplier history through its real source writer. */
async function createShared(): Promise<string> {
  await enableProfileFields();
  const created = await request(app.getHttpServer())
    .post('/api/v1/parties').set(auth()).set('Idempotency-Key', Ulid.generate(clock))
    .send({
      name: 'P2 Dual Trading Identity',
      roles: ['CUSTOMER', 'SUPPLIER'],
      phone: '01712345678',
      address: 'Private Natore address',
      guardianName: 'Private guardian',
      nid: 'NID-PRIVATE-P2',
      email: 'private-p2@example.test',
      notes: 'P2 private notes',
      customerGroupId: null,
      creditLimitMinor: null,
    }).expect(201);
  const id = created.body.data.id as string;
  await request(app.getHttpServer())
    .post('/api/v1/parties/' + id + '/opening')
    .set(auth()).set('Idempotency-Key', Ulid.generate(clock))
    .send({
      role: 'SUPPLIER', direction: 'PAYABLE', amountMinor: 315_000,
      businessDate: clock.businessDate('Asia/Dhaka'),
    }).expect(201);
  return id;
}

beforeAll(async () => {
  pool = testPool();
  await prepareTestDatabase();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.useGlobalFilters(new AppErrorFilter());
  await app.init();
});
afterAll(async () => { await app.close(); await pool.end(); });
beforeEach(async () => {
  await resetDatabase(pool);
  tenant = await seedTenant(pool, { name: 'T09C P2 Isolated Tenant A', permissions: OWNER_FIXTURE_GRANTS });
  token = signToken(tenant, TEST_JWT_SECRET);
});

describe('MOD-004 T09C-P2 — versioned Party read authorization', () => {
  it('registers two independent permissions and withholds profile/history for Customer VIEW alone', async () => {
    expect(Permission.PARTY_PROFILE_VIEW).toBe(PROFILE);
    expect(Permission.PARTY_HISTORY_GLOBAL_VIEW).toBe(HISTORY);
    const id = await createShared();
    await restrict([Permission.CUSTOMER_VIEW]);
    const list = await v2List('CUSTOMER').expect(200);
    expect(partyReadV2ListResponseSchema.safeParse(list.body).success).toBe(true);
    expect(list.body.data).toHaveLength(1);
    const party = list.body.data[0];
    expect(party.id).toBe(id);
    expect(party.readRole).toBe('CUSTOMER');
    expect(party.roles).toEqual(['CUSTOMER']);
    expect(party.balance.netMinor).toBe(0);
    expect(party.profile).toEqual({ state: 'WITHHELD' });
    expect(party.globalHistory).toEqual({ state: 'WITHHELD' });
    expect(JSON.stringify(list.body)).not.toContain('NID-PRIVATE-P2');
    expect(JSON.stringify(list.body)).not.toContain('Private guardian');
    expect(JSON.stringify(list.body)).not.toContain('315000');
    const detail = await v2Get(id).expect(200);
    expect(partyReadV2Schema.safeParse(detail.body.data).success).toBe(true);
    expect(detail.body.data.profile).toEqual({ state: 'WITHHELD' });
    expect(detail.body.data.globalHistory).toEqual({ state: 'WITHHELD' });
    await v2Get(id, 'SUPPLIER').expect(403);
  });

  it('separates profile visibility from history and revokes both per HTTP request', async () => {
    const id = await createShared();
    await restrict([Permission.CUSTOMER_VIEW, PROFILE]);
    const profileOnly = (await v2Get(id).expect(200)).body.data;
    expect(profileOnly.profile.state).toBe('VISIBLE');
    expect(profileOnly.profile.data.nid).toBe('NID-PRIVATE-P2');
    expect(profileOnly.globalHistory).toEqual({ state: 'WITHHELD' });

    await restrict([Permission.CUSTOMER_VIEW, HISTORY]);
    const historyOnly = (await v2Get(id).expect(200)).body.data;
    expect(historyOnly.profile).toEqual({ state: 'WITHHELD' });
    expect(historyOnly.globalHistory).toEqual({ state: 'VISIBLE', hasLedgerEntries: true });

    await restrict([Permission.CUSTOMER_VIEW, PROFILE, HISTORY]);
    const both = (await v2Get(id).expect(200)).body.data;
    expect(both.profile.state).toBe('VISIBLE');
    expect(both.globalHistory.hasLedgerEntries).toBe(true);

    await restrict([Permission.CUSTOMER_VIEW]);
    const revoked = (await v2Get(id).expect(200)).body.data;
    expect(revoked.profile).toEqual({ state: 'WITHHELD' });
    expect(revoked.globalHistory).toEqual({ state: 'WITHHELD' });
  });

  it('does not treat elevated grants as permission to see the selected trading role', async () => {
    const id = await createShared();
    await restrict([PROFILE, HISTORY]);
    await v2List('CUSTOMER').expect(403);
    await v2Get(id).expect(403);
    await restrict([Permission.CUSTOMER_VIEW, PROFILE, HISTORY]);
    await v2Get(id, 'SUPPLIER').expect(403);
  });

  it('never nets Supplier payable into Customer balance, even for a dual-role viewer', async () => {
    const id = await createShared();
    await restrict([Permission.CUSTOMER_VIEW, Permission.SUPPLIER_VIEW, HISTORY]);
    const customer = (await v2Get(id, 'CUSTOMER').expect(200)).body.data;
    const supplier = (await v2Get(id, 'SUPPLIER').expect(200)).body.data;
    expect(customer.balance.netMinor).toBe(0);
    expect(supplier.balance.netMinor).toBe(-315_000);
    expect(customer.roles).toEqual(['CUSTOMER', 'SUPPLIER']);
    expect(customer.globalHistory).toEqual({ state: 'VISIBLE', hasLedgerEntries: true });
    await request(app.getHttpServer())
      .get('/api/v2/parties/' + id).set(auth()).expect(400);
  });

  it('enforces tenant RLS and revoked relationship VIEW, not merely token possession', async () => {
    const id = await createShared();
    const other = await seedTenant(pool, {
      name: 'T09C P2 Isolated Tenant B',
      permissions: [Permission.CUSTOMER_VIEW, PROFILE, HISTORY],
    });
    const otherToken = signToken(other, TEST_JWT_SECRET);
    expect((await v2List('CUSTOMER', otherToken).expect(200)).body.data).toEqual([]);
    await v2Get(id, 'CUSTOMER', otherToken).expect(404);
    await restrict([]);
    await v2List('CUSTOMER').expect(403);
    await v2Get(id).expect(403);
  });

  it('keeps role selection validation strict and prevents unauthorized role queries', async () => {
    const id = await createShared();
    await restrict([Permission.CUSTOMER_VIEW]);
    await request(app.getHttpServer()).get('/api/v2/parties').set(auth()).expect(400);
    await request(app.getHttpServer()).get('/api/v2/parties?role=INVALID').set(auth()).expect(400);
    await v2List('SUPPLIER').expect(403);
    await v2Get(id, 'INVALID').expect(400);
    await v2List('CUSTOMER').expect(200);
  });

  it('keeps global posted-history deletion guard despite withholding it from raw V2', async () => {
    const usedId = await createShared();
    const unused = await request(app.getHttpServer())
      .post('/api/v1/parties').set(auth()).set('Idempotency-Key', Ulid.generate(clock))
      .send({
        name: 'P2 Unused Customer', roles: ['CUSTOMER'], phone: '01799991111',
        address: null, guardianName: null, nid: null, email: null, notes: null,
        customerGroupId: null, creditLimitMinor: null,
      }).expect(201);
    const unusedId = unused.body.data.id as string;
    await restrict([Permission.CUSTOMER_VIEW, Permission.CUSTOMER_DEACTIVATE]);
    const masked = (await v2Get(usedId).expect(200)).body.data;
    expect(masked.globalHistory).toEqual({ state: 'WITHHELD' });
    const denied = await request(app.getHttpServer()).delete('/api/v1/parties/' + usedId)
      .set(auth()).expect(403);
    expect(denied.body.error.code).toBe('PERMISSION_DENIED');
    // Only once every affected role grants DEACTIVATE may the caller learn
    // that global posted history makes even an authorized deletion impossible.
    await restrict([
      Permission.CUSTOMER_VIEW, Permission.CUSTOMER_DEACTIVATE,
      Permission.SUPPLIER_DEACTIVATE,
    ]);
    const posted = await request(app.getHttpServer()).delete('/api/v1/parties/' + usedId)
      .set(auth()).expect(400);
    expect(posted.body.error.code).toBe('VALIDATION_FAILED');
    await request(app.getHttpServer()).delete('/api/v1/parties/' + unusedId)
      .set(auth()).expect(204);
    const retained = await asTenant(pool, tenant.tenantId, (client) => client.query(
      'SELECT count(*)::int AS count FROM journal_lines WHERE tenant_id = $1 AND party_id = $2 AND account_code = $3',
      [tenant.tenantId, usedId, 'AP'],
    ));
    expect(retained.rows[0].count).toBe(1);
  });

  it('conceals existing Supplier-only identity exactly like an absent ID for a Customer-only caller', async () => {
    const supplier = await request(app.getHttpServer())
      .post('/api/v1/parties').set(auth()).set('Idempotency-Key', Ulid.generate(clock))
      .send({
        name: 'P2 Private Supplier Only', roles: ['SUPPLIER'], phone: null,
        address: null, guardianName: null, nid: null, email: null, notes: null,
        customerGroupId: null, creditLimitMinor: null,
      }).expect(201);
    const hiddenId = supplier.body.data.id as string;
    const absentId = Ulid.generate(clock);

    await restrict([Permission.CUSTOMER_VIEW]);
    const hidden = await v2Get(hiddenId, 'CUSTOMER');
    const absent = await v2Get(absentId, 'CUSTOMER');
    expect(hidden.status).toBe(404);
    expect(absent.status).toBe(404);
    expect(hidden.body.error.code).toBe(absent.body.error.code);
    expect(hidden.body.error.message).toBe(absent.body.error.message);
    expect(hidden.body.error.details).toEqual(absent.body.error.details);
    await v2Get(hiddenId, 'SUPPLIER').expect(403);
  });

  it('gates Vendor-only V2 detail when Vendor Management is disabled just like V2 list', async () => {
    await request(app.getHttpServer()).post('/api/v1/settings/value')
      .set(auth()).send({ key: SettingKey.VENDOR_MANAGEMENT_ENABLED, value: 'on' }).expect(201);
    const vendor = await request(app.getHttpServer())
      .post('/api/v1/parties').set(auth()).set('Idempotency-Key', Ulid.generate(clock))
      .send({
        name: 'P2 Vendor Feature-Off', roles: ['VENDOR'], phone: null,
        address: null, guardianName: null, nid: null, email: null, notes: null,
        customerGroupId: null, creditLimitMinor: null,
      }).expect(201);
    const vendorId = vendor.body.data.id as string;
    await request(app.getHttpServer()).post('/api/v1/settings/value')
      .set(auth()).send({ key: SettingKey.VENDOR_MANAGEMENT_ENABLED, value: 'off' }).expect(201);
    await restrict([Permission.VENDOR_VIEW]);
    const list = await v2List('VENDOR').expect(403);
    const detail = await v2Get(vendorId, 'VENDOR').expect(403);
    expect(list.body.error.code).toBe('FEATURE_DISABLED');
    expect(detail.body.error.code).toBe(list.body.error.code);
  });

  it('reproduces the still-unfixed V1 raw disclosure as an explicit RED release blocker', async () => {
    const id = await createShared();
    await restrict([Permission.CUSTOMER_VIEW]);
    const v1 = await request(app.getHttpServer())
      .get('/api/v1/parties/' + id + '?role=CUSTOMER').set(auth()).expect(200);
    // These assertions CONFIRM THE VULNERABILITY, not a secure result. #72/#93
    // remain open until V1 is restricted without breaking React/Vue clients.
    expect(v1.body.data.hasLedgerEntries).toBe(true);
    expect(v1.body.data.nid).toBe('NID-PRIVATE-P2');
    expect(v1.body.data.roles).toEqual(['CUSTOMER']);
    expect(v1.body.data.balance.netMinor).toBe(0);
  });
});


describe('MOD-004 T13-N — versioned selected-role ledger', () => {
  const ledger = (id: string, query: string, as = token): request.Test =>
    request(app.getHttpServer()).get('/api/v2/parties/' + id + '/ledger' + query).set(auth(as));

  it('uses exact role-specific journal poisha, never Supplier amount in Customer statement', async () => {
    const id = await createShared();
    await restrict([Permission.CUSTOMER_VIEW]);

    const customer = await ledger(id, '?role=CUSTOMER').expect(200);
    expect(partyLedgerResponseSchema.safeParse(customer.body).success).toBe(true);
    expect(customer.body.partyId).toBe(id);
    expect(customer.body.rows).toEqual([]);
    expect(customer.body.openingBalance.netMinor).toBe(0);
    expect(customer.body.closingBalance.netMinor).toBe(0);
    expect(JSON.stringify(customer.body)).not.toContain('315000');
    expect(JSON.stringify(customer.body)).not.toContain('NID-PRIVATE-P2');
    expect(JSON.stringify(customer.body)).not.toContain('P2 private notes');

    await ledger(id, '?role=SUPPLIER').expect(403);
    await restrict([Permission.SUPPLIER_VIEW]);
    const supplier = await ledger(id, '?role=SUPPLIER').expect(200);
    expect(partyLedgerResponseSchema.safeParse(supplier.body).success).toBe(true);
    expect(supplier.body.partyId).toBe(id);
    expect(supplier.body.closingBalance.netMinor).toBe(-315_000);
    expect(supplier.body.rows).toHaveLength(1);
    expect(supplier.body.rows[0].account).toBe('AP');
    expect(supplier.body.rows[0].sourceDocumentType).toBe('OPENING_BALANCE');
    expect(supplier.body.rows[0].sourceDocumentId).toHaveLength(26);
    expect(supplier.body.rows[0].journalLineId).toHaveLength(26);
    expect(JSON.stringify(supplier.body)).not.toContain('NID-PRIVATE-P2');
    expect(JSON.stringify(supplier.body)).not.toContain('P2 private notes');
  });

  it('requires a recognized role and rejects unknown query keys, cursors and limits', async () => {
    const id = await createShared();
    for (const query of [
      '', '?role=OWNER', '?role=INVALID', '?role=CUSTOMER&unexpected=1',
      '?role=CUSTOMER&cursor=invalid', '?role=CUSTOMER&limit=0',
      '?role=CUSTOMER&limit=201', '?role=CUSTOMER&fromDate=invalid',
    ]) {
      const denied = await ledger(id, query).expect(400);
      expect(denied.body.error.code).toBe('VALIDATION_FAILED');
    }
    await ledger(id, '?role=CUSTOMER&limit=1').expect(200);
  });

  it('does not distinguish hidden selected-role identity, nonexistent ID or foreign tenant', async () => {
    const shared = await createShared();
    const supplier = await request(app.getHttpServer())
      .post('/api/v1/parties').set(auth()).set('Idempotency-Key', Ulid.generate(clock))
      .send({
        name: 'T13 private supplier-only', roles: ['SUPPLIER'], phone: null,
        address: null, guardianName: null, nid: null, email: null, notes: null,
        customerGroupId: null, creditLimitMinor: null,
      }).expect(201);
    const supplierOnlyId = supplier.body.data.id as string;
    const missingId = Ulid.generate(clock);
    await restrict([Permission.CUSTOMER_VIEW]);

    const deniedExisting = await ledger(shared, '?role=SUPPLIER').expect(403);
    const deniedMissing = await ledger(missingId, '?role=SUPPLIER').expect(403);
    expect(deniedExisting.body.error.code).toBe(deniedMissing.body.error.code);
    expect(deniedExisting.body.error.message).toBe(deniedMissing.body.error.message);
    expect(deniedExisting.body.error.details).toEqual(deniedMissing.body.error.details);

    const hidden = await ledger(supplierOnlyId, '?role=CUSTOMER').expect(404);
    const absent = await ledger(missingId, '?role=CUSTOMER').expect(404);
    expect(hidden.body.error.code).toBe(absent.body.error.code);
    expect(hidden.body.error.message).toBe(absent.body.error.message);
    expect(hidden.body.error.details).toEqual(absent.body.error.details);
    expect(JSON.stringify(hidden.body)).not.toContain('T13 private supplier-only');

    const foreign = await seedTenant(pool, {
      name: 'T13-N other ledger tenant', permissions: [Permission.SUPPLIER_VIEW],
    });
    const foreignToken = signToken(foreign, TEST_JWT_SECRET);
    const other = await ledger(shared, '?role=SUPPLIER', foreignToken).expect(404);
    const otherAbsent = await ledger(missingId, '?role=SUPPLIER', foreignToken).expect(404);
    expect(other.body.error.code).toBe(otherAbsent.body.error.code);
    expect(other.body.error.message).toBe(otherAbsent.body.error.message);
    expect(other.body.error.details).toEqual(otherAbsent.body.error.details);
  });

  it('matches V2 Vendor feature OFF/ON policy before identity lookup and never posts from GET', async () => {
    await request(app.getHttpServer()).post('/api/v1/settings/value')
      .set(auth()).send({ key: SettingKey.VENDOR_MANAGEMENT_ENABLED, value: 'on' }).expect(201);
    const created = await request(app.getHttpServer())
      .post('/api/v1/parties').set(auth()).set('Idempotency-Key', Ulid.generate(clock))
      .send({
        name: 'T13 Vendor identity', roles: ['VENDOR'], phone: null,
        address: null, guardianName: null, nid: null, email: null, notes: null,
        customerGroupId: null, creditLimitMinor: null,
      }).expect(201);
    const vendorId = created.body.data.id as string;
    const missing = Ulid.generate(clock);
    await restrict([Permission.VENDOR_VIEW]);
    const countJournals = async (): Promise<number> => {
      const r = await asTenant(pool, tenant.tenantId, (client) => client.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM journal_lines WHERE tenant_id = $1',
        [tenant.tenantId],
      ));
      const row = r.rows[0];
      if (row === undefined) throw new Error('Journal count query returned no row');
      return row.count;
    };
    const originalLines = await countJournals();
    await ledger(vendorId, '?role=VENDOR').expect(200);
    expect(await countJournals()).toBe(originalLines);

    await restrict([
      Permission.VENDOR_VIEW, Permission.SETTING_EDIT, Permission.SETTING_VIEW,
      Permission.SETTING_TOGGLE,
    ]);
    await request(app.getHttpServer()).post('/api/v1/settings/value')
      .set(auth()).send({ key: SettingKey.VENDOR_MANAGEMENT_ENABLED, value: 'off' }).expect(201);
    await restrict([Permission.VENDOR_VIEW]);
    const disabled = await ledger(vendorId, '?role=VENDOR').expect(403);
    const disabledMissing = await ledger(missing, '?role=VENDOR').expect(403);
    expect(disabled.body.error.code).toBe('FEATURE_DISABLED');
    expect(disabled.body.error.code).toBe(disabledMissing.body.error.code);
    expect(disabled.body.error.message).toBe(disabledMissing.body.error.message);
    expect(disabled.body.error.details).toEqual(disabledMissing.body.error.details);
    expect(await countJournals()).toBe(originalLines);
  });
});


describe('MOD-004 T15-N — versioned historical opening read', () => {
  const opening = (id: string, query: string, as = token): request.Test =>
    request(app.getHttpServer()).get('/api/v2/parties/' + id + '/opening' + query).set(auth(as));

  it('separates Supplier historical payable source from Customer missing opening, without cash session', async () => {
    const id = await createShared();
    await restrict([Permission.CUSTOMER_VIEW]);
    const customer = await opening(id, '?role=CUSTOMER').expect(200);
    expect(customer.body).toEqual({ data: null });
    expect(JSON.stringify(customer.body)).not.toContain('315000');
    expect(JSON.stringify(customer.body)).not.toContain('NID-PRIVATE-P2');
    await opening(id, '?role=SUPPLIER').expect(403);

    await restrict([Permission.SUPPLIER_VIEW]);
    const supplier = await opening(id, '?role=SUPPLIER').expect(200);
    expect(partyOpeningResponseSchema.safeParse(supplier.body.data).success).toBe(true);
    expect(supplier.body.data.role).toBe('SUPPLIER');
    expect(supplier.body.data.direction).toBe('PAYABLE');
    expect(supplier.body.data.amountMinor).toBe(315_000);
    expect(supplier.body.data.id).toHaveLength(26);
    expect(supplier.body.data.number).toMatch(/^OPN-/);
    expect(supplier.body.data.businessDate).toBe(clock.businessDate('Asia/Dhaka'));
    expect(supplier.body.data.version).toBeGreaterThan(0);
    expect(JSON.stringify(supplier.body)).not.toContain('NID-PRIVATE-P2');
    expect(JSON.stringify(supplier.body)).not.toContain('P2 private notes');
  });

  it('strictly requires one recognized role, without extra query keys', async () => {
    const id = await createShared();
    for (const query of ['', '?role=OWNER', '?role=INVALID',
      '?role=SUPPLIER&foo=1', '?role=CUSTOMER&role=SUPPLIER']) {
      const bad = await opening(id, query).expect(400);
      expect(bad.body.error.code).toBe('VALIDATION_FAILED');
    }
    await opening(id, '?role=CUSTOMER').expect(200);
  });

  it('denies unauthorized existing and absent identities uniformly; hides other role and tenant', async () => {
    const dual = await createShared();
    const supplier = await request(app.getHttpServer())
      .post('/api/v1/parties').set(auth()).set('Idempotency-Key', Ulid.generate(clock))
      .send({
        name: 'T15 Supplier Only', roles: ['SUPPLIER'], phone: null,
        address: null, guardianName: null, nid: null, email: null, notes: null,
        customerGroupId: null, creditLimitMinor: null,
      }).expect(201);
    const supplierOnly = supplier.body.data.id as string;
    const missing = Ulid.generate(clock);
    await restrict([Permission.CUSTOMER_VIEW]);
    const denied = await opening(dual, '?role=SUPPLIER').expect(403);
    const deniedMissing = await opening(missing, '?role=SUPPLIER').expect(403);
    expect(denied.body.error.code).toBe(deniedMissing.body.error.code);
    expect(denied.body.error.message).toBe(deniedMissing.body.error.message);
    expect(denied.body.error.details).toEqual(deniedMissing.body.error.details);

    const hidden = await opening(supplierOnly, '?role=CUSTOMER').expect(404);
    const absent = await opening(missing, '?role=CUSTOMER').expect(404);
    expect(hidden.body.error.code).toBe(absent.body.error.code);
    expect(hidden.body.error.message).toBe(absent.body.error.message);
    expect(hidden.body.error.details).toEqual(absent.body.error.details);
    expect(JSON.stringify(hidden.body)).not.toContain('T15 Supplier Only');

    const foreign = await seedTenant(pool, {
      name: 'T15 Other Tenant', permissions: [Permission.SUPPLIER_VIEW],
    });
    const otherToken = signToken(foreign, TEST_JWT_SECRET);
    const foreignResult = await opening(dual, '?role=SUPPLIER', otherToken).expect(404);
    const foreignAbsent = await opening(missing, '?role=SUPPLIER', otherToken).expect(404);
    expect(foreignResult.body.error.code).toBe(foreignAbsent.body.error.code);
    expect(foreignResult.body.error.message).toBe(foreignAbsent.body.error.message);
  });

  it('enforces Vendor toggle before identity lookup; GET adds no source or journal lines', async () => {
    await request(app.getHttpServer()).post('/api/v1/settings/value')
      .set(auth()).send({ key: SettingKey.VENDOR_MANAGEMENT_ENABLED, value: 'on' }).expect(201);
    const vendor = await request(app.getHttpServer())
      .post('/api/v1/parties').set(auth()).set('Idempotency-Key', Ulid.generate(clock))
      .send({
        name: 'T15 Vendor No Opening', roles: ['VENDOR'], phone: null,
        address: null, guardianName: null, nid: null, email: null, notes: null,
        customerGroupId: null, creditLimitMinor: null,
      }).expect(201);
    const vendorId = vendor.body.data.id as string;
    const missing = Ulid.generate(clock);
    const journalCount = async (): Promise<number> => {
      const rows = await asTenant(pool, tenant.tenantId, client => client.query<{ total: number }>(
        'SELECT count(*)::int AS total FROM journal_lines WHERE tenant_id = $1',
        [tenant.tenantId],
      ));
      const row = rows.rows[0];
      if (row === undefined) throw new Error('Missing journal count row');
      return row.total;
    };
    const before = await journalCount();
    await restrict([Permission.VENDOR_VIEW]);
    expect((await opening(vendorId, '?role=VENDOR').expect(200)).body).toEqual({ data: null });
    expect(await journalCount()).toBe(before);

    await restrict([Permission.VENDOR_VIEW, Permission.SETTING_EDIT,
      Permission.SETTING_VIEW, Permission.SETTING_TOGGLE]);
    await request(app.getHttpServer()).post('/api/v1/settings/value')
      .set(auth()).send({ key: SettingKey.VENDOR_MANAGEMENT_ENABLED, value: 'off' }).expect(201);
    await restrict([Permission.VENDOR_VIEW]);
    const disabled = await opening(vendorId, '?role=VENDOR').expect(403);
    const absent = await opening(missing, '?role=VENDOR').expect(403);
    expect(disabled.body.error.code).toBe('FEATURE_DISABLED');
    expect(disabled.body.error.code).toBe(absent.body.error.code);
    expect(disabled.body.error.message).toBe(absent.body.error.message);
    expect(await journalCount()).toBe(before);
  });
});
