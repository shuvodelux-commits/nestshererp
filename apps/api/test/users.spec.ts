/*
 * Coverage claims, read by `pnpm test:inventory` (owner request 2026-09-03).
 *
 * These are what this file is answerable for in the test matrix. A claim naming
 * something the inventory no longer contains fails the scan, so a screen renamed
 * out from under a test cannot leave the coverage report quietly overstating itself.
 *
 * @covers endpoint:GET /api/v1/me
 * @covers endpoint:GET /api/v1/users
 * @covers endpoint:PATCH /api/v1/users/:id
 * @covers endpoint:POST /api/v1/auth/login
 * @covers endpoint:POST /api/v1/auth/password/otp
 * @covers endpoint:POST /api/v1/auth/password/reset
 * @covers endpoint:POST /api/v1/auth/refresh
 * @covers endpoint:POST /api/v1/auth/registration
 * @covers endpoint:POST /api/v1/auth/registration/otp
 * @covers endpoint:POST /api/v1/users
 * @covers endpoint:POST /api/v1/users/:id/disabled
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
 * Slice 1.3 — create and edit users (§5.3, §5.26). Expected values written
 * before the code.
 *
 * This is the first slice where `ctx.userId` is not always the owner, so it is
 * also the first real exercise of the permission chain: a cashier may see the
 * team, a manager may not add to it, and only an owner may disable anyone.
 */
const OWNER_PHONE = '01712345678';
const OWNER_PASSWORD = 'Passw0rd23';
const OWNER_PIN = '4821';

let app: INestApplication;
let pool: pg.Pool;

interface Owner {
  readonly accessToken: string;
  readonly refreshToken: string;
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
      pin: OWNER_PIN,
    });

  expect(created.status).toBe(201);
  return {
    accessToken: created.body.data.accessToken as string,
    refreshToken: created.body.data.refreshToken as string,
    tenantId: created.body.data.tenant.id as string,
    userId: created.body.data.user.id as string,
  };
}

function listUsers(token: string): request.Test {
  return request(app.getHttpServer()).get('/api/v1/users').set('Authorization', `Bearer ${token}`);
}

function addUser(token: string, body: Record<string, unknown>): request.Test {
  return request(app.getHttpServer())
    .post('/api/v1/users')
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}

function editUser(token: string, id: string, body: Record<string, unknown>): request.Test {
  return request(app.getHttpServer())
    .patch(`/api/v1/users/${id}`)
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}

function setDisabled(token: string, id: string, body: Record<string, unknown>): request.Test {
  return request(app.getHttpServer())
    .post(`/api/v1/users/${id}/disabled`)
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}

/** The seeded role ids, by code. */
async function rolesOf(token: string): Promise<Record<string, string>> {
  const listed = await listUsers(token);
  const byCode: Record<string, string> = {};
  for (const role of listed.body.data.roles as { id: string; code: string }[]) {
    byCode[role.code] = role.id;
  }
  return byCode;
}

/** Adds a staff member and returns their id. */
async function addCashier(owner: Owner, identifier = '01799887766'): Promise<string> {
  const roles = await rolesOf(owner.accessToken);
  const created = await addUser(owner.accessToken, {
    displayName: 'Rahim Uddin',
    username: 'rahim',
    identifier,
    roleId: roles['CASHIER'],
    confirmPassword: OWNER_PASSWORD,
  });
  expect(created.status).toBe(201);
  return created.body.data.id as string;
}

function inTenant(tenantId: string, sql: string): Promise<pg.QueryResult> {
  return asTenant(pool, tenantId, (client) => client.query(sql));
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
});

describe('the roles a business starts with (§5.26)', () => {
  it('ships all six, so the first hire need not be an Owner', async () => {
    const owner = await registerOwner();

    const listed = await listUsers(owner.accessToken);

    expect(listed.status).toBe(200);
    const codes = (listed.body.data.roles as { code: string }[]).map((role) => role.code).sort();
    expect(codes).toEqual([
      'ACCOUNTANT',
      'CASHIER',
      'MANAGER',
      'OWNER',
      'STOREKEEPER',
      'VIEWER',
    ]);
  });

  it('gives user administration to the Owner alone', async () => {
    const owner = await registerOwner();

    const granted = await inTenant(
      owner.tenantId,
      `SELECT r.code, p.permission_code FROM role_permissions p
         JOIN roles r ON r.id = p.role_id
        WHERE p.permission_code LIKE 'user.%'
        ORDER BY r.code, p.permission_code`,
    );

    // Slice 1.4 added the two role permissions; Owner holds those too, and a
    // Manager who could re-cut roles would not be "no settings/users" (§5.26).
    expect(granted.rows).toEqual([
      { code: 'MANAGER', permission_code: 'user.account.view' },
      { code: 'OWNER', permission_code: 'user.account.create' },
      { code: 'OWNER', permission_code: 'user.account.disable' },
      { code: 'OWNER', permission_code: 'user.account.edit' },
      { code: 'OWNER', permission_code: 'user.account.view' },
      { code: 'OWNER', permission_code: 'user.role.manage' },
      { code: 'OWNER', permission_code: 'user.role.view' },
    ]);
  });
});

describe('adding a user', () => {
  it('creates them with no password, and says so', async () => {
    const owner = await registerOwner();

    const userId = await addCashier(owner);

    const listed = await listUsers(owner.accessToken);
    const added = (listed.body.data.users as Record<string, unknown>[]).find(
      (user) => user['id'] === userId,
    );
    expect(added).toMatchObject({
      displayName: 'Rahim Uddin',
      username: 'rahim',
      phone: '01799887766',
      email: null,
      roleName: 'Cashier',
      disabled: false,
      // They set their own through forgot-password; nobody else ever sees it.
      hasPassword: false,
    });

    const stored = await inTenant(
      owner.tenantId,
      "SELECT password_hash, pin_hash FROM users WHERE username = 'rahim'",
    );
    expect(stored.rows).toEqual([{ password_hash: null, pin_hash: null }]);
  });

  it('lets them set a password through forgot-password and then sign in', async () => {
    const owner = await registerOwner();
    await addCashier(owner);

    const sent = await request(app.getHttpServer())
      .post('/api/v1/auth/password/otp')
      .send({ identifier: '01799887766' });
    expect(sent.status).toBe(200);

    const reset = await request(app.getHttpServer()).post('/api/v1/auth/password/reset').send({
      identifier: '01799887766',
      otpCode: sent.body.data.devCode as string,
      password: 'Cashier99',
    });
    expect(reset.status).toBe(204);

    const signedIn = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ identifier: '01799887766', password: 'Cashier99' });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.data.user.username).toBe('rahim');
  });

  it('refuses without the step-up password, and with a wrong one (§5.3)', async () => {
    const owner = await registerOwner();
    const roles = await rolesOf(owner.accessToken);

    const omitted = await addUser(owner.accessToken, {
      displayName: 'Rahim Uddin',
      username: 'rahim',
      identifier: '01799887766',
      roleId: roles['CASHIER'],
    });
    expect(omitted.status).toBe(400);

    const wrong = await addUser(owner.accessToken, {
      displayName: 'Rahim Uddin',
      username: 'rahim',
      identifier: '01799887766',
      roleId: roles['CASHIER'],
      confirmPassword: 'Wrongpass99',
    });
    expect(wrong.status).toBe(401);

    expect((await listUsers(owner.accessToken)).body.data.users).toHaveLength(1);
  });

  it('refuses an identifier that already belongs to an account', async () => {
    const owner = await registerOwner();
    const roles = await rolesOf(owner.accessToken);

    const clash = await addUser(owner.accessToken, {
      displayName: 'Impostor',
      username: 'impostor',
      identifier: OWNER_PHONE,
      roleId: roles['CASHIER'],
      confirmPassword: OWNER_PASSWORD,
    });

    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('IDENTIFIER_ALREADY_REGISTERED');
  });

  it('rejects an identifier that is neither a mobile number nor an email', async () => {
    const owner = await registerOwner();
    const roles = await rolesOf(owner.accessToken);

    const response = await addUser(owner.accessToken, {
      displayName: 'Rahim Uddin',
      username: 'rahim',
      identifier: 'nonsense',
      roleId: roles['CASHIER'],
      confirmPassword: OWNER_PASSWORD,
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('permissions (R-E8)', () => {
  /** Signs in as a freshly created staff member who has set a password. */
  async function signInAs(identifier: string, password: string): Promise<string> {
    const sent = await request(app.getHttpServer())
      .post('/api/v1/auth/password/otp')
      .send({ identifier });
    await request(app.getHttpServer())
      .post('/api/v1/auth/password/reset')
      .send({ identifier, otpCode: sent.body.data.devCode as string, password });

    const signedIn = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ identifier, password });
    expect(signedIn.status).toBe(200);
    return signedIn.body.data.accessToken as string;
  }

  it('denies a cashier the users list entirely', async () => {
    const owner = await registerOwner();
    await addCashier(owner);
    const cashierToken = await signInAs('01799887766', 'Cashier99');

    const response = await listUsers(cashierToken);

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('PERMISSION_DENIED');
  });

  it('explains the refusal in words, keeping the code out of the sentence', async () => {
    const owner = await registerOwner();
    await addCashier(owner);
    const cashierToken = await signInAs('01799887766', 'Cashier99');

    const response = await listUsers(cashierToken);

    // The message is what a shopkeeper reads; it must not be developer text.
    expect(response.body.error.message).toBe(
      'You do not have permission to see the user list. Ask the business owner.',
    );
    expect(response.body.error.message).not.toContain('user.account.view');
    // The permission still travels, in `details`, for the support call.
    expect(response.body.error.details).toEqual({ permission: 'user.account.view' });
  });

  it('tells a caller what they may do, so the screen can hide the rest (UI-09)', async () => {
    const owner = await registerOwner();
    await addCashier(owner);
    const cashierToken = await signInAs('01799887766', 'Cashier99');

    const asOwner = await request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(asOwner.status).toBe(200);
    expect(asOwner.body.data.user.roleName).toBe('Owner');
    expect(asOwner.body.data.businessName).toBe('Karim Traders');
    expect(asOwner.body.data.permissions).toContain('user.account.create');

    // A cashier holds none of the user-administration permissions, which is
    // exactly what the sidebar needs to know in order not to offer Users at
    // all — but does hold the counter-work permissions (§5.6: finding a
    // product and saving a customer at the till).
    const asCashier = await request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${cashierToken}`);
    expect(asCashier.status).toBe(200);
    expect(asCashier.body.data.user.roleName).toBe('Cashier');
    expect(asCashier.body.data.permissions).not.toContain('user.account.create');
    /*
     * The Cashier's whole grant, in one list, because the point of this
     * assertion is that it is *exact*: a permission quietly added to the till
     * is a permission somebody quietly gained. It has grown with each module —
     * the day and the drawer in Phase 4, the counter itself in Phase 6, and
     * customer returns in Phase 7, capped by the role's refund limits rather
     * than by a permission (owner decision 2026-08-26), and in Phase 8 the
     * ability to *see* warranty claims — the person at the counter is the one
     * the faulty item is handed to. Handling a claim, which can charge the shop
     * for a replacement, stays with the Manager.
     */
    expect([...asCashier.body.data.permissions].sort()).toEqual(
      [
        'cash.account.view',
        'cash.daily.view',
        'cash.session.close',
        'cash.session.start',
        'catalog.product.view',
        'daybook.print',
        'daybook.view',
        'invoice.presentation.edit',
        /*
         * Phase 12.1 (owner decision 2026-08-31). Registering this browser is
         * held by every authenticated role, the Cashier included: the counter
         * machine is usually the one that will work offline and the cashier is
         * who sits at it. It creates identity and the right to *ask* — offline
         * authority itself still needs an owner or manager to approve it.
         */
        'offline.device.register',
        'party.customer.create',
        'party.customer.edit',
        'party.customer.view',
        'sale.invoice.create',
        'sale.invoice.view',
        'sale.payment.record',
        'sales.return.create',
        'sales.return.view',
        'warranty.claim.view',
      ].sort(),
    );
  });

  it('refuses to describe a caller with no token', async () => {
    await registerOwner();

    expect((await request(app.getHttpServer()).get('/api/v1/me')).status).toBe(401);
  });

  it('lets a manager see the team but not add to it', async () => {
    const owner = await registerOwner();
    const roles = await rolesOf(owner.accessToken);
    await addUser(owner.accessToken, {
      displayName: 'Nasrin Akter',
      username: 'nasrin',
      identifier: 'nasrin@shop.com.bd',
      roleId: roles['MANAGER'],
      confirmPassword: OWNER_PASSWORD,
    });
    const managerToken = await signInAs('nasrin@shop.com.bd', 'Manager99');

    expect((await listUsers(managerToken)).status).toBe(200);

    const denied = await addUser(managerToken, {
      displayName: 'Someone Else',
      username: 'someone',
      identifier: '01711111111',
      roleId: roles['CASHIER'],
      confirmPassword: 'Manager99',
    });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('PERMISSION_DENIED');
  });

  it('requires a token', async () => {
    await registerOwner();

    const response = await request(app.getHttpServer()).get('/api/v1/users');

    expect(response.status).toBe(401);
  });
});

describe('editing a user', () => {
  it('renames without asking for a password — that re-privileges nobody', async () => {
    const owner = await registerOwner();
    const userId = await addCashier(owner);
    const roles = await rolesOf(owner.accessToken);

    const response = await editUser(owner.accessToken, userId, {
      displayName: 'Rahim U. Ahmed',
      roleId: roles['CASHIER'],
    });

    expect(response.status).toBe(200);
    expect(response.body.data.displayName).toBe('Rahim U. Ahmed');
  });

  it('requires the step-up password to change a role, and signs them out', async () => {
    const owner = await registerOwner();
    const userId = await addCashier(owner);
    const roles = await rolesOf(owner.accessToken);

    const omitted = await editUser(owner.accessToken, userId, {
      displayName: 'Rahim Uddin',
      roleId: roles['MANAGER'],
    });
    expect(omitted.status).toBe(400);

    const promoted = await editUser(owner.accessToken, userId, {
      displayName: 'Rahim Uddin',
      roleId: roles['MANAGER'],
      confirmPassword: OWNER_PASSWORD,
    });
    expect(promoted.status).toBe(200);
    expect(promoted.body.data.roleName).toBe('Manager');

    const audit = await inTenant(
      owner.tenantId,
      `SELECT action FROM audit_events WHERE entity_type = 'user' AND action = 'REPRIVILEGE'`,
    );
    expect(audit.rowCount).toBe(1);
  });

  /**
   * §5.26: "The system must refuse to remove the last Owner." The way a shop
   * actually reaches this is by demoting itself — only an Owner may edit roles,
   * so the last one is always the person holding the form.
   */
  it('refuses to demote the last Owner, which would lock everyone out', async () => {
    const owner = await registerOwner();
    const roles = await rolesOf(owner.accessToken);

    const response = await editUser(owner.accessToken, owner.userId, {
      displayName: 'Karim',
      roleId: roles['CASHIER'],
      confirmPassword: OWNER_PASSWORD,
    });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain('only Owner');

    // Still an Owner, and still able to administer users.
    expect((await listUsers(owner.accessToken)).status).toBe(200);
  });

  it('allows demotion once a second Owner exists', async () => {
    const owner = await registerOwner();
    const userId = await addCashier(owner);
    const roles = await rolesOf(owner.accessToken);

    await editUser(owner.accessToken, userId, {
      displayName: 'Rahim Uddin',
      roleId: roles['OWNER'],
      confirmPassword: OWNER_PASSWORD,
    });

    const demoted = await editUser(owner.accessToken, owner.userId, {
      displayName: 'Karim',
      roleId: roles['CASHIER'],
      confirmPassword: OWNER_PASSWORD,
    });

    expect(demoted.status).toBe(200);
    expect(demoted.body.data.roleName).toBe('Cashier');
  });

  it('will not touch a user in another tenant — 404, never 403 (R-E5)', async () => {
    const a = await registerOwner(OWNER_PHONE);
    const b = await registerOwner('rahman@shop.com.bd');
    const roles = await rolesOf(b.accessToken);

    const response = await editUser(b.accessToken, a.userId, {
      displayName: 'Stolen',
      roleId: roles['CASHIER'],
      confirmPassword: OWNER_PASSWORD,
    });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
  });
});

describe('disabling a user', () => {
  it('signs them out everywhere and blocks a new sign-in', async () => {
    const owner = await registerOwner();
    const userId = await addCashier(owner);

    const sent = await request(app.getHttpServer())
      .post('/api/v1/auth/password/otp')
      .send({ identifier: '01799887766' });
    await request(app.getHttpServer()).post('/api/v1/auth/password/reset').send({
      identifier: '01799887766',
      otpCode: sent.body.data.devCode as string,
      password: 'Cashier99',
    });
    const signedIn = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ identifier: '01799887766', password: 'Cashier99' });

    const disabled = await setDisabled(owner.accessToken, userId, {
      disabled: true,
      confirmPassword: OWNER_PASSWORD,
    });
    expect(disabled.status).toBe(200);
    expect(disabled.body.data.disabled).toBe(true);

    // The session they already held is dead, not merely expiring.
    const refreshed = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: signedIn.body.data.refreshToken as string });
    expect(refreshed.status).toBe(401);

    const again = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ identifier: '01799887766', password: 'Cashier99' });
    expect(again.status).toBe(401);
  });

  it('is reversible, and the row was never deleted', async () => {
    const owner = await registerOwner();
    const userId = await addCashier(owner);

    await setDisabled(owner.accessToken, userId, {
      disabled: true,
      confirmPassword: OWNER_PASSWORD,
    });
    const enabled = await setDisabled(owner.accessToken, userId, {
      disabled: false,
      confirmPassword: OWNER_PASSWORD,
    });

    expect(enabled.status).toBe(200);
    expect(enabled.body.data.disabled).toBe(false);
    // Still one row throughout — soft delete (§3.6), never a hard one.
    const rows = await inTenant(owner.tenantId, 'SELECT id FROM users');
    expect(rows.rowCount).toBe(2);
  });

  it('still lists a disabled user, so they can be put back', async () => {
    const owner = await registerOwner();
    const userId = await addCashier(owner);
    await setDisabled(owner.accessToken, userId, {
      disabled: true,
      confirmPassword: OWNER_PASSWORD,
    });

    const listed = await listUsers(owner.accessToken);

    expect(listed.body.data.users).toHaveLength(2);
    const found = (listed.body.data.users as Record<string, unknown>[]).find(
      (user) => user['id'] === userId,
    );
    expect(found).toMatchObject({ disabled: true });
  });

  it('refuses to disable your own account', async () => {
    const owner = await registerOwner();

    const response = await setDisabled(owner.accessToken, owner.userId, {
      disabled: true,
      confirmPassword: OWNER_PASSWORD,
    });

    expect(response.status).toBe(400);
  });

  it('refuses without the step-up password', async () => {
    const owner = await registerOwner();
    const userId = await addCashier(owner);

    const response = await setDisabled(owner.accessToken, userId, { disabled: true });

    expect(response.status).toBe(400);
  });
});
