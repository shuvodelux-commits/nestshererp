/*
 * Coverage claims, read by `pnpm test:inventory` (owner request 2026-09-03).
 *
 * These are what this file is answerable for in the test matrix. A claim naming
 * something the inventory no longer contains fails the scan, so a screen renamed
 * out from under a test cannot leave the coverage report quietly overstating itself.
 *
 * @covers endpoint:DELETE /api/v1/roles/:id
 * @covers endpoint:GET /api/v1/roles
 * @covers endpoint:PATCH /api/v1/roles/:id
 * @covers endpoint:POST /api/v1/auth/registration
 * @covers endpoint:POST /api/v1/auth/registration/otp
 * @covers endpoint:POST /api/v1/roles
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
 * Slice 1.4 — roles and what they may do (§5.26). Expected values written
 * before the code.
 *
 * The rule that matters most here is the one that cannot be undone by support:
 * "Owner — cannot be deleted or de-privileged." A shop that could unpick its own
 * Owner would lock itself out of its business permanently.
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

function listRoles(token: string): request.Test {
  return request(app.getHttpServer()).get('/api/v1/roles').set('Authorization', `Bearer ${token}`);
}

function addRole(token: string, body: Record<string, unknown>): request.Test {
  return request(app.getHttpServer())
    .post('/api/v1/roles')
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}

function editRole(token: string, id: string, body: Record<string, unknown>): request.Test {
  return request(app.getHttpServer())
    .patch(`/api/v1/roles/${id}`)
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}

function removeRole(token: string, id: string, body: Record<string, unknown>): request.Test {
  return request(app.getHttpServer())
    .delete(`/api/v1/roles/${id}`)
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}

interface Role {
  id: string;
  code: string;
  name: string;
  isSystem: boolean;
  locked: boolean;
  permissions: string[];
  userCount: number;
}

async function rolesByCode(token: string): Promise<Record<string, Role>> {
  const listed = await listRoles(token);
  const byCode: Record<string, Role> = {};
  for (const role of listed.body.data.roles as Role[]) byCode[role.code] = role;
  return byCode;
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

describe('listing roles', () => {
  it('returns the six seeded roles with a catalogue to label them', async () => {
    const owner = await registerOwner();

    const listed = await listRoles(owner.accessToken);

    expect(listed.status).toBe(200);
    expect(listed.body.data.roles).toHaveLength(6);
    // The screen labels tick-boxes from this; it never hardcodes a code.
    const codes = (listed.body.data.catalogue as { code: string }[]).map((entry) => entry.code);
    expect(codes).toContain('user.account.view');
    expect(codes).toContain('user.role.manage');
  });

  it('says how many people hold each role', async () => {
    const owner = await registerOwner();

    const roles = await rolesByCode(owner.accessToken);

    expect(roles['OWNER']?.userCount).toBe(1);
    expect(roles['CASHIER']?.userCount).toBe(0);
  });

  it('marks Owner as locked and every seeded role as built in', async () => {
    const owner = await registerOwner();

    const roles = await rolesByCode(owner.accessToken);

    expect(roles['OWNER']).toMatchObject({ locked: true, isSystem: true });
    expect(roles['CASHIER']).toMatchObject({ locked: false, isSystem: true });
  });

  it('requires a token', async () => {
    await registerOwner();

    expect((await request(app.getHttpServer()).get('/api/v1/roles')).status).toBe(401);
  });
});

describe('changing what a role may do', () => {
  it('grants a permission, and it works on the very next request', async () => {
    const owner = await registerOwner();
    const roles = await rolesByCode(owner.accessToken);
    const cashier = roles['CASHIER']!;

    const saved = await editRole(owner.accessToken, cashier.id, {
      name: 'Cashier',
      permissions: ['user.account.view'],
      confirmPassword: OWNER_PASSWORD,
    });

    expect(saved.status).toBe(200);
    expect(saved.body.data.permissions).toEqual(['user.account.view']);

    const stored = await inTenant(
      owner.tenantId,
      `SELECT permission_code FROM role_permissions
        WHERE role_id = '${cashier.id}' AND deleted_at IS NULL`,
    );
    expect(stored.rows).toEqual([{ permission_code: 'user.account.view' }]);
  });

  it('revokes one by leaving it out', async () => {
    const owner = await registerOwner();
    const roles = await rolesByCode(owner.accessToken);
    const manager = roles['MANAGER']!;
    // Whatever the seed grants this role, it starts with the one under test.
    expect(manager.permissions).toContain('user.account.view');

    const saved = await editRole(owner.accessToken, manager.id, {
      name: 'Manager',
      permissions: [],
      confirmPassword: OWNER_PASSWORD,
    });

    expect(saved.status).toBe(200);
    expect(saved.body.data.permissions).toEqual([]);
  });

  it('can grant back what was revoked, without duplicating the row', async () => {
    const owner = await registerOwner();
    const roles = await rolesByCode(owner.accessToken);
    const manager = roles['MANAGER']!;

    await editRole(owner.accessToken, manager.id, {
      name: 'Manager',
      permissions: [],
      confirmPassword: OWNER_PASSWORD,
    });
    const regranted = await editRole(owner.accessToken, manager.id, {
      name: 'Manager',
      permissions: ['user.account.view'],
      confirmPassword: OWNER_PASSWORD,
    });

    expect(regranted.status).toBe(200);
    expect(regranted.body.data.permissions).toEqual(['user.account.view']);

    // Unique on (tenant, role, code): the revoked row was revived, not doubled.
    const rows = await inTenant(
      owner.tenantId,
      `SELECT permission_code FROM role_permissions
        WHERE role_id = '${manager.id}' AND permission_code = 'user.account.view'`,
    );
    expect(rows.rowCount).toBe(1);
  });

  it('renames a role', async () => {
    const owner = await registerOwner();
    const roles = await rolesByCode(owner.accessToken);

    const saved = await editRole(owner.accessToken, roles['VIEWER']!.id, {
      name: 'Read only',
      permissions: [],
      confirmPassword: OWNER_PASSWORD,
    });

    expect(saved.body.data.name).toBe('Read only');
  });

  it('refuses a permission the server does not recognise', async () => {
    const owner = await registerOwner();
    const roles = await rolesByCode(owner.accessToken);

    const response = await editRole(owner.accessToken, roles['CASHIER']!.id, {
      name: 'Cashier',
      permissions: ['finance.everything.always'],
      confirmPassword: OWNER_PASSWORD,
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('refuses without the step-up password, and with a wrong one (§5.3)', async () => {
    const owner = await registerOwner();
    const roles = await rolesByCode(owner.accessToken);
    const cashier = roles['CASHIER']!;

    const omitted = await editRole(owner.accessToken, cashier.id, {
      name: 'Cashier',
      permissions: ['user.account.view'],
    });
    expect(omitted.status).toBe(400);

    const wrong = await editRole(owner.accessToken, cashier.id, {
      name: 'Cashier',
      permissions: ['user.account.view'],
      confirmPassword: 'Wrongpass99',
    });
    expect(wrong.status).toBe(401);

    const unchanged = await rolesByCode(owner.accessToken);
    expect(unchanged['CASHIER']?.permissions).toEqual(cashier.permissions);
  });

  it('records it as a re-privilege, naming what changed', async () => {
    const owner = await registerOwner();
    const roles = await rolesByCode(owner.accessToken);

    await editRole(owner.accessToken, roles['CASHIER']!.id, {
      name: 'Cashier',
      permissions: ['user.account.view'],
      confirmPassword: OWNER_PASSWORD,
    });

    const audit = await inTenant(
      owner.tenantId,
      `SELECT action, after_json FROM audit_events WHERE entity_type = 'role'`,
    );
    expect(audit.rows).toEqual([
      {
        action: 'REPRIVILEGE',
        after_json: { name: 'Cashier', permissions: 'user.account.view' },
      },
    ]);
  });
});

describe('the Owner role cannot be de-privileged (§5.26)', () => {
  it('refuses to remove any of its permissions', async () => {
    const owner = await registerOwner();
    const roles = await rolesByCode(owner.accessToken);

    const response = await editRole(owner.accessToken, roles['OWNER']!.id, {
      name: 'Owner',
      permissions: ['user.account.view'],
      confirmPassword: OWNER_PASSWORD,
    });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain('cannot be reduced');

    // Still whole, so the owner can still administer their own business.
    expect((await listRoles(owner.accessToken)).status).toBe(200);
  });

  it('allows it to be renamed', async () => {
    const owner = await registerOwner();
    const roles = await rolesByCode(owner.accessToken);
    const ownerRole = roles['OWNER']!;

    const saved = await editRole(owner.accessToken, ownerRole.id, {
      name: 'Proprietor',
      permissions: ownerRole.permissions,
      confirmPassword: OWNER_PASSWORD,
    });

    expect(saved.status).toBe(200);
    expect(saved.body.data.name).toBe('Proprietor');
    expect(saved.body.data.permissions).toHaveLength(ownerRole.permissions.length);
  });

  it('refuses to delete it', async () => {
    const owner = await registerOwner();
    const roles = await rolesByCode(owner.accessToken);

    const response = await removeRole(owner.accessToken, roles['OWNER']!.id, {
      confirmPassword: OWNER_PASSWORD,
    });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain('cannot be deleted');
  });
});

describe('adding a role of your own', () => {
  it('creates it with the permissions ticked, ready to assign', async () => {
    const owner = await registerOwner();

    const created = await addRole(owner.accessToken, {
      name: 'Shift Supervisor',
      permissions: ['user.account.view'],
      confirmPassword: OWNER_PASSWORD,
    });

    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      name: 'Shift Supervisor',
      code: 'SHIFT_SUPERVISOR',
      isSystem: false,
      locked: false,
      permissions: ['user.account.view'],
      userCount: 0,
    });

    expect((await listRoles(owner.accessToken)).body.data.roles).toHaveLength(7);
  });

  it('refuses a second role with the same name', async () => {
    const owner = await registerOwner();
    await addRole(owner.accessToken, {
      name: 'Shift Supervisor',
      permissions: [],
      confirmPassword: OWNER_PASSWORD,
    });

    const again = await addRole(owner.accessToken, {
      name: 'shift supervisor',
      permissions: [],
      confirmPassword: OWNER_PASSWORD,
    });

    expect(again.status).toBe(400);
    expect(again.body.error.message).toContain('already exists');
  });

  it('can be assigned to a user like any other role', async () => {
    const owner = await registerOwner();
    const created = await addRole(owner.accessToken, {
      name: 'Shift Supervisor',
      permissions: ['user.account.view'],
      confirmPassword: OWNER_PASSWORD,
    });

    const added = await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        displayName: 'Rahim Uddin',
        username: 'rahim',
        identifier: '01799887766',
        roleId: created.body.data.id as string,
        confirmPassword: OWNER_PASSWORD,
      });

    expect(added.status).toBe(201);
    expect(added.body.data.roleName).toBe('Shift Supervisor');
  });
});

describe('deleting a role', () => {
  it('removes one nobody holds', async () => {
    const owner = await registerOwner();
    const created = await addRole(owner.accessToken, {
      name: 'Shift Supervisor',
      permissions: [],
      confirmPassword: OWNER_PASSWORD,
    });

    const removed = await removeRole(owner.accessToken, created.body.data.id as string, {
      confirmPassword: OWNER_PASSWORD,
    });

    expect(removed.status).toBe(204);
    expect((await listRoles(owner.accessToken)).body.data.roles).toHaveLength(6);
  });

  it('refuses one that people still hold, and says how many', async () => {
    const owner = await registerOwner();
    const created = await addRole(owner.accessToken, {
      name: 'Shift Supervisor',
      permissions: [],
      confirmPassword: OWNER_PASSWORD,
    });
    await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        displayName: 'Rahim Uddin',
        username: 'rahim',
        identifier: '01799887766',
        roleId: created.body.data.id as string,
        confirmPassword: OWNER_PASSWORD,
      });

    const response = await removeRole(owner.accessToken, created.body.data.id as string, {
      confirmPassword: OWNER_PASSWORD,
    });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain('1 person holds');
  });

  it('refuses a role that ships with SherERP', async () => {
    const owner = await registerOwner();
    const roles = await rolesByCode(owner.accessToken);

    const response = await removeRole(owner.accessToken, roles['CASHIER']!.id, {
      confirmPassword: OWNER_PASSWORD,
    });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain('ships with SherERP');
  });
});

describe('tenant isolation (R-E5)', () => {
  it('will not touch a role in another business — 404, never 403', async () => {
    const a = await registerOwner(OWNER_PHONE);
    const b = await registerOwner('rahman@shop.com.bd');
    const rolesOfA = await rolesByCode(a.accessToken);

    const response = await editRole(b.accessToken, rolesOfA['CASHIER']!.id, {
      name: 'Stolen',
      permissions: [],
      confirmPassword: OWNER_PASSWORD,
    });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
  });
});
