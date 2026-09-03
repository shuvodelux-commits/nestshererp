/*
 * Coverage claims, read by `pnpm test:inventory` (owner request 2026-09-03).
 *
 * These are what this file is answerable for in the test matrix. A claim naming
 * something the inventory no longer contains fails the scan, so a screen renamed
 * out from under a test cannot leave the coverage report quietly overstating itself.
 *
 * @covers endpoint:GET /api/v1/roles
 * @covers endpoint:GET /api/v1/settings
 * @covers endpoint:PATCH /api/v1/settings/business
 * @covers endpoint:POST /api/v1/auth/login
 * @covers endpoint:POST /api/v1/auth/password/otp
 * @covers endpoint:POST /api/v1/auth/password/reset
 * @covers endpoint:POST /api/v1/auth/registration
 * @covers endpoint:POST /api/v1/auth/registration/otp
 * @covers endpoint:POST /api/v1/settings/value
 * @covers endpoint:POST /api/v1/users
 */
import 'reflect-metadata';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { AppErrorFilter } from '../src/common/app-error.filter';
import { asTenant, prepareTestDatabase, resetDatabase, testPool } from './support/database';

/**
 * Slice 1.5 — settings and feature controls (§5.21). Expected values written
 * before the code.
 *
 * The rules that matter here are the ones a wrong answer hides for months:
 *
 *   A setting nobody has touched reads as its shipped default, not as empty.
 *   §5.21 defines defaults, and a screen showing "off" for a default-on feature
 *   would be lying about what the software is doing.
 *
 *   "Invalid combinations are prevented, not merely discouraged." Turning a
 *   parent off carries its dependents off with it, transitively, in the same
 *   transaction — never leaving one enabled and broken.
 *
 *   Changing the costing method is a §5.3 step-up action. It decides what every
 *   sale is recorded as costing, and it is not something a walked-away-from
 *   session should be able to do.
 */
const OWNER_PHONE = '01712345678';
const OWNER_PASSWORD = 'Passw0rd23';

let app: INestApplication;
let pool: pg.Pool;

interface Owner {
  readonly accessToken: string;
  readonly tenantId: string;
  readonly userId: string;
}

async function registerOwner(identifier = OWNER_PHONE): Promise<Owner> {
  const otp = await request(app.getHttpServer())
    .post('/api/v1/auth/registration/otp')
    .send({ identifier });

  const created = await request(app.getHttpServer())
    .post('/api/v1/auth/registration')
    .send({
      identifier,
      otpCode: otp.body.data.devCode as string,
      businessName: 'Karim Traders',
      username: 'karim',
      password: OWNER_PASSWORD,
      pin: '4821',
    });

  expect(created.status).toBe(201);
  return {
    accessToken: created.body.data.accessToken as string,
    tenantId: created.body.data.tenant.id as string,
    userId: created.body.data.user.id as string,
  };
}

function getSettings(token: string): request.Test {
  return request(app.getHttpServer())
    .get('/api/v1/settings')
    .set('Authorization', `Bearer ${token}`);
}

function setValue(token: string, body: Record<string, unknown>): request.Test {
  return request(app.getHttpServer())
    .post('/api/v1/settings/value')
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}

function setBusiness(token: string, body: Record<string, unknown>): request.Test {
  return request(app.getHttpServer())
    .patch('/api/v1/settings/business')
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}

/** Turns on every parent consignment needs, so the cascade has something to fell. */
async function enableVendorChain(token: string): Promise<void> {
  for (const key of [
    'vendor_management_enabled',
    'vendor_ledger_enabled',
    'vendor_consignment_enabled',
  ]) {
    const response = await setValue(token, { key, value: 'on' });
    expect(response.status).toBe(201);
  }
}

beforeAll(async () => {
  await prepareTestDatabase();
  pool = testPool();

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
});

describe('settings', () => {
  it('reads the shipped defaults before anything has been changed', async () => {
    const owner = await registerOwner();

    const response = await getSettings(owner.accessToken);

    expect(response.status).toBe(200);
    expect(response.body.data.businessName).toBe('Karim Traders');
    expect(response.body.data.timezone).toBe('Asia/Dhaka');
    // The exact §5.21 / PART 5A defaults, not "some value".
    expect(response.body.data.values.sale_costing_method).toBe('FIFO');
    expect(response.body.data.values.inventory_issue_method).toBe('FIFO');
    expect(response.body.data.values.negative_stock_policy).toBe('BLOCK');
    expect(response.body.data.values.expired_stock_sale_policy).toBe('BLOCK');
    expect(response.body.data.values.cash_session_enabled).toBe('on');
    expect(response.body.data.values.product_offers_enabled).toBe('on');
    expect(response.body.data.values.customer_field_address_visible).toBe('on');
    expect(response.body.data.values.vendor_consignment_enabled).toBe('off');

    // A default is not a row: nothing has been stored yet.
    const stored = await asTenant(pool, owner.tenantId, (client) =>
      client.query('SELECT count(*)::int AS n FROM settings'),
    );
    expect(stored.rows[0].n).toBe(0);
  });

  it('stores a changed toggle and reports it on the next read', async () => {
    const owner = await registerOwner();

    const saved = await setValue(owner.accessToken, {
      key: 'serial_tracking_enabled',
      value: 'on',
    });

    expect(saved.status).toBe(201);
    expect(saved.body.data.values.serial_tracking_enabled).toBe('on');
    expect(saved.body.warnings).toEqual([]);

    const reread = await getSettings(owner.accessToken);
    expect(reread.body.data.values.serial_tracking_enabled).toBe('on');
  });

  it('refuses a value the setting does not take, and stores nothing', async () => {
    const owner = await registerOwner();

    const refused = await setValue(owner.accessToken, {
      key: 'negative_stock_policy',
      value: 'LIFO',
    });

    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('VALIDATION_FAILED');

    const reread = await getSettings(owner.accessToken);
    expect(reread.body.data.values.negative_stock_policy).toBe('BLOCK');
  });

  it('refuses an unknown key rather than storing a setting nothing reads', async () => {
    const owner = await registerOwner();

    const refused = await setValue(owner.accessToken, { key: 'lifo_enabled', value: 'on' });

    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('VALIDATION_FAILED');

    const stored = await asTenant(pool, owner.tenantId, (client) =>
      client.query('SELECT count(*)::int AS n FROM settings'),
    );
    expect(stored.rows[0].n).toBe(0);
  });

  describe('feature dependencies (§5.21)', () => {
    it('refuses to turn on a feature whose parent is off, and names the parent', async () => {
      const owner = await registerOwner();

      const refused = await setValue(owner.accessToken, {
        key: 'warranty_enabled',
        value: 'on',
      });

      expect(refused.status).toBe(400);
      expect(refused.body.error.code).toBe('VALIDATION_FAILED');
      expect(refused.body.error.details.requires).toBe('serial_tracking_enabled');

      const reread = await getSettings(owner.accessToken);
      expect(reread.body.data.values.warranty_enabled).toBe('off');
    });

    it('names every missing parent when a feature needs two', async () => {
      const owner = await registerOwner();

      const refused = await setValue(owner.accessToken, {
        key: 'dealer_pricing_enabled',
        value: 'on',
      });

      expect(refused.status).toBe(400);
      expect(refused.body.error.details.requires).toBe(
        'wholesale_sales_enabled, customer_groups_enabled',
      );
    });

    it('turns dependents off with their parent, transitively, and says which', async () => {
      const owner = await registerOwner();
      await enableVendorChain(owner.accessToken);

      const off = await setValue(owner.accessToken, {
        key: 'vendor_management_enabled',
        value: 'off',
      });

      expect(off.status).toBe(201);
      expect(off.body.data.values.vendor_management_enabled).toBe('off');
      // Vendor ledger depends on management; consignment depends on the ledger.
      // One level of cascade would have left consignment on and broken.
      expect(off.body.data.values.vendor_ledger_enabled).toBe('off');
      expect(off.body.data.values.vendor_consignment_enabled).toBe('off');
      expect(off.body.warnings).toHaveLength(2);
      expect(off.body.warnings[0].code).toBe('FEATURE_DISABLED');

      const reread = await getSettings(owner.accessToken);
      expect(reread.body.data.values.vendor_consignment_enabled).toBe('off');
    });

    it('audits a cascaded setting with the reason it changed', async () => {
      const owner = await registerOwner();
      await enableVendorChain(owner.accessToken);

      await setValue(owner.accessToken, { key: 'vendor_management_enabled', value: 'off' });

      const events = await asTenant(pool, owner.tenantId, (client) =>
        client.query(
          `SELECT entity_id, before_json, after_json, reason
             FROM audit_events
            WHERE entity_type = 'setting' AND after_json ->> 'value' = 'off'
            ORDER BY id`,
        ),
      );

      const consignment = events.rows.find(
        (row: { entity_id: string }) => row.entity_id === 'vendor_consignment_enabled',
      );
      expect(consignment.before_json.value).toBe('on');
      expect(consignment.after_json.value).toBe('off');
      // The owner never clicked this one; the trail has to be able to say so.
      expect(consignment.reason).toBe('Turned off with Vendors');
    });
  });

  describe('step-up (§5.3)', () => {
    it('refuses to change the costing method without the password', async () => {
      const owner = await registerOwner();

      const refused = await setValue(owner.accessToken, {
        key: 'sale_costing_method',
        value: 'AVERAGE',
      });

      expect(refused.status).toBe(401);
      expect(refused.body.error.code).toBe('UNAUTHENTICATED');

      const reread = await getSettings(owner.accessToken);
      expect(reread.body.data.values.sale_costing_method).toBe('FIFO');
    });

    it('refuses a wrong password and leaves the method alone', async () => {
      const owner = await registerOwner();

      const refused = await setValue(owner.accessToken, {
        key: 'sale_costing_method',
        value: 'AVERAGE',
        confirmPassword: 'NotThePassword9',
      });

      expect(refused.status).toBe(401);

      const reread = await getSettings(owner.accessToken);
      expect(reread.body.data.values.sale_costing_method).toBe('FIFO');
    });

    it('changes the costing method when the password is right', async () => {
      const owner = await registerOwner();

      const saved = await setValue(owner.accessToken, {
        key: 'sale_costing_method',
        value: 'AVERAGE',
        confirmPassword: OWNER_PASSWORD,
      });

      expect(saved.status).toBe(201);
      expect(saved.body.data.values.sale_costing_method).toBe('AVERAGE');
      // The other costing setting is separate (PART 5A) and must not move with it.
      expect(saved.body.data.values.inventory_issue_method).toBe('FIFO');
    });

    it('does not accept the PIN in place of the password', async () => {
      const owner = await registerOwner();

      const refused = await setValue(owner.accessToken, {
        key: 'sale_costing_method',
        value: 'AVERAGE',
        confirmPassword: '4821',
      });

      expect(refused.status).toBe(401);
    });

    it('never writes the password into the audit trail', async () => {
      const owner = await registerOwner();

      await setValue(owner.accessToken, {
        key: 'sale_costing_method',
        value: 'AVERAGE',
        confirmPassword: OWNER_PASSWORD,
      });

      const events = await asTenant(pool, owner.tenantId, (client) =>
        client.query(
          `SELECT before_json, after_json FROM audit_events WHERE entity_type = 'setting'`,
        ),
      );

      const serialized = JSON.stringify(events.rows);
      expect(serialized).not.toContain(OWNER_PASSWORD);
      expect(serialized).toContain('AVERAGE');
    });
  });

  describe('business profile', () => {
    it('renames the business and audits both sides', async () => {
      const owner = await registerOwner();

      const saved = await setBusiness(owner.accessToken, {
        businessName: 'Karim Electronics',
        timezone: 'Asia/Dhaka',
      });

      expect(saved.status).toBe(200);
      expect(saved.body.data.businessName).toBe('Karim Electronics');

      const events = await asTenant(pool, owner.tenantId, (client) =>
        client.query(
          `SELECT before_json, after_json
             FROM audit_events
            WHERE entity_type = 'tenant' AND action = 'UPDATE'`,
        ),
      );
      expect(events.rows).toHaveLength(1);
      expect(events.rows[0].before_json.businessName).toBe('Karim Traders');
      expect(events.rows[0].after_json.businessName).toBe('Karim Electronics');
    });

    it('refuses a timezone SherERP does not support', async () => {
      const owner = await registerOwner();

      // business_date is computed in this zone (§3.5). An unrecognised one would
      // put every later transaction on an unknowable day.
      const refused = await setBusiness(owner.accessToken, {
        businessName: 'Karim Traders',
        timezone: 'Mars/Olympus',
      });

      expect(refused.status).toBe(400);
      expect(refused.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('permissions and tenants', () => {
    it('refuses a caller whose role holds no settings permission', async () => {
      const owner = await registerOwner();

      // A Manager, per §5.26: "All operations… no settings/users."
      const roles = await request(app.getHttpServer())
        .get('/api/v1/roles')
        .set('Authorization', `Bearer ${owner.accessToken}`);
      const manager = roles.body.data.roles.find(
        (role: { code: string }) => role.code === 'MANAGER',
      );

      const created = await request(app.getHttpServer())
        .post('/api/v1/users')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({
          displayName: 'Rina Akter',
          username: 'rina',
          identifier: '01812345679',
          roleId: manager.id as string,
          confirmPassword: OWNER_PASSWORD,
        });
      expect(created.status).toBe(201);

      const reset = await request(app.getHttpServer())
        .post('/api/v1/auth/password/otp')
        .send({ identifier: '01812345679' });
      await request(app.getHttpServer())
        .post('/api/v1/auth/password/reset')
        .send({
          identifier: '01812345679',
          otpCode: reset.body.data.devCode as string,
          password: 'Manager2026',
        });
      const signedIn = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ identifier: '01812345679', password: 'Manager2026' });
      expect(signedIn.status).toBe(200);

      const managerToken = signedIn.body.data.accessToken as string;

      expect((await getSettings(managerToken)).status).toBe(403);
      expect(
        (await setValue(managerToken, { key: 'serial_tracking_enabled', value: 'on' })).status,
      ).toBe(403);
    });

    it('keeps one tenant’s settings invisible to another', async () => {
      const first = await registerOwner('01712345678');
      await setValue(first.accessToken, { key: 'serial_tracking_enabled', value: 'on' });

      const second = await registerOwner('01912345678');
      const theirs = await getSettings(second.accessToken);

      expect(theirs.status).toBe(200);
      expect(theirs.body.data.businessName).toBe('Karim Traders');
      // Their own default, never the first tenant's stored value.
      expect(theirs.body.data.values.serial_tracking_enabled).toBe('off');
    });
  });
});
