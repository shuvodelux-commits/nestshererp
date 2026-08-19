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
  asTenant,
  prepareTestDatabase,
  resetDatabase,
  seedTenant,
  testPool,
} from './support/database';

/**
 * Phase 2, path 2.3 — parties (§5.6, D-02, D-04). Expected values written before
 * the code.
 *
 * ৳5,000.00 of credit is `500000` poisha, asserted as that exact integer — a
 * float anywhere in this path is the drift §3.3 exists to prevent.
 *
 * The rules that would be expensive to get wrong:
 *
 *   A customer's phone is mandatory and unique within the CUSTOMER role; a
 *   supplier's is not, and a supplier may share a customer's number (D-02).
 *
 *   One party, several roles: a supplier you also sell to is one record with
 *   one identity, appearing under both tabs (D-04).
 *
 *   The walk-in party cannot be renamed, deactivated or deleted, because every
 *   fully paid counter sale will point at it.
 *
 *   A field the shop has switched off is not editable and is never cleared.
 *
 *   The same `Idempotency-Key` twice creates one record, not two.
 */
const clock = new SystemClock();

const ALL_PARTIES = [
  Permission.CUSTOMER_VIEW,
  Permission.CUSTOMER_CREATE,
  Permission.CUSTOMER_EDIT,
  Permission.CUSTOMER_DEACTIVATE,
  Permission.SUPPLIER_VIEW,
  Permission.SUPPLIER_CREATE,
  Permission.SUPPLIER_EDIT,
  Permission.SUPPLIER_DEACTIVATE,
  Permission.VENDOR_VIEW,
  Permission.VENDOR_CREATE,
  Permission.VENDOR_EDIT,
  Permission.VENDOR_DEACTIVATE,
  Permission.PARTY_GROUP_MANAGE,
  Permission.SETTING_VIEW,
  Permission.SETTING_EDIT,
  Permission.SETTING_TOGGLE,
];

let app: INestApplication;
let pool: pg.Pool;
let tenant: SeededTenant;
let token: string;

interface PartyBody {
  readonly id: string;
  readonly name: string;
  readonly roles: readonly string[];
  readonly phone: string | null;
  readonly nid: string | null;
  readonly customerGroupId: string | null;
  readonly customerGroupName: string | null;
  readonly creditLimitMinor: number | null;
  readonly status: string;
  readonly isSystemReserved: boolean;
  readonly version: number;
}

/** §5.6's mandatory set for a customer, and nothing else. */
function minimalCustomer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Karim Uddin',
    roles: ['CUSTOMER'],
    phone: '01712345678',
    address: null,
    guardianName: null,
    nid: null,
    email: null,
    notes: null,
    customerGroupId: null,
    creditLimitMinor: null,
    ...overrides,
  };
}

function createParty(
  body: Record<string, unknown>,
  operationId = Ulid.generate(clock),
  as = token,
): request.Test {
  return request(app.getHttpServer())
    .post('/api/v1/parties')
    .set('Authorization', `Bearer ${as}`)
    .set('Idempotency-Key', operationId)
    .send(body);
}

function listParties(query: string, as = token): request.Test {
  return request(app.getHttpServer())
    .get(`/api/v1/parties${query}`)
    .set('Authorization', `Bearer ${as}`);
}

async function setSetting(key: string, value: string): Promise<void> {
  const response = await request(app.getHttpServer())
    .post('/api/v1/settings/value')
    .set('Authorization', `Bearer ${token}`)
    .send({ key, value });
  expect(response.status).toBe(201);
}

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

beforeEach(async () => {
  await resetDatabase(pool);
  tenant = await seedTenant(pool, { name: 'Karim Traders', permissions: ALL_PARTIES });
  token = signToken(tenant, TEST_JWT_SECRET);
});

describe('creating a party', () => {
  it('accepts a customer with only a name and a phone number', async () => {
    const created = await createParty(minimalCustomer());

    expect(created.status).toBe(201);
    const party = created.body.data as PartyBody;
    expect(party.name).toBe('Karim Uddin');
    expect(party.roles).toEqual(['CUSTOMER']);
    expect(party.phone).toBe('01712345678');
    expect(party.creditLimitMinor).toBeNull();
    expect(party.status).toBe('ACTIVE');
    expect(party.isSystemReserved).toBe(false);
    expect(party.version).toBe(1);
  });

  it('refuses a customer with no phone number (D-02)', async () => {
    const created = await createParty(minimalCustomer({ phone: null }));

    expect(created.status).toBe(400);
    expect(created.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('accepts a supplier with no phone number', async () => {
    const created = await createParty(
      minimalCustomer({ name: 'Dhaka Wholesale', roles: ['SUPPLIER'], phone: null }),
    );

    expect(created.status).toBe(201);
    expect((created.body.data as PartyBody).roles).toEqual(['SUPPLIER']);
  });

  it('stores a credit limit as exact integer poisha', async () => {
    // ৳5,000.00 is 500000 poisha. Not 5000, and never a float.
    const created = await createParty(minimalCustomer({ creditLimitMinor: 500_000 }));

    expect((created.body.data as PartyBody).creditLimitMinor).toBe(500_000);
  });

  it('creates one record when the same Idempotency-Key is sent twice', async () => {
    const operationId = Ulid.generate(clock);

    const first = await createParty(minimalCustomer(), operationId);
    const second = await createParty(minimalCustomer(), operationId);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect((second.body.data as PartyBody).id).toBe((first.body.data as PartyBody).id);

    const list = await listParties('?role=CUSTOMER');
    // One created customer, plus nothing else: `seedTenant` inserts rows
    // directly and so does not run tenant provisioning's walk-in party.
    expect(list.body.summary.total).toBe(1);
  });

  it('refuses the same key with a different record', async () => {
    const operationId = Ulid.generate(clock);
    await createParty(minimalCustomer(), operationId);

    const different = await createParty(
      minimalCustomer({ name: 'Someone Else', phone: '01999999999' }),
      operationId,
    );

    expect(different.status).toBe(409);
    expect(different.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});

describe('D-02 — the customer phone rule', () => {
  it('refuses a second customer with the same number', async () => {
    await createParty(minimalCustomer());

    const duplicate = await createParty(minimalCustomer({ name: 'Someone Else' }));

    expect(duplicate.status).toBe(400);
    expect(duplicate.body.error.message).toContain('01712345678');
  });

  it('treats a number spaced differently as the same number', async () => {
    await createParty(minimalCustomer());

    const duplicate = await createParty(
      minimalCustomer({ name: 'Someone Else', phone: '01712 345 678' }),
    );

    expect(duplicate.status).toBe(400);
  });

  it('lets a supplier hold a number a customer already has', async () => {
    await createParty(minimalCustomer());

    const supplier = await createParty(
      minimalCustomer({ name: 'Karim Supplies', roles: ['SUPPLIER'] }),
    );

    expect(supplier.status).toBe(201);
    expect((supplier.body.data as PartyBody).phone).toBe('01712345678');
  });

  it('lets a customer keep their own number when edited', async () => {
    const created = await createParty(minimalCustomer());
    const party = created.body.data as PartyBody;

    const edited = await request(app.getHttpServer())
      .patch(`/api/v1/parties/${party.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ ...minimalCustomer({ name: 'Karim Uddin Sr' }), version: party.version });

    expect(edited.status).toBe(200);
    expect((edited.body.data as PartyBody).name).toBe('Karim Uddin Sr');
  });
});

describe('D-04 — one identity, several roles', () => {
  it('shows a party under every tab whose role it holds', async () => {
    const created = await createParty(
      minimalCustomer({ name: 'Rahim Stores', roles: ['CUSTOMER', 'SUPPLIER'] }),
    );
    expect((created.body.data as PartyBody).roles).toEqual(['CUSTOMER', 'SUPPLIER']);

    const asCustomer = await listParties('?role=CUSTOMER');
    const asSupplier = await listParties('?role=SUPPLIER');

    expect(asCustomer.body.summary.total).toBe(1);
    expect(asSupplier.body.summary.total).toBe(1);
    expect((asSupplier.body.data[0] as PartyBody).id).toBe((created.body.data as PartyBody).id);
  });

  it('drops a role without touching the record, and can give it back', async () => {
    const created = await createParty(
      minimalCustomer({ name: 'Rahim Stores', roles: ['CUSTOMER', 'SUPPLIER'] }),
    );
    const party = created.body.data as PartyBody;

    const narrowed = await request(app.getHttpServer())
      .patch(`/api/v1/parties/${party.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        ...minimalCustomer({ name: 'Rahim Stores', roles: ['CUSTOMER'] }),
        version: party.version,
      });
    expect((narrowed.body.data as PartyBody).roles).toEqual(['CUSTOMER']);
    expect((await listParties('?role=SUPPLIER')).body.summary.total).toBe(0);

    const restored = await request(app.getHttpServer())
      .patch(`/api/v1/parties/${party.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        ...minimalCustomer({ name: 'Rahim Stores', roles: ['CUSTOMER', 'SUPPLIER'] }),
        version: (narrowed.body.data as PartyBody).version,
      });
    expect((restored.body.data as PartyBody).roles).toEqual(['CUSTOMER', 'SUPPLIER']);
  });

  it('never shows every party type at once', async () => {
    // §5.6: the role is required, so there is no request that means "all".
    const everything = await listParties('');
    expect(everything.status).toBe(400);
  });
});

describe('editing', () => {
  it('refuses the second of two simultaneous saves (D-32)', async () => {
    const created = await createParty(minimalCustomer());
    const party = created.body.data as PartyBody;

    const first = await request(app.getHttpServer())
      .patch(`/api/v1/parties/${party.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ ...minimalCustomer({ name: 'First Edit' }), version: party.version });
    expect(first.status).toBe(200);

    const stale = await request(app.getHttpServer())
      .patch(`/api/v1/parties/${party.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ ...minimalCustomer({ name: 'Second Edit' }), version: party.version });

    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('CONFLICT_STALE_VERSION');
    // The winner's edit stands: the loser was told, not silently dropped.
    const reread = await request(app.getHttpServer())
      .get(`/api/v1/parties/${party.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect((reread.body.data as PartyBody).name).toBe('First Edit');
  });

  it('deactivates and reactivates without touching anything else', async () => {
    const created = await createParty(minimalCustomer());
    const party = created.body.data as PartyBody;

    const off = await request(app.getHttpServer())
      .post(`/api/v1/parties/${party.id}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'INACTIVE' });
    expect((off.body.data as PartyBody).status).toBe('INACTIVE');
    expect((off.body.data as PartyBody).phone).toBe('01712345678');

    const on = await request(app.getHttpServer())
      .post(`/api/v1/parties/${party.id}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'ACTIVE' });
    expect((on.body.data as PartyBody).status).toBe('ACTIVE');
  });
});

describe('customer groups and the fields a shop asks for (§5.21)', () => {
  it('refuses a group while customer groups are switched off', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/party-setup/groups')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Dealer' });

    expect(created.status).toBe(403);
    expect(created.body.error.code).toBe('FEATURE_DISABLED');
  });

  it('files a customer into a group once groups are on', async () => {
    await setSetting(SettingKey.CUSTOMER_GROUPS_ENABLED, 'on');

    const group = await request(app.getHttpServer())
      .post('/api/v1/party-setup/groups')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Dealer' });
    expect(group.status).toBe(201);
    const groupId = group.body.data.groups[0].id as string;

    const created = await createParty(minimalCustomer({ customerGroupId: groupId }));
    expect((created.body.data as PartyBody).customerGroupName).toBe('Dealer');

    const filtered = await listParties(`?role=CUSTOMER&groupId=${groupId}`);
    expect(filtered.body.summary.total).toBe(1);
  });

  it('refuses an NID while the shop does not ask for one', async () => {
    // Default OFF (§5.21). The refusal is FEATURE_DISABLED, not a 400: the
    // caller may well hold the permission — the shop switched the field off.
    const created = await createParty(minimalCustomer({ nid: '1234567890' }));

    expect(created.status).toBe(403);
    expect(created.body.error.code).toBe('FEATURE_DISABLED');
  });

  it('keeps a stored NID when the shop stops asking for one', async () => {
    await setSetting(SettingKey.CUSTOMER_FIELD_NID_VISIBLE, 'on');
    const created = await createParty(minimalCustomer({ nid: '1234567890' }));
    const party = created.body.data as PartyBody;
    expect(party.nid).toBe('1234567890');

    await setSetting(SettingKey.CUSTOMER_FIELD_NID_VISIBLE, 'off');

    // The form no longer shows the field, so it sends nothing for it. §5.6
    // preserves stored historical data — the edit must not wipe it.
    const edited = await request(app.getHttpServer())
      .patch(`/api/v1/parties/${party.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ ...minimalCustomer({ name: 'Karim Uddin Sr' }), version: party.version });

    expect(edited.status).toBe(200);
    expect((edited.body.data as PartyBody).nid).toBe('1234567890');
  });

  it('hides vendors until the shop switches them on', async () => {
    const off = await createParty(minimalCustomer({ name: 'Vendor A', roles: ['VENDOR'] }));
    expect(off.status).toBe(403);
    expect(off.body.error.code).toBe('FEATURE_DISABLED');

    await setSetting(SettingKey.VENDOR_MANAGEMENT_ENABLED, 'on');

    const on = await createParty(minimalCustomer({ name: 'Vendor A', roles: ['VENDOR'] }));
    expect(on.status).toBe(201);
  });
});

describe('the walk-in customer (D-02)', () => {
  /** Created the way `provisionTenant` creates it, since `seedTenant` does not. */
  async function seedWalkIn(): Promise<string> {
    const created = await createParty(minimalCustomer({ name: 'Temp', phone: '01700000000' }));
    const id = (created.body.data as PartyBody).id;
    await asTenant(pool, tenant.tenantId, (client) =>
      client.query(
        'UPDATE parties SET is_system_reserved = TRUE, phone = NULL, customer_phone_key = NULL WHERE id = $1',
        [id],
      ),
    );
    return id;
  }

  it('cannot be renamed, deactivated or deleted', async () => {
    const id = await seedWalkIn();

    const renamed = await request(app.getHttpServer())
      .patch(`/api/v1/parties/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ ...minimalCustomer({ name: 'Something Else' }), version: 1 });
    expect(renamed.status).toBe(400);

    const deactivated = await request(app.getHttpServer())
      .post(`/api/v1/parties/${id}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'INACTIVE' });
    expect(deactivated.status).toBe(400);

    const deleted = await request(app.getHttpServer())
      .delete(`/api/v1/parties/${id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(deleted.status).toBe(400);
  });
});

describe('permissions (§5.26)', () => {
  it('lets a cashier add a customer but not a supplier', async () => {
    // The seeded Cashier role: §5.6 makes creating a customer mandatory the
    // moment a sale leaves a due, so a cashier who cannot do it cannot finish
    // that sale. A supplier is a different trust entirely.
    const cashierTenant = await seedTenant(pool, {
      name: 'Till Only',
      permissions: [Permission.CUSTOMER_VIEW, Permission.CUSTOMER_CREATE],
    });
    const cashier = signToken(cashierTenant, TEST_JWT_SECRET);

    const customer = await createParty(minimalCustomer(), Ulid.generate(clock), cashier);
    expect(customer.status).toBe(201);

    const supplier = await createParty(
      minimalCustomer({ name: 'Dhaka Wholesale', roles: ['SUPPLIER'], phone: null }),
      Ulid.generate(clock),
      cashier,
    );
    expect(supplier.status).toBe(403);
    expect(supplier.body.error.code).toBe('PERMISSION_DENIED');

    const suppliers = await listParties('?role=SUPPLIER', cashier);
    expect(suppliers.status).toBe(403);
  });
});

describe('tenant isolation (§3.2)', () => {
  it('does not find another business\'s customer', async () => {
    const created = await createParty(minimalCustomer());
    const party = created.body.data as PartyBody;

    const other = await seedTenant(pool, { name: 'Other Shop', permissions: ALL_PARTIES });
    const otherToken = signToken(other, TEST_JWT_SECRET);

    const read = await request(app.getHttpServer())
      .get(`/api/v1/parties/${party.id}`)
      .set('Authorization', `Bearer ${otherToken}`);

    // 404, never 403: confirming a record exists in another tenant is itself a
    // leak (§5.26, R-E5).
    expect(read.status).toBe(404);

    const list = await listParties('?role=CUSTOMER', otherToken);
    expect(list.body.summary.total).toBe(0);
  });

  it('lets both businesses keep a customer with the same phone number', async () => {
    await createParty(minimalCustomer());

    const other = await seedTenant(pool, { name: 'Other Shop', permissions: ALL_PARTIES });
    const otherToken = signToken(other, TEST_JWT_SECRET);

    const created = await createParty(minimalCustomer(), Ulid.generate(clock), otherToken);
    expect(created.status).toBe(201);
  });
});

describe('the audit trail (§5.22)', () => {
  it('records what changed, with both sides', async () => {
    const created = await createParty(minimalCustomer({ creditLimitMinor: 500_000 }));
    const party = created.body.data as PartyBody;

    await request(app.getHttpServer())
      .patch(`/api/v1/parties/${party.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        ...minimalCustomer({ creditLimitMinor: 1_000_000 }),
        version: party.version,
      });

    const events = await asTenant(pool, tenant.tenantId, (client) =>
      client.query<{ action: string; before: unknown; after: unknown }>(
        `SELECT action, before_json AS before, after_json AS after
           FROM audit_events
          WHERE entity_type = 'party' AND entity_id = $1
          ORDER BY id`,
        [party.id],
      ),
    );

    expect(events.rows.map((row) => row.action)).toEqual(['CREATE', 'UPDATE']);
    // R-D4: money on both sides, as the stored integers. An audit row that
    // rounds is not evidence.
    expect((events.rows[1]?.before as { creditLimitMinor: number }).creditLimitMinor).toBe(500_000);
    expect((events.rows[1]?.after as { creditLimitMinor: number }).creditLimitMinor).toBe(1_000_000);
  });
});
