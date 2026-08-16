import { join } from 'node:path';

import { createPool, runMigrations } from '@sher/adapter-postgres';
import { SystemClock, Ulid } from '@sher/shared-utils';
import type pg from 'pg';

const clock = new SystemClock();

const TENANT_SCOPED_TABLES = [
  'notes',
  'idempotency_keys',
  'outbox',
  'audit_events',
  'numbering_counters',
  'period_locks',
  'role_permissions',
  'users',
  'roles',
  'tenants',
];

export function testPool(): pg.Pool {
  const url = process.env['DATABASE_URL'];
  if (url === undefined) throw new Error('DATABASE_URL is not set for tests');
  return createPool(url);
}

/**
 * Creates the schema and the application role, as the database owner.
 *
 * The application must NOT connect as a superuser: PostgreSQL lets a superuser
 * bypass row level security entirely, so RLS would be silently inert and the
 * only tenant isolation left would be the WHERE clauses. `install.sh` and the
 * SaaS provisioning must create this same unprivileged role in production
 * (§6.5) — the app's DATABASE_URL points at it, never at `postgres`.
 */
export async function prepareTestDatabase(): Promise<void> {
  const adminUrl =
    process.env['ADMIN_DATABASE_URL'] ?? 'postgres://postgres:dev@localhost:5432/sher_test';
  const admin = createPool(adminUrl);

  try {
    await admin.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sher_app') THEN
          CREATE ROLE sher_app LOGIN PASSWORD 'sher_app_test';
        END IF;
      END
      $$;
    `);

    await runMigrations(admin, join(__dirname, '../../../../migrations'));

    await admin.query('GRANT USAGE ON SCHEMA public TO sher_app');
    await admin.query(
      'GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public TO sher_app',
    );
  } finally {
    await admin.end();
  }
}

/** TRUNCATE is an owner operation and is not subject to RLS. */
export async function resetDatabase(pool: pg.Pool): Promise<void> {
  await pool.query(`TRUNCATE ${TENANT_SCOPED_TABLES.join(', ')} CASCADE`);
}

/**
 * Runs statements with `app.tenant_id` set, which is what RLS reads. Seeding
 * has to go through the same door as the application — there is no bypass, and
 * that is the point of FORCE ROW LEVEL SECURITY.
 */
export async function asTenant<T>(
  pool: pg.Pool,
  tenantId: string,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export interface SeededTenant {
  readonly tenantId: string;
  readonly userId: string;
  readonly roleId: string;
  readonly timezone: string;
}

export async function seedTenant(
  pool: pg.Pool,
  options: { name: string; permissions: readonly string[]; timezone?: string },
): Promise<SeededTenant> {
  const tenantId = Ulid.generate(clock);
  const roleId = Ulid.generate(clock);
  const userId = Ulid.generate(clock);
  const timezone = options.timezone ?? 'Asia/Dhaka';
  const now = clock.now();

  await asTenant(pool, tenantId, async (client) => {
    await client.query(
      `INSERT INTO tenants (id, name, timezone, created_at, updated_at, created_by, updated_by, version)
       VALUES ($1, $2, $3, $4, $4, $5, $5, 1)`,
      [tenantId, options.name, timezone, now, userId],
    );
    await client.query(
      `INSERT INTO roles (id, tenant_id, code, name, is_system, created_at, updated_at, created_by, updated_by, version)
       VALUES ($1, $2, 'OWNER', 'Owner', TRUE, $3, $3, $4, $4, 1)`,
      [roleId, tenantId, now, userId],
    );
    await client.query(
      `INSERT INTO users (id, tenant_id, role_id, email, display_name, created_at, updated_at, created_by, updated_by, version)
       VALUES ($1, $2, $3, $4, 'Test User', $5, $5, $1, $1, 1)`,
      [userId, tenantId, roleId, `owner@${tenantId}.test`, now],
    );
    for (const code of options.permissions) {
      await client.query(
        `INSERT INTO role_permissions (id, tenant_id, role_id, permission_code, created_at, updated_at, created_by, updated_by, version)
         VALUES ($1, $2, $3, $4, $5, $5, $6, $6, 1)`,
        [Ulid.generate(clock), tenantId, roleId, code, now, userId],
      );
    }
  });

  return { tenantId, userId, roleId, timezone };
}

export async function closePeriod(
  pool: pg.Pool,
  tenant: SeededTenant,
  year: number,
  month: number,
): Promise<void> {
  const now = clock.now();
  await asTenant(pool, tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO period_locks (id, tenant_id, period_year, period_month, status, created_at, updated_at, created_by, updated_by, version)
       VALUES ($1, $2, $3, $4, 'CLOSED', $5, $5, $6, $6, 1)`,
      [Ulid.generate(clock), tenant.tenantId, year, month, now, tenant.userId],
    );
  });
}

export function todayIn(timezone: string): string {
  return clock.businessDate(timezone);
}
