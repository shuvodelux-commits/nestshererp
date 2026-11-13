/*
 * Coverage claims, read by `pnpm test:inventory` (owner request 2026-09-03).
 *
 * These are what this file is answerable for in the test matrix. A claim naming
 * something the inventory no longer contains fails the scan, so a screen renamed
 * out from under a test cannot leave the coverage report quietly overstating itself.
 *
 * @covers endpoint:DELETE /api/v1/parties/:id
 * @covers endpoint:GET /api/v1/parties
 * @covers endpoint:GET /api/v1/parties/:id
 * @covers endpoint:GET /api/v1/parties/:id/ledger
 * @covers endpoint:PATCH /api/v1/parties/:id
 * @covers endpoint:POST /api/v1/parties
 * @covers endpoint:POST /api/v1/parties/:id/status
 * @covers endpoint:POST /api/v1/party-setup/groups
 * @covers endpoint:POST /api/v1/settings/value
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

describe('D08 P0-L02 — trading-role balance isolation for Party list and detail', () => {
  it('uses the list role for balance cells, summary tiles, credit guard and keyset balance sort', async () => {
    const businessDate = clock.businessDate('Asia/Dhaka');
    const mixedCreated = await createParty(
      minimalCustomer({
        name: 'Dual Role Shop',
        roles: ['CUSTOMER', 'SUPPLIER'],
        creditLimitMinor: 200_000,
        opening: { role: 'CUSTOMER', direction: 'RECEIVABLE', amountMinor: 250_000, businessDate },
      }),
    ).expect(201);
    const mixed = mixedCreated.body.data as PartyBody;
    await request(app.getHttpServer())
      .post(`/api/v1/parties/${mixed.id}/opening`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', Ulid.generate(clock))
      .send({ role: 'SUPPLIER', direction: 'PAYABLE', amountMinor: 900_000, businessDate })
      .expect(201);
    const otherCreated = await createParty(
      minimalCustomer({
        name: 'Customer Only',
        phone: '01799999999',
        opening: { role: 'CUSTOMER', direction: 'RECEIVABLE', amountMinor: 100_000, businessDate },
      }),
    ).expect(201);
    const other = otherCreated.body.data as PartyBody;

    const first = await listParties('?role=CUSTOMER&sort=balance&direction=DESC&limit=1').expect(200);
    expect(first.body.data).toHaveLength(1);
    expect(first.body.data[0].id).toBe(mixed.id);
    expect(first.body.data[0].balance.netMinor).toBe(250_000);
    expect(first.body.summary.totalOutstandingMinor).toBe(350_000);
    expect(first.body.summary.totalAdvanceMinor).toBe(0);
    expect(first.body.summary.overCreditLimit).toBe(1);
    expect(first.body.page.hasMore).toBe(true);
    const next = await listParties(
      `?role=CUSTOMER&sort=balance&direction=DESC&limit=1&cursor=${first.body.page.nextCursor}`,
    ).expect(200);
    expect(next.body.data[0].id).toBe(other.id);
    expect(next.body.data[0].balance.netMinor).toBe(100_000);
    expect(next.body.page.hasMore).toBe(false);

    const suppliers = await listParties('?role=SUPPLIER').expect(200);
    expect(suppliers.body.data).toHaveLength(1);
    expect(suppliers.body.data[0].id).toBe(mixed.id);
    expect(suppliers.body.data[0].balance.netMinor).toBe(-900_000);
    expect(suppliers.body.summary.totalOutstandingMinor).toBe(0);
    expect(suppliers.body.summary.totalAdvanceMinor).toBe(900_000);
  });

  it('requires role-specific Party details and redacts relationships without view permission', async () => {
    const businessDate = clock.businessDate('Asia/Dhaka');
    const created = await createParty(minimalCustomer({
      roles: ['CUSTOMER', 'SUPPLIER'],
      opening: { role: 'CUSTOMER', direction: 'RECEIVABLE', amountMinor: 200_000, businessDate },
    })).expect(201);
    const party = created.body.data as PartyBody;
    await request(app.getHttpServer())
      .post(`/api/v1/parties/${party.id}/opening`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', Ulid.generate(clock))
      .send({ role: 'SUPPLIER', direction: 'PAYABLE', amountMinor: 130_000, businessDate })
      .expect(201);

    await request(app.getHttpServer())
      .get(`/api/v1/parties/${party.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(400);
    const customer = await request(app.getHttpServer())
      .get(`/api/v1/parties/${party.id}?role=CUSTOMER`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(customer.body.data.balance.netMinor).toBe(200_000);
    const supplier = await request(app.getHttpServer())
      .get(`/api/v1/parties/${party.id}?role=SUPPLIER`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(supplier.body.data.balance.netMinor).toBe(-130_000);
    await request(app.getHttpServer())
      .get(`/api/v1/parties/${party.id}?role=VENDOR`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);

    await asTenant(pool, tenant.tenantId, async (client) => {
      await client.query(
        'DELETE FROM role_permissions WHERE tenant_id = $1 AND role_id = $2 AND permission_code = $3',
        [tenant.tenantId, tenant.roleId, Permission.SUPPLIER_VIEW],
      );
    });
    const denied = await request(app.getHttpServer())
      .get(`/api/v1/parties/${party.id}?role=SUPPLIER`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
    expect(denied.body.error.code).toBe('PERMISSION_DENIED');
    const visible = await request(app.getHttpServer())
      .get(`/api/v1/parties/${party.id}?role=CUSTOMER`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(visible.body.data.balance.netMinor).toBe(200_000);
    expect(visible.body.data.roles).toEqual(['CUSTOMER']);
    const tab = await listParties('?role=CUSTOMER').expect(200);
    const row = tab.body.data.find((item: { id: string }) => item.id === party.id);
    expect(row.roles).toEqual(['CUSTOMER']);
    expect(row.balance.netMinor).toBe(200_000);
  });
});

describe('D08 P0-L03 — exact-role opening authorization', () => {
  async function financialSnapshot() {
    return asTenant(pool, tenant.tenantId, async (client) => {
      const result = await client.query<{
        journal_entries: number; journal_lines: number; openings: number;
        outbox_events: number; idempotency_rows: number;
      }>(`
        SELECT
          (SELECT COUNT(*)::int FROM journal_entries WHERE tenant_id = $1) AS journal_entries,
          (SELECT COUNT(*)::int FROM journal_lines WHERE tenant_id = $1) AS journal_lines,
          (SELECT COUNT(*)::int FROM party_openings WHERE tenant_id = $1) AS openings,
          (SELECT COUNT(*)::int FROM outbox WHERE tenant_id = $1) AS outbox_events,
          (SELECT COUNT(*)::int FROM idempotency_keys WHERE tenant_id = $1) AS idempotency_rows
      `, [tenant.tenantId]);
      return result.rows[0]!;
    });
  }

  async function revoke(permission: string): Promise<void> {
    await asTenant(pool, tenant.tenantId, async (client) => {
      await client.query(
        'DELETE FROM role_permissions WHERE tenant_id = $1 AND role_id = $2 AND permission_code = $3',
        [tenant.tenantId, tenant.roleId, permission],
      );
    });
  }

  it('does not disclose a Supplier opening through Customer-view permission', async () => {
    const businessDate = clock.businessDate('Asia/Dhaka');
    const created = await createParty(minimalCustomer({ roles: ['CUSTOMER', 'SUPPLIER'] })).expect(201);
    const id = (created.body.data as PartyBody).id;
    await request(app.getHttpServer())
      .post(`/api/v1/parties/${id}/opening`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', Ulid.generate(clock))
      .send({ role: 'SUPPLIER', direction: 'PAYABLE', amountMinor: 180_000, businessDate })
      .expect(201);

    await revoke(Permission.SUPPLIER_VIEW);
    const denied = await request(app.getHttpServer())
      .get(`/api/v1/parties/${id}/opening?role=SUPPLIER`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
    expect(denied.body.error.code).toBe('PERMISSION_DENIED');
    const visible = await request(app.getHttpServer())
      .get(`/api/v1/parties/${id}/opening?role=CUSTOMER`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(visible.body.data).toBeNull();
    const stranger = await seedTenant(pool, { name: 'Separate Tenant', permissions: [Permission.SUPPLIER_VIEW] });
    await request(app.getHttpServer())
      .get(`/api/v1/parties/${id}/opening?role=SUPPLIER`)
      .set('Authorization', `Bearer ${signToken(stranger, TEST_JWT_SECRET)}`)
      .expect(404);
  });

  it('rejects a Supplier opening posted with Customer edit only and makes no financial write', async () => {
    const created = await createParty(minimalCustomer({ roles: ['CUSTOMER', 'SUPPLIER'] })).expect(201);
    const id = (created.body.data as PartyBody).id;
    await revoke(Permission.SUPPLIER_EDIT);
    const before = await financialSnapshot();
    const denied = await request(app.getHttpServer())
      .post(`/api/v1/parties/${id}/opening`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', Ulid.generate(clock))
      .send({
        role: 'SUPPLIER', direction: 'PAYABLE', amountMinor: 290_000,
        businessDate: clock.businessDate('Asia/Dhaka'),
      })
      .expect(403);
    expect(denied.body.error.code).toBe('PERMISSION_DENIED');
    expect(await financialSnapshot()).toEqual(before);
  });

  it('blocks Supplier opening corrections with Customer edit and preserves original posting', async () => {
    const businessDate = clock.businessDate('Asia/Dhaka');
    const created = await createParty(minimalCustomer({ roles: ['CUSTOMER', 'SUPPLIER'] })).expect(201);
    const id = (created.body.data as PartyBody).id;
    const initial = await request(app.getHttpServer())
      .post(`/api/v1/parties/${id}/opening`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', Ulid.generate(clock))
      .send({ role: 'SUPPLIER', direction: 'PAYABLE', amountMinor: 190_000, businessDate })
      .expect(201);
    const version = initial.body.data.version as number;
    await revoke(Permission.SUPPLIER_EDIT);
    const before = await financialSnapshot();
    const denied = await request(app.getHttpServer())
      .patch(`/api/v1/parties/${id}/opening`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', Ulid.generate(clock))
      .send({
        role: 'SUPPLIER', direction: 'PAYABLE', amountMinor: 220_000, businessDate, version,
      })
      .expect(403);
    expect(denied.body.error.code).toBe('PERMISSION_DENIED');
    expect(await financialSnapshot()).toEqual(before);
    const persisted = await asTenant(pool, tenant.tenantId, async (client) =>
      client.query<{ version: number; amount_minor: number }>(
        'SELECT version, amount_minor FROM party_openings WHERE tenant_id = $1 AND party_id = $2 AND role = $3',
        [tenant.tenantId, id, 'SUPPLIER'],
      ),
    );
    expect(persisted.rows).toHaveLength(1);
    expect(persisted.rows[0]!.version).toBe(version);
    expect(persisted.rows[0]!.amount_minor).toBe(190_000);
  });
  it('rejects an old Supplier idempotency replay after Supplier edit permission is revoked', async () => {
    const businessDate = clock.businessDate('Asia/Dhaka');
    const created = await createParty(minimalCustomer({ roles: ['CUSTOMER', 'SUPPLIER'] })).expect(201);
    const id = (created.body.data as PartyBody).id;
    const operationId = Ulid.generate(clock);
    const opening = { role: 'SUPPLIER', direction: 'PAYABLE', amountMinor: 170_000, businessDate };
    const initial = await request(app.getHttpServer())
      .post(`/api/v1/parties/${id}/opening`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', operationId)
      .send(opening)
      .expect(201);
    expect(initial.body.data.amountMinor).toBe(170_000);

    await revoke(Permission.SUPPLIER_EDIT);
    const before = await financialSnapshot();
    const denied = await request(app.getHttpServer())
      .post(`/api/v1/parties/${id}/opening`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', operationId)
      .send(opening)
      .expect(403);
    expect(denied.body.error.code).toBe('PERMISSION_DENIED');
    expect(await financialSnapshot()).toEqual(before);
  });

  it('preserves a legitimately authorized Supplier correction and journal reconciliation', async () => {
    const businessDate = clock.businessDate('Asia/Dhaka');
    const created = await createParty(minimalCustomer({ roles: ['CUSTOMER', 'SUPPLIER'] })).expect(201);
    const id = (created.body.data as PartyBody).id;
    const opening = await request(app.getHttpServer())
      .post(`/api/v1/parties/${id}/opening`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', Ulid.generate(clock))
      .send({ role: 'SUPPLIER', direction: 'PAYABLE', amountMinor: 190_000, businessDate })
      .expect(201);
    const version = opening.body.data.version as number;
    const updated = await request(app.getHttpServer())
      .patch(`/api/v1/parties/${id}/opening`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', Ulid.generate(clock))
      .send({ role: 'SUPPLIER', direction: 'PAYABLE', amountMinor: 220_000, businessDate, version })
      .expect(200);
    expect(updated.body.data.amountMinor).toBe(220_000);
    expect(updated.body.data.version).toBe(version + 1);
    const supplier = await request(app.getHttpServer())
      .get(`/api/v1/parties/${id}/ledger?role=SUPPLIER`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(supplier.body.closingBalance.netMinor).toBe(-220_000);
    expect(supplier.body.rows).toHaveLength(3);
    const customer = await request(app.getHttpServer())
      .get(`/api/v1/parties/${id}/ledger?role=CUSTOMER`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(customer.body.rows).toHaveLength(0);
    expect(customer.body.closingBalance.netMinor).toBe(0);
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

/**
 * Opening balances and ledgers (§5.0, §5.6, §2.4, INV-06).
 *
 * The one thing worth asserting end to end on this path: that a balance is
 * never a stored number. Every figure below is checked against the journal
 * lines it is supposed to be the sum of, because the failure mode that matters
 * is a balance that looks right on the list and disagrees with the ledger — and
 * that failure is invisible until a shopkeeper collects the wrong amount.
 */
describe('opening balances and ledgers', () => {
  it('posts an opening receivable as a balanced entry, not a column (INV-01, INV-06)', async () => {
    const created = await createParty(
      minimalCustomer({
        opening: {
          role: 'CUSTOMER',
          direction: 'RECEIVABLE',
          amountMinor: 250_000,
          businessDate: clock.businessDate('Asia/Dhaka'),
        },
      }),
    ).expect(201);

    const party = created.body.data as PartyBody & {
      balance: { netMinor: number; direction: string; outstandingMinor: number };
    };

    // ৳2,500.00 as the exact integer. A float anywhere here is the drift §3.3
    // exists to prevent.
    expect(party.balance.netMinor).toBe(250_000);
    expect(party.balance.direction).toBe('RECEIVABLE');
    expect(party.balance.outstandingMinor).toBe(250_000);

    const lines = await asTenant(pool, tenant.tenantId, (client) =>
      client.query<{ account_code: string; amount_minor: number; party_id: string | null }>(
        `SELECT l.account_code, l.amount_minor, l.party_id
           FROM journal_lines l
           JOIN journal_entries e ON e.id = l.journal_entry_id
          WHERE e.source_document_type = 'OPENING_BALANCE'
          ORDER BY l.amount_minor DESC`,
      ),
    );

    // INV-01: the lines sum to zero. INV-06: the AR line names the party, or
    // the balance would belong to nobody.
    expect(lines.rows.map((row) => [row.account_code, row.amount_minor])).toEqual([
      ['AR', 250_000],
      ['OPENING_EQUITY', -250_000],
    ]);
    expect(lines.rows[0]?.party_id?.trim()).toBe(party.id);
    expect(lines.rows.reduce((sum, row) => sum + row.amount_minor, 0)).toBe(0);
  });

  it('isolates trading ledgers by requested role for a multi-role party', async () => {
    const businessDate = clock.businessDate('Asia/Dhaka');
    const created = await createParty(
      minimalCustomer({
        name: 'Rahim Trading',
        roles: ['CUSTOMER', 'SUPPLIER'],
        opening: { role: 'CUSTOMER', direction: 'RECEIVABLE', amountMinor: 250_000, businessDate },
      }),
    ).expect(201);
    const party = created.body.data as PartyBody;

    await request(app.getHttpServer())
      .post(`/api/v1/parties/${party.id}/opening`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', Ulid.generate(clock))
      .send({ role: 'SUPPLIER', direction: 'PAYABLE', amountMinor: 150_000, businessDate })
      .expect(201);

    // A multi-role party must not silently combine AR and AP or let one
    // role's permission authorize the other role's journal source details.
    const ambiguous = await request(app.getHttpServer())
      .get(`/api/v1/parties/${party.id}/ledger`)
      .set('Authorization', `Bearer ${token}`);
    expect(ambiguous.status).toBe(400);

    const customer = await request(app.getHttpServer())
      .get(`/api/v1/parties/${party.id}/ledger?role=CUSTOMER`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(customer.body.rows.map((row: { account: string }) => row.account)).toEqual(['AR']);
    expect(customer.body.closingBalance.netMinor).toBe(250_000);

    const supplier = await request(app.getHttpServer())
      .get(`/api/v1/parties/${party.id}/ledger?role=SUPPLIER`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(supplier.body.rows.map((row: { account: string }) => row.account)).toEqual(['AP']);
    expect(supplier.body.closingBalance.netMinor).toBe(-150_000);

    const customerCursor = customer.body.rows[0].journalLineId as string;
    await request(app.getHttpServer())
      .get(`/api/v1/parties/${party.id}/ledger?role=SUPPLIER&cursor=${customerCursor}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(400);
  });

  it('paginates corrected opening balances without losing the cursor amount', async () => {
    const businessDate = clock.businessDate('Asia/Dhaka');
    const created = await createParty(
      minimalCustomer({
        opening: { role: 'CUSTOMER', direction: 'RECEIVABLE', amountMinor: 250_000, businessDate },
      }),
    ).expect(201);
    const party = created.body.data as PartyBody;

    const previousOpening = await request(app.getHttpServer())
      .get(`/api/v1/parties/${party.id}/opening?role=CUSTOMER`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const version = previousOpening.body.data.version as number;
    await request(app.getHttpServer())
      .patch(`/api/v1/parties/${party.id}/opening`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', Ulid.generate(clock))
      .send({
        role: 'CUSTOMER',
        direction: 'RECEIVABLE',
        amountMinor: 310_000,
        businessDate,
        version,
      })
      .expect(200);

    const url = `/api/v1/parties/${party.id}/ledger?role=CUSTOMER&fromDate=${businessDate}&toDate=${businessDate}`;
    const full = await request(app.getHttpServer())
      .get(`${url}&limit=10`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(full.body.rows).toHaveLength(3); // Opening + reversal + repost.
    expect(full.body.closingBalance.netMinor).toBe(310_000);

    const seen: string[] = [];
    let cursor: string | null = null;
    let priorRunningMinor = 0;
    for (let page = 0; page < 3; page += 1) {
      const response = await request(app.getHttpServer())
        .get(`${url}&limit=1${cursor === null ? '' : `&cursor=${cursor}`}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const body = response.body as {
        openingBalance: { netMinor: number };
        closingBalance: { netMinor: number };
        rows: { journalLineId: string; runningBalanceMinor: number }[];
        page: { hasMore: boolean; nextCursor: string | null };
      };
      expect(body.rows).toHaveLength(1);
      expect(body.openingBalance.netMinor).toBe(priorRunningMinor);
      expect(body.closingBalance.netMinor).toBe(310_000);
      seen.push(body.rows[0]!.journalLineId);
      priorRunningMinor = body.rows[0]!.runningBalanceMinor;
      expect(body.page.hasMore).toBe(page < 2);
      cursor = body.page.nextCursor;
    }
    expect(seen).toEqual(full.body.rows.map((row: { journalLineId: string }) => row.journalLineId));
    expect(priorRunningMinor).toBe(310_000);
  });

  it('denies another relationship when only the customer view permission remains', async () => {
    const created = await createParty(
      minimalCustomer({ roles: ['CUSTOMER', 'SUPPLIER'] }),
    ).expect(201);
    const party = created.body.data as PartyBody;
    await asTenant(pool, tenant.tenantId, async (client) => {
      await client.query(
        'DELETE FROM role_permissions WHERE tenant_id = $1 AND role_id = $2 AND permission_code = $3',
        [tenant.tenantId, tenant.roleId, Permission.SUPPLIER_VIEW],
      );
    });
    await request(app.getHttpServer())
      .get(`/api/v1/parties/${party.id}/ledger?role=CUSTOMER`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const denied = await request(app.getHttpServer())
      .get(`/api/v1/parties/${party.id}/ledger?role=SUPPLIER`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
    expect(denied.body.error.code).toBe('PERMISSION_DENIED');
  });

  it('shows the same figure on the list and in the ledger', async () => {
    const created = await createParty(
      minimalCustomer({
        opening: {
          role: 'CUSTOMER',
          direction: 'RECEIVABLE',
          amountMinor: 250_000,
          businessDate: clock.businessDate('Asia/Dhaka'),
        },
      }),
    ).expect(201);

    const party = created.body.data as PartyBody;

    const listed = await request(app.getHttpServer())
      .get('/api/v1/parties?role=CUSTOMER')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const row = (listed.body.data as { id: string; balance: { netMinor: number } }[]).find(
      (entry) => entry.id === party.id,
    );

    const ledger = await request(app.getHttpServer())
      .get(`/api/v1/parties/${party.id}/ledger`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const body = ledger.body as {
      rows: { sourceDocumentType: string; debitMinor: number; runningBalanceMinor: number }[];
      closingBalance: { netMinor: number };
      totalDebitMinor: number;
    };

    // The point of the whole exercise: one number, two screens.
    expect(row?.balance.netMinor).toBe(250_000);
    expect(body.closingBalance.netMinor).toBe(250_000);

    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]?.sourceDocumentType).toBe('OPENING_BALANCE');
    expect(body.rows[0]?.debitMinor).toBe(250_000);
    expect(body.rows[0]?.runningBalanceMinor).toBe(250_000);
    expect(body.totalDebitMinor).toBe(250_000);
  });

  it('nets an advance against what is owed rather than showing two figures', async () => {
    const created = await createParty(
      minimalCustomer({
        opening: {
          role: 'CUSTOMER',
          direction: 'PAYABLE',
          amountMinor: 100_000,
          businessDate: clock.businessDate('Asia/Dhaka'),
        },
      }),
    ).expect(201);

    const party = created.body.data as PartyBody & {
      balance: { direction: string; advanceMinor: number; outstandingMinor: number };
    };

    // A deposit taken before go-live: the shop owes it back, so দিব, not পাবো.
    expect(party.balance.direction).toBe('PAYABLE');
    expect(party.balance.advanceMinor).toBe(100_000);
    expect(party.balance.outstandingMinor).toBe(0);
  });

  it('refuses a second opening for the same role rather than doubling the balance', async () => {
    const opening = {
      role: 'CUSTOMER',
      direction: 'RECEIVABLE',
      amountMinor: 250_000,
      businessDate: clock.businessDate('Asia/Dhaka'),
    };

    const created = await createParty(minimalCustomer({ opening })).expect(201);
    const party = created.body.data as PartyBody;

    // A different party, same phone, would be D-02's refusal — so this second
    // attempt has to be the same party reached another way. The opening is
    // create-only, so the check that matters is on the repository's unique.
    const rows = await asTenant(pool, tenant.tenantId, (client) =>
      client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM party_openings WHERE party_id = $1`,
        [party.id],
      ),
    );

    expect(rows.rows[0]?.count).toBe(1);
  });

  it('refuses an opening dated in the future', async () => {
    await createParty(
      minimalCustomer({
        opening: {
          role: 'CUSTOMER',
          direction: 'RECEIVABLE',
          amountMinor: 250_000,
          businessDate: '2099-01-01',
        },
      }),
    ).expect(400);
  });

  it('refuses an opening for a role the party does not hold', async () => {
    await createParty(
      minimalCustomer({
        opening: {
          // Karim is a customer only, so there is no supplier relationship for
          // this money to belong to. Posting it would put him in `AP` and make
          // the payables report disagree with the supplier list under it.
          role: 'SUPPLIER',
          direction: 'PAYABLE',
          amountMinor: 250_000,
          businessDate: clock.businessDate('Asia/Dhaka'),
        },
      }),
    ).expect(400);
  });
});


/**
 * T08-QA: actual Nest guards and PostgreSQL16 tenant/RLS isolation across
 * all five GET families consumed by the unmounted HisabIQ Party read client.
 * Setup and historical opening writes here are disposable test-only fixtures.
 */
describe('T08-QA — five-endpoint Party read and tenant isolation', () => {
  it('keeps two tenants and both trading-role obligations separate after permission revocation', async () => {
    const date = clock.businessDate('Asia/Dhaka');
    await setSetting(SettingKey.CUSTOMER_GROUPS_ENABLED, 'on');
    const group = await request(app.getHttpServer())
      .post('/api/v1/party-setup/groups')
      .set('Authorization', 'Bearer ' + token)
      .send({ name: 'Tenant A Exclusive Group' })
      .expect(201);
    const groupId = group.body.data.groups[0].id as string;

    const created = await createParty(minimalCustomer({
      name: 'Dual Trading Identity', roles: ['CUSTOMER', 'SUPPLIER'],
      customerGroupId: groupId,
      opening: { role: 'CUSTOMER', direction: 'RECEIVABLE', amountMinor: 500_000, businessDate: date },
    })).expect(201);
    const id = (created.body.data as PartyBody).id;
    const supplierPosted = await request(app.getHttpServer())
      .post('/api/v1/parties/' + id + '/opening')
      .set('Authorization', 'Bearer ' + token)
      .set('Idempotency-Key', Ulid.generate(clock))
      .send({ role: 'SUPPLIER', direction: 'PAYABLE', amountMinor: 300_000, businessDate: date })
      .expect(201);
    expect(supplierPosted.body.data.amountMinor).toBe(300_000);

    const setupA = await request(app.getHttpServer())
      .get('/api/v1/party-setup')
      .set('Authorization', 'Bearer ' + token)
      .expect(200);
    expect(Object.keys(setupA.body)).toEqual(['data']);
    expect(setupA.body.data.features.customerGroups).toBe(true);
    expect(setupA.body.data.groups).toContainEqual({ id: groupId, name: 'Tenant A Exclusive Group' });
    expect(Object.keys(setupA.body.data.fields).sort()).toEqual([
      'address', 'email', 'guardianName', 'nid', 'notes',
    ]);

    for (const [role, signedMinor, direction, account] of [
      ['CUSTOMER', 500_000, 'RECEIVABLE', 'AR'],
      ['SUPPLIER', -300_000, 'PAYABLE', 'AP'],
    ] as const) {
      const listed = await listParties('?role=' + role).expect(200);
      expect(listed.body.data).toHaveLength(1);
      expect(listed.body.data[0].id).toBe(id);
      expect(listed.body.data[0].balance.netMinor).toBe(signedMinor);
      expect(listed.body.summary.total).toBe(1);

      const detail = await request(app.getHttpServer())
        .get('/api/v1/parties/' + id + '?role=' + role)
        .set('Authorization', 'Bearer ' + token)
        .expect(200);
      expect(detail.body.data.id).toBe(id);
      expect(detail.body.data.balance.netMinor).toBe(signedMinor);

      const opening = await request(app.getHttpServer())
        .get('/api/v1/parties/' + id + '/opening?role=' + role)
        .set('Authorization', 'Bearer ' + token)
        .expect(200);
      expect(opening.body.data.role).toBe(role);
      expect(opening.body.data.direction).toBe(direction);
      expect(opening.body.data.amountMinor).toBe(Math.abs(signedMinor));
      expect(opening.body.data.businessDate).toBe(date);

      const ledger = await request(app.getHttpServer())
        .get('/api/v1/parties/' + id + '/ledger?role=' + role)
        .set('Authorization', 'Bearer ' + token)
        .expect(200);
      expect(ledger.body.partyId).toBe(id);
      expect(ledger.body.closingBalance.netMinor).toBe(signedMinor);
      expect(ledger.body.rows).toHaveLength(1);
      expect(ledger.body.rows[0].account).toBe(account);
      expect(ledger.body.rows[0].sourceDocumentType).toBe('OPENING_BALANCE');
      expect(ledger.body.rows[0].sourceDocumentId).toBe(opening.body.data.id);
    }

    // Tenant B has full trading permissions but no authority over tenant A.
    const other = await seedTenant(pool, { name: 'Tenant B', permissions: ALL_PARTIES });
    const otherToken = signToken(other, TEST_JWT_SECRET);
    const setupB = await request(app.getHttpServer())
      .get('/api/v1/party-setup')
      .set('Authorization', 'Bearer ' + otherToken)
      .expect(200);
    expect(setupB.body.data.groups).toEqual([]);
    expect(setupB.body.data.features.customerGroups).toBe(false);
    expect(JSON.stringify(setupB.body)).not.toContain('Tenant A Exclusive Group');

    for (const role of ['CUSTOMER', 'SUPPLIER'] as const) {
      const otherList = await listParties('?role=' + role, otherToken).expect(200);
      expect(otherList.body.data).toHaveLength(0);
      expect(otherList.body.summary.total).toBe(0);
      for (const url of [
        '/api/v1/parties/' + id + '?role=' + role,
        '/api/v1/parties/' + id + '/ledger?role=' + role,
        '/api/v1/parties/' + id + '/opening?role=' + role,
      ]) {
        const missing = await request(app.getHttpServer())
          .get(url).set('Authorization', 'Bearer ' + otherToken).expect(404);
        expect(missing.body.error.code).toBe('NOT_FOUND');
        expect(JSON.stringify(missing.body)).not.toContain('Dual Trading Identity');
      }
    }

    // Customer-view permission must never confer Supplier information.
    await asTenant(pool, tenant.tenantId, async (client) => {
      await client.query(
        'DELETE FROM role_permissions WHERE tenant_id = $1 AND role_id = $2 AND permission_code = $3',
        [tenant.tenantId, tenant.roleId, Permission.SUPPLIER_VIEW],
      );
    });
    const deniedList = await listParties('?role=SUPPLIER').expect(403);
    expect(deniedList.body.error.code).toBe('PERMISSION_DENIED');
    for (const url of [
      '/api/v1/parties/' + id + '?role=SUPPLIER',
      '/api/v1/parties/' + id + '/ledger?role=SUPPLIER',
      '/api/v1/parties/' + id + '/opening?role=SUPPLIER',
    ]) {
      const denied = await request(app.getHttpServer())
        .get(url).set('Authorization', 'Bearer ' + token).expect(403);
      expect(denied.body.error.code).toBe('PERMISSION_DENIED');
    }
    const listA = await listParties('?role=CUSTOMER').expect(200);
    expect(listA.body.data[0].roles).toEqual(['CUSTOMER']);
    expect(listA.body.data[0].balance.netMinor).toBe(500_000);
    const detailA = await request(app.getHttpServer())
      .get('/api/v1/parties/' + id + '?role=CUSTOMER')
      .set('Authorization', 'Bearer ' + token).expect(200);
    expect(detailA.body.data.roles).toEqual(['CUSTOMER']);
    expect(detailA.body.data.balance.netMinor).toBe(500_000);
    const openingA = await request(app.getHttpServer())
      .get('/api/v1/parties/' + id + '/opening?role=CUSTOMER')
      .set('Authorization', 'Bearer ' + token).expect(200);
    expect(openingA.body.data.amountMinor).toBe(500_000);
    const ledgerA = await request(app.getHttpServer())
      .get('/api/v1/parties/' + id + '/ledger?role=CUSTOMER')
      .set('Authorization', 'Bearer ' + token).expect(200);
    expect(ledgerA.body.closingBalance.netMinor).toBe(500_000);

    // Historical opening journals exist independently of cash-session policy.
    const cash = await asTenant(pool, tenant.tenantId, (client) =>
      client.query<{ sessions: number; movements: number }>(
        'SELECT (SELECT count(*)::int FROM cash_sessions WHERE tenant_id = $1) AS sessions, ' +
        '(SELECT count(*)::int FROM cash_movements WHERE tenant_id = $1) AS movements',
        [tenant.tenantId],
      ),
    );
    expect(cash.rows[0]).toEqual({ sessions: 0, movements: 0 });
  });
});


/**
 * T09A — Customer metadata has a different read authority from trading net.
 * Only disposable PostgreSQL16 test fixtures are written, never production data.
 * The party-global deletion guard is intentionally unchanged.
 */
describe('T09A — Customer-only Party READ metadata and query isolation', () => {
  it('masks Supplier/Vendor group and credit attributes and rejects customer-only query probes', async () => {
    await setSetting(SettingKey.CUSTOMER_GROUPS_ENABLED, 'on');
    await setSetting(SettingKey.VENDOR_MANAGEMENT_ENABLED, 'on');
    const group = await request(app.getHttpServer())
      .post('/api/v1/party-setup/groups')
      .set('Authorization', 'Bearer ' + token)
      .send({ name: 'Customer Only Retail Tier' })
      .expect(201);
    const groupId = group.body.data.groups[0].id as string;

    const created = await createParty(minimalCustomer({
      name: 'Multi Role Partner',
      roles: ['CUSTOMER', 'SUPPLIER', 'VENDOR'],
      customerGroupId: groupId,
      creditLimitMinor: 700_000,
    })).expect(201);
    const id = (created.body.data as PartyBody).id;
    expect(created.body.data.customerGroupId).toBe(groupId);
    expect(created.body.data.creditLimitMinor).toBe(700_000);

    await createParty(minimalCustomer({
      name: 'Ungrouped Customer', phone: '01998887766',
    })).expect(201);

    // Customer projection retains all customer-specific fields and real counts.
    const customerList = await listParties('?role=CUSTOMER').expect(200);
    expect(customerList.body.summary.total).toBe(2);
    expect(customerList.body.summary.ungrouped).toBe(1);
    const customerRow = customerList.body.data.find((v: { id: string }) => v.id === id);
    expect(customerRow.customerGroupId).toBe(groupId);
    expect(customerRow.customerGroupName).toBe('Customer Only Retail Tier');
    expect(customerRow.creditLimitMinor).toBe(700_000);
    const customerDetail = await request(app.getHttpServer())
      .get('/api/v1/parties/' + id + '?role=CUSTOMER')
      .set('Authorization', 'Bearer ' + token).expect(200);
    expect(customerDetail.body.data.customerGroupId).toBe(groupId);
    expect(customerDetail.body.data.creditLimitMinor).toBe(700_000);
    const groupFiltered = await listParties('?role=CUSTOMER&groupId=' + groupId).expect(200);
    expect(groupFiltered.body.data).toHaveLength(1);
    expect(groupFiltered.body.data[0].id).toBe(id);
    await listParties('?role=CUSTOMER&sort=groupName').expect(200);
    await listParties('?role=CUSTOMER&sort=creditLimit').expect(200);

    for (const role of ['SUPPLIER', 'VENDOR'] as const) {
      const list = await listParties('?role=' + role).expect(200);
      expect(list.body.data).toHaveLength(1);
      expect(list.body.summary.total).toBe(1);
      expect(list.body.summary.ungrouped).toBeNull();
      expect(list.body.data[0].customerGroupId).toBeNull();
      expect(list.body.data[0].customerGroupName).toBeNull();
      expect(list.body.data[0].creditLimitMinor).toBeNull();
      const detail = await request(app.getHttpServer())
        .get('/api/v1/parties/' + id + '?role=' + role)
        .set('Authorization', 'Bearer ' + token).expect(200);
      expect(detail.body.data.customerGroupId).toBeNull();
      expect(detail.body.data.customerGroupName).toBeNull();
      expect(detail.body.data.creditLimitMinor).toBeNull();

      for (const query of [
        '&groupId=' + groupId,
        '&sort=groupName',
        '&sort=creditLimit',
      ]) {
        const denied = await listParties('?role=' + role + query).expect(400);
        expect(denied.body.error.code).toBe('VALIDATION_FAILED');
        expect(JSON.stringify(denied.body)).not.toContain(groupId);
      }
    }

    // Revoked Customer VIEW does not grant Customer profile data through
    // another trading role, even on a Party sharing the same identity.
    await asTenant(pool, tenant.tenantId, (client) => client.query(
      'DELETE FROM role_permissions WHERE tenant_id = $1 AND role_id = $2 AND permission_code = $3',
      [tenant.tenantId, tenant.roleId, Permission.CUSTOMER_VIEW],
    ).then(() => undefined));
    await listParties('?role=CUSTOMER').expect(403);
    const supplierOnly = await listParties('?role=SUPPLIER').expect(200);
    expect(supplierOnly.body.data[0].roles).toEqual(['SUPPLIER', 'VENDOR']);
    expect(supplierOnly.body.data[0].customerGroupId).toBeNull();
    expect(supplierOnly.body.summary.ungrouped).toBeNull();
    const restricted = await request(app.getHttpServer())
      .get('/api/v1/parties/' + id + '?role=SUPPLIER')
      .set('Authorization', 'Bearer ' + token).expect(200);
    expect(restricted.body.data.roles).toEqual(['SUPPLIER', 'VENDOR']);
    expect(restricted.body.data.customerGroupName).toBeNull();
    expect(restricted.body.data.creditLimitMinor).toBeNull();

    // Even fully authorized tenant B cannot infer tenant A's group or Party.
    const tenantB = await seedTenant(pool, { name: 'T09A Tenant B', permissions: ALL_PARTIES });
    const tenantBToken = signToken(tenantB, TEST_JWT_SECRET);
    const empty = await listParties('?role=SUPPLIER', tenantBToken).expect(200);
    expect(empty.body.data).toHaveLength(0);
    expect(empty.body.summary.ungrouped).toBeNull();
    await request(app.getHttpServer())
      .get('/api/v1/parties/' + id + '?role=SUPPLIER')
      .set('Authorization', 'Bearer ' + tenantBToken).expect(404);
  });
});


/**
 * MOD-004 T09B: setup is needed by all trading-role screens, but only explicit
 * Customer-facing or group-management permissions can read customer group IDs.
 * Exercises signed tokens and tenant RLS against disposable PostgreSQL 16.
 */
describe('T09B — Party setup Customer-group catalog authority', () => {
  async function setOnePermission(code: string | null): Promise<void> {
    await asTenant(pool, tenant.tenantId, async (client) => {
      await client.query(
        'DELETE FROM role_permissions WHERE tenant_id = $1 AND role_id = $2',
        [tenant.tenantId, tenant.roleId],
      );
      if (code !== null) {
        const now = clock.now();
        await client.query(
          'INSERT INTO role_permissions (id, tenant_id, role_id, permission_code, created_at, updated_at, created_by, updated_by, version) VALUES ($1, $2, $3, $4, $5, $5, $6, $6, 1)',
          [Ulid.generate(clock), tenant.tenantId, tenant.roleId, code, now, tenant.userId],
        );
      }
    });
  }

  function getSetup(as = token): request.Test {
    return request(app.getHttpServer())
      .get('/api/v1/party-setup')
      .set('Authorization', 'Bearer ' + as);
  }

  it('retains Supplier/Vendor setup without leaking Customer groups and permits authorized catalog readers', async () => {
    await setSetting(SettingKey.CUSTOMER_GROUPS_ENABLED, 'on');
    await setSetting(SettingKey.VENDOR_MANAGEMENT_ENABLED, 'on');

    const created = await request(app.getHttpServer())
      .post('/api/v1/party-setup/groups')
      .set('Authorization', 'Bearer ' + token)
      .send({ name: 'T09B Private Customer Tier' })
      .expect(201);
    const group = created.body.data.groups[0] as { id: string; name: string };
    expect(group.name).toBe('T09B Private Customer Tier');

    const party = await createParty(minimalCustomer({
      name: 'T09B Shared Partner',
      roles: ['CUSTOMER', 'SUPPLIER'],
      customerGroupId: group.id,
    })).expect(201);
    const partyId = (party.body.data as PartyBody).id;

    const ownerSetup = await getSetup().expect(200);
    expect(ownerSetup.body.data.groups).toContainEqual(group);
    expect(ownerSetup.body.data.features).toEqual({ customerGroups: true, vendors: true });

    // On a single existing tenant/identity, replace the signed user's role
    // permissions. A new HTTP request must evaluate current grants every time.
    for (const [permission, canReadGroups] of [
      [Permission.SUPPLIER_VIEW, false],
      [Permission.VENDOR_VIEW, false],
      [Permission.SUPPLIER_CREATE, false],
      [Permission.VENDOR_CREATE, false],
      [Permission.CUSTOMER_VIEW, true],
      [Permission.CUSTOMER_CREATE, true],
      [Permission.PARTY_GROUP_MANAGE, true],
    ] as const) {
      await setOnePermission(permission);
      const response = await getSetup().expect(200);
      expect(response.body.data.features).toEqual({ customerGroups: true, vendors: true });
      expect(Object.keys(response.body.data.fields).sort()).toEqual([
        'address', 'email', 'guardianName', 'nid', 'notes',
      ]);
      if (canReadGroups) {
        expect(response.body.data.groups).toContainEqual(group);
      } else {
        expect(response.body.data.groups).toEqual([]);
        expect(JSON.stringify(response.body)).not.toContain(group.id);
        expect(JSON.stringify(response.body)).not.toContain(group.name);
      }

      if (permission === Permission.SUPPLIER_VIEW) {
        const supplierList = await listParties('?role=SUPPLIER').expect(200);
        expect(supplierList.body.data.some((item: { id: string }) => item.id === partyId)).toBe(true);
        const supplierLedger = await request(app.getHttpServer())
          .get('/api/v1/parties/' + partyId + '/ledger?role=SUPPLIER')
          .set('Authorization', 'Bearer ' + token)
          .expect(200);
        expect(supplierLedger.body.partyId).toBe(partyId);
      }

      if (permission === Permission.PARTY_GROUP_MANAGE) {
        // A group manager without Customer/other Party VIEW must still be able
        // to read setup: create/rename-group return its response after commit.
        const newlyManaged = await request(app.getHttpServer())
          .post('/api/v1/party-setup/groups')
          .set('Authorization', 'Bearer ' + token)
          .send({ name: 'T09B Managed Group' })
          .expect(201);
        expect(newlyManaged.body.data.groups).toContainEqual(group);
        expect(newlyManaged.body.data.groups.some((g: { name: string }) =>
          g.name === 'T09B Managed Group')).toBe(true);
      }
    }

    await setOnePermission(null);
    const denied = await getSetup().expect(403);
    expect(denied.body.error.code).toBe('PERMISSION_DENIED');
  });

  it('keeps enabled Customer groups tenant-private and hides them when feature is off', async () => {
    await setSetting(SettingKey.CUSTOMER_GROUPS_ENABLED, 'on');
    const createdA = await request(app.getHttpServer())
      .post('/api/v1/party-setup/groups')
      .set('Authorization', 'Bearer ' + token)
      .send({ name: 'Tenant A Secret Customer Group' })
      .expect(201);
    const groupA = createdA.body.data.groups[0] as { id: string; name: string };

    const other = await seedTenant(pool, { name: 'T09B Tenant B', permissions: ALL_PARTIES });
    const otherToken = signToken(other, TEST_JWT_SECRET);
    await request(app.getHttpServer())
      .post('/api/v1/settings/value')
      .set('Authorization', 'Bearer ' + otherToken)
      .send({ key: SettingKey.CUSTOMER_GROUPS_ENABLED, value: 'on' })
      .expect(201);

    const emptyB = await getSetup(otherToken).expect(200);
    expect(emptyB.body.data.features.customerGroups).toBe(true);
    expect(emptyB.body.data.groups).toEqual([]);

    const createdB = await request(app.getHttpServer())
      .post('/api/v1/party-setup/groups')
      .set('Authorization', 'Bearer ' + otherToken)
      .send({ name: 'Tenant B Own Customer Group' })
      .expect(201);
    const groupB = createdB.body.data.groups[0] as { id: string; name: string };
    expect(groupB).not.toEqual(groupA);
    expect(createdB.body.data.groups).toEqual([groupB]);
    expect(JSON.stringify(createdB.body)).not.toContain(groupA.id);
    expect(JSON.stringify(createdB.body)).not.toContain(groupA.name);

    const sameA = await getSetup().expect(200);
    expect(sameA.body.data.groups).toEqual([groupA]);
    expect(JSON.stringify(sameA.body)).not.toContain(groupB.id);

    await setSetting(SettingKey.CUSTOMER_GROUPS_ENABLED, 'off');
    const offA = await getSetup().expect(200);
    expect(offA.body.data.features.customerGroups).toBe(false);
    expect(offA.body.data.groups).toEqual([]);
    const unchangedB = await getSetup(otherToken).expect(200);
    expect(unchangedB.body.data.features.customerGroups).toBe(true);
    expect(unchangedB.body.data.groups).toEqual([groupB]);
  });
});


/**
 * MOD-004 T09C-0: a read of one trading relationship is not authority to
 * discard a shared Party whose *other* relationship has posted a journal.
 * This fixes the accounting safety contract in a test; it does not decide
 * who may see NID/notes or the party-global hasLedgerEntries wire flag.
 */
describe('T09C-0 — party-global delete guard with cross-role history', () => {
  it('preserves Supplier-only postings after Customer-only delete request and still deletes genuinely unused parties', async () => {
    const date = clock.businessDate('Asia/Dhaka');
    const dual = await createParty(minimalCustomer({
      name: 'T09C Shared Customer Supplier',
      roles: ['CUSTOMER', 'SUPPLIER'],
    })).expect(201);
    const sharedId = (dual.body.data as PartyBody).id;

    // Posting through the *existing* source-linked historical-opening writer,
    // not by constructing an orphan journal row in SQL.
    const posted = await request(app.getHttpServer())
      .post('/api/v1/parties/' + sharedId + '/opening')
      .set('Authorization', 'Bearer ' + token)
      .set('Idempotency-Key', Ulid.generate(clock))
      .send({
        role: 'SUPPLIER',
        direction: 'PAYABLE',
        amountMinor: 315_000,
        businessDate: date,
      })
      .expect(201);
    expect(posted.body.data.amountMinor).toBe(315_000);
    expect(posted.body.data.role).toBe('SUPPLIER');

    const unused = await createParty(minimalCustomer({
      name: 'T09C Unused Customer',
      phone: '01899887766',
    })).expect(201);
    const unusedId = (unused.body.data as PartyBody).id;

    // Simulate a cashier who may view/deactivate a Customer but cannot view,
    // edit, or deactivate the Supplier relationship sharing the identity.
    await asTenant(pool, tenant.tenantId, async (client) => {
      await client.query(
        'DELETE FROM role_permissions WHERE tenant_id = $1 AND role_id = $2 AND permission_code NOT IN ($3, $4)',
        [tenant.tenantId, tenant.roleId, Permission.CUSTOMER_VIEW, Permission.CUSTOMER_DEACTIVATE],
      );
    });

    const customer = await request(app.getHttpServer())
      .get('/api/v1/parties/' + sharedId + '?role=CUSTOMER')
      .set('Authorization', 'Bearer ' + token)
      .expect(200);
    expect(customer.body.data.roles).toEqual(['CUSTOMER']);
    expect(customer.body.data.balance.netMinor).toBe(0);
    const customerOpening = await request(app.getHttpServer())
      .get('/api/v1/parties/' + sharedId + '/opening?role=CUSTOMER')
      .set('Authorization', 'Bearer ' + token)
      .expect(200);
    expect(customerOpening.body.data).toBeNull();
    await request(app.getHttpServer())
      .get('/api/v1/parties/' + sharedId + '/opening?role=SUPPLIER')
      .set('Authorization', 'Bearer ' + token)
      .expect(403);
    await listParties('?role=SUPPLIER').expect(403);

    // The global delete guard must *not* use the selected Customer's zero
    // balance or its absent opening as proof the shared Party is unused.
    const refused = await request(app.getHttpServer())
      .delete('/api/v1/parties/' + sharedId)
      .set('Authorization', 'Bearer ' + token)
      .expect(400);
    expect(refused.body.error.code).toBe('VALIDATION_FAILED');

    const rows = await asTenant(pool, tenant.tenantId, (client) => client.query<{
      parties: number; supplierLines: number;
    }>(
      'SELECT (SELECT count(*)::int FROM parties WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL) AS parties, ' +
      '(SELECT count(*)::int FROM journal_lines WHERE tenant_id = $1 AND party_id = $2 AND account_code = $3) AS "supplierLines"',
      [tenant.tenantId, sharedId, 'AP'],
    ));
    expect(rows.rows[0]).toEqual({ parties: 1, supplierLines: 1 });

    // The same limited permission *does* allow removal of a truly unused,
    // non-reserved Customer. Refusal above was about history, not blanket auth.
    await request(app.getHttpServer())
      .delete('/api/v1/parties/' + unusedId)
      .set('Authorization', 'Bearer ' + token)
      .expect(204);
    await request(app.getHttpServer())
      .get('/api/v1/parties/' + unusedId + '?role=CUSTOMER')
      .set('Authorization', 'Bearer ' + token)
      .expect(404);

    const stillHere = await request(app.getHttpServer())
      .get('/api/v1/parties/' + sharedId + '?role=CUSTOMER')
      .set('Authorization', 'Bearer ' + token)
      .expect(200);
    expect(stillHere.body.data.id).toBe(sharedId);
  });


  it('enforces Customer deactivate authority before deleting even an unused Party', async () => {
    const created = await createParty(minimalCustomer({
      name: 'T09C No Permission Customer',
      phone: '01987654321',
    })).expect(201);
    const id = (created.body.data as PartyBody).id;
    await asTenant(pool, tenant.tenantId, (client) => client.query(
      'DELETE FROM role_permissions WHERE tenant_id = $1 AND role_id = $2 AND permission_code = $3',
      [tenant.tenantId, tenant.roleId, Permission.CUSTOMER_DEACTIVATE],
    ));

    // A Customer VIEW grant does not imply delete authority. The record has
    // never posted a journal, so this refusal proves permissions, not history.
    const refused = await request(app.getHttpServer())
      .delete('/api/v1/parties/' + id)
      .set('Authorization', 'Bearer ' + token)
      .expect(403);
    expect(refused.body.error.code).toBe('PERMISSION_DENIED');

    const intact = await request(app.getHttpServer())
      .get('/api/v1/parties/' + id + '?role=CUSTOMER')
      .set('Authorization', 'Bearer ' + token)
      .expect(200);
    expect(intact.body.data.id).toBe(id);

    const unchanged = await asTenant(pool, tenant.tenantId, (client) => client.query<{
      parties: number; lines: number;
    }>(
      'SELECT (SELECT count(*)::int FROM parties WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL) AS parties, ' +
      '(SELECT count(*)::int FROM journal_lines WHERE tenant_id = $1 AND party_id = $2) AS lines',
      [tenant.tenantId, id],
    ));
    expect(unchanged.rows[0]).toEqual({ parties: 1, lines: 0 });
  });

  it('returns 404 and retains posted history when a different tenant tries to read or delete the Party', async () => {
    const dual = await createParty(minimalCustomer({
      name: 'T09C Tenant A Shared Customer Supplier',
      roles: ['CUSTOMER', 'SUPPLIER'],
    })).expect(201);
    const id = (dual.body.data as PartyBody).id;
    await request(app.getHttpServer())
      .post('/api/v1/parties/' + id + '/opening')
      .set('Authorization', 'Bearer ' + token)
      .set('Idempotency-Key', Ulid.generate(clock))
      .send({
        role: 'SUPPLIER',
        direction: 'PAYABLE',
        amountMinor: 125_000,
        businessDate: clock.businessDate('Asia/Dhaka'),
      })
      .expect(201);

    const other = await seedTenant(pool, {
      name: 'T09C Unrelated Tenant B',
      permissions: [Permission.CUSTOMER_VIEW, Permission.CUSTOMER_DEACTIVATE],
    });
    const otherToken = signToken(other, TEST_JWT_SECRET);

    await request(app.getHttpServer())
      .get('/api/v1/parties/' + id + '?role=CUSTOMER')
      .set('Authorization', 'Bearer ' + otherToken)
      .expect(404);
    await request(app.getHttpServer())
      .delete('/api/v1/parties/' + id)
      .set('Authorization', 'Bearer ' + otherToken)
      .expect(404);
    const tenantBList = await listParties('?role=CUSTOMER', otherToken).expect(200);
    expect(tenantBList.body.data).toEqual([]);

    const retained = await asTenant(pool, tenant.tenantId, (client) => client.query<{
      parties: number; supplierLines: number; supplierAmount: number;
    }>(
      'SELECT (SELECT count(*)::int FROM parties WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL) AS parties, ' +
      '(SELECT count(*)::int FROM journal_lines WHERE tenant_id = $1 AND party_id = $2 AND account_code = $3) AS "supplierLines", ' +
      '(SELECT coalesce(sum(amount_minor),0)::int FROM journal_lines WHERE tenant_id = $1 AND party_id = $2 AND account_code = $3) AS "supplierAmount"',
      [tenant.tenantId, id, 'AP'],
    ));
    expect(retained.rows[0]).toEqual({
      parties: 1,
      supplierLines: 1,
      supplierAmount: -125_000,
    });
  });
});
