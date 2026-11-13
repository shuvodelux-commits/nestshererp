/* MOD-008 P5D: disposable-only QA identity bootstrap.
 *
 * Uses existing proven backend seedTenant/asTenant/signToken test helpers.
 * Deliberately does NOT sign up a production user, expose a token in logs,
 * alter retained databases or make any purchase/financial posting.
 *
 * Run this single test against the task-owned labelled PG16 at 127.0.0.1:55681.
 * The runner then sources the chmod 0600 /tmp file inside its own isolated
 * process environment. Never commit that file or echo its contents.
 */
import { writeFile } from 'node:fs/promises';
import { SystemClock, Ulid } from '@sher/shared-utils';
import { Permission } from '@sher/core-contracts';
import { expect, it } from 'vitest';

import { signToken, TEST_JWT_SECRET } from './support/auth';
import { asTenant, prepareTestDatabase, resetDatabase, seedTenant, testPool } from './support/database';
import type { SeededTenant } from './support/database';

const output = '/tmp/hisabiq-p5d-501-disposable.env';
const clock = new SystemClock();

function assertDisposableEnvironment(): void {
  expect(process.env.HISABIQ_P5D_DISPOSABLE_ACK).toBe('isolated-pg16-only');
  expect(process.env.DATABASE_URL).toBe(
    'postgres://sher_app:sher_app_test@127.0.0.1:55681/sher_test',
  );
  expect(process.env.ADMIN_DATABASE_URL).toBe(
    'postgres://postgres:dev@127.0.0.1:55681/sher_test',
  );
  expect(process.env.JWT_SECRET).toBe(TEST_JWT_SECRET);
}

async function addNoCostUser(pool: ReturnType<typeof testPool>, tenant: SeededTenant) {
  const roleId = Ulid.generate(clock);
  const userId = Ulid.generate(clock);
  const now = clock.now();
  await asTenant(pool, tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO roles
         (id, tenant_id, code, name, is_system, created_at, updated_at, created_by, updated_by, version)
       VALUES ($1, $2, 'P5D_NO_COST', 'P5D test restricted', FALSE, $3, $3, $4, $4, 1)`,
      [roleId, tenant.tenantId, now, tenant.userId],
    );
    await client.query(
      `INSERT INTO users
         (id, tenant_id, role_id, email, display_name, created_at, updated_at, created_by, updated_by, version)
       VALUES ($1, $2, $3, $4, 'P5D restricted test', $5, $5, $6, $6, 1)`,
      [userId, tenant.tenantId, roleId, 'restricted-p5d@example.invalid', now, tenant.userId],
    );
    for (const permission of [Permission.PRODUCT_VIEW, Permission.SUPPLIER_VIEW]) {
      await client.query(
        `INSERT INTO role_permissions
           (id, tenant_id, role_id, permission_code, created_at, updated_at, created_by, updated_by, version)
         VALUES ($1, $2, $3, $4, $5, $5, $6, $6, 1)`,
        [Ulid.generate(clock), tenant.tenantId, roleId, permission, now, tenant.userId],
      );
    }
  });
  return { ...tenant, roleId, userId };
}

it('provisions two real disposable tenants and a cost-redacted same-tenant user', async () => {
  assertDisposableEnvironment();
  const pool = testPool();
  try {
    await prepareTestDatabase();
    await resetDatabase(pool);
    const all = [
      Permission.PURCHASE_CREATE, Permission.PRODUCT_VIEW,
      Permission.PRODUCT_CREATE, Permission.PRODUCT_EDIT,
      Permission.PRODUCT_DEACTIVATE, Permission.UNIT_MANAGE,
      Permission.SUPPLIER_VIEW, Permission.SUPPLIER_CREATE,
      Permission.CUSTOMER_VIEW, Permission.CUSTOMER_CREATE,
      Permission.COST_VIEW,
    ];
    const a = await seedTenant(pool, { name: 'P5D isolated shop A', permissions: all });
    const b = await seedTenant(pool, { name: 'P5D isolated shop B', permissions: all });
    const restricted = await addNoCostUser(pool, a);
    expect(restricted.userId).not.toBe(a.userId);
    const contents = [
      'HISABIQ_P5D_TENANT_A=' + a.tenantId,
      'HISABIQ_P5D_USER_A=' + a.userId,
      'HISABIQ_P5D_JWT_A=' + signToken(a, TEST_JWT_SECRET),
      'HISABIQ_P5D_TENANT_B=' + b.tenantId,
      'HISABIQ_P5D_USER_B=' + b.userId,
      'HISABIQ_P5D_JWT_B=' + signToken(b, TEST_JWT_SECRET),
      'HISABIQ_P5D_REDACTED_JWT_A=' + signToken(restricted, TEST_JWT_SECRET),
    ].join('\n') + '\n';
    await writeFile(output, contents, { mode: 0o600, flag: 'wx' });
    expect((await asTenant(pool, a.tenantId, client =>
      client.query('SELECT count(*)::int AS total FROM users'))).rows[0]?.total).toBe(2);
    console.log('P5D signed disposable QA identities stored in protected task-only file');
  } finally {
    await pool.end();
  }
}, 120_000);
