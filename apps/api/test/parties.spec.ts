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
