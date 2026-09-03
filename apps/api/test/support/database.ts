import { join } from 'node:path';

import { createPool, runMigrations } from '@sher/adapter-postgres';
import { WALK_IN_PARTY_NAME } from '@sher/core-contracts';
import { SystemClock, Ulid } from '@sher/shared-utils';
import type pg from 'pg';

const clock = new SystemClock();

const TENANT_SCOPED_TABLES = [
  // Phase 11 reconciliation (migration 0039). First, because matches reference
  // statement lines, which reference the file, which references the account.
  'reconciliation_matches',
  'statement_lines',
  'bank_statement_files',
  'account_reconciliations',
  // Phase 4 money (migration 0016). Before the journal tables and `tenants`,
  // like everything else here; movements and closes precede the sessions and
  // accounts they reference.
  'cash_movements',
  'cash_session_closes',
  'cash_sessions',
  'account_openings',
  'accounts',
  'cost_adjustments',
  'lot_consumptions',
  'journal_lines',
  'journal_entries',
  'stock_movements',
  'product_cost_state',
  'inventory_lots',
  'stock_openings',
  'inventory_locations',
  'notes',
  'settings',
  // Phase 2 parties (path 2.3). Before `tenants`, and party_roles before
  // parties, which it references.
  'party_roles',
  'parties',
  'customer_groups',
  // Phase 2 catalog. Listed before `tenants` like everything else here; the
  // TRUNCATE is CASCADE, so the self-reference on `categories` is fine.
  'product_unit_conversions',
  'products',
  'categories',
  'brands',
  'units',
  // Signup tables. Neither is RLS-scoped — an OTP is verified and an identifier
  // is resolved before a tenant exists — but both must still be truncated
  // between tests, and user_identifiers references users.
  'refresh_tokens',
  'user_identifiers',
  'otp_codes',
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

/**
 * Reads as the database owner, bypassing RLS.
 *
 * Needed only for **platform** rows — an audit event with a null tenant belongs
 * to no tenant, so no tenant's policy can see it, which is the intended design
 * (§5.3 signup auditing). Never use this to assert tenant-scoped data: doing so
 * would prove the row exists while hiding whether RLS lets the right tenant
 * reach it, which is the thing worth testing.
 */
export async function asPlatform<T>(work: (pool: pg.Pool) => Promise<T>): Promise<T> {
  const adminUrl =
    process.env['ADMIN_DATABASE_URL'] ?? 'postgres://postgres:dev@localhost:5432/sher_test';
  const admin = createPool(adminUrl);
  try {
    return await work(admin);
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

/**
 * D-02's walk-in customer, which a real business is provisioned with and
 * `seedTenant` is not (owner request 2026-09-03).
 *
 * `seedTenant` writes the tenant row directly rather than running registration,
 * which is right — a products test should not have to sign up — but it means the
 * shop it creates is missing the one party every fully paid counter sale points
 * at. Without this, a guest sale fails with "This shop has no walk-in customer",
 * which is a correct refusal against a shop that genuinely cannot exist through
 * the real signup path, and a confusing one to meet in a test.
 *
 * Written as SQL for the same reason `seedTenant` is: this is provisioning, not
 * business activity. Nothing here is a balance, a movement or a journal line —
 * those are always created by calling the application's own endpoints.
 */
export async function seedWalkInCustomer(pool: pg.Pool, tenant: SeededTenant): Promise<string> {
  const partyId = Ulid.generate(clock);
  const now = clock.now();

  await asTenant(pool, tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO parties (id, tenant_id, name, phone, address, guardian_name, nid, email, notes,
                            customer_group_id, credit_limit_minor, status, is_system_reserved,
                            created_at, updated_at, created_by, updated_by, version)
       VALUES ($1, $2, $3, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'ACTIVE', TRUE,
               $4, $4, $5, $5, 1)`,
      [partyId, tenant.tenantId, WALK_IN_PARTY_NAME, now, tenant.userId],
    );
    await client.query(
      `INSERT INTO party_roles (id, tenant_id, party_id, role, created_at, updated_at,
                                created_by, updated_by, version)
       VALUES ($1, $2, $3, 'CUSTOMER', $4, $4, $5, $5, 1)`,
      [Ulid.generate(clock), tenant.tenantId, partyId, now, tenant.userId],
    );
  });

  return partyId;
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
