import { createPool } from '@sher/adapter-postgres';
import { SEED_ROLES } from '@sher/core-contracts';
import { SystemClock, Ulid } from '@sher/shared-utils';

import { loadConfig } from './config';

/**
 * `pnpm db:backfill`. Gives tenants created before slice 1.3 the seed roles and
 * permissions that slice now ships with every new one (§5.26).
 *
 * **Why this is a script and not a migration.** The role set and its permissions
 * live in `SEED_ROLES`, and restating them in SQL would leave two definitions to
 * drift apart. More importantly, R-C1 requires primary keys to be ULIDs
 * generated in application code — a migration inventing ids in SQL would break
 * the rule the whole schema is built on.
 *
 * **Idempotent.** It adds only what is missing, so running it twice changes
 * nothing the second time. Run it once after deploying slice 1.3; a tenant
 * created afterwards already has everything and is skipped.
 *
 * **Run it with the same credentials as `db:migrate`, not the application's.**
 * It has to read every tenant to find the ones that are short, and the
 * application role cannot — RLS is FORCEd, and with no `app.tenant_id` set it
 * correctly sees nothing at all. That is the isolation working, not an
 * obstacle: a repair that spans tenants is an administrative act and belongs
 * with migrations, which already run as the owner.
 *
 * This is a one-off repair, not a fixture: it exists because a released change
 * left existing tenants short, and deleting their data instead was never an
 * option.
 */
const clock = new SystemClock();

interface Backfilled {
  readonly tenants: number;
  readonly roles: number;
  readonly permissions: number;
}

async function main(): Promise<void> {
  const pool = createPool(loadConfig().databaseUrl);
  try {
    const result = await backfill(pool);
    process.stdout.write(
      `Backfilled ${String(result.roles)} role(s) and ${String(result.permissions)} ` +
        `permission(s) across ${String(result.tenants)} tenant(s).\n`,
    );
  } finally {
    await pool.end();
  }
}

async function backfill(pool: ReturnType<typeof createPool>): Promise<Backfilled> {
  const client = await pool.connect();
  let roles = 0;
  let permissions = 0;
  let tenants = 0;

  try {
    await client.query('BEGIN');

    const { rows } = await client.query<{ id: string; created_by: string }>(
      'SELECT id, created_by FROM tenants WHERE deleted_at IS NULL ORDER BY created_at',
    );

    if (rows.length === 0) {
      // Either there genuinely are no tenants, or this is running as the
      // application role, which RLS correctly shows nothing. Saying so beats
      // reporting a cheerful "0 backfilled" that looks like success.
      process.stderr.write(
        'No tenants were visible. Run this with the same credentials as db:migrate — ' +
          'the application role cannot read across tenants, by design.\n',
      );
    }

    for (const tenant of rows) {
      const tenantId = tenant.id.trim();
      let touched = false;
      for (const seed of SEED_ROLES) {
        const roleId = await ensureRole(client, tenantId, tenant.created_by.trim(), seed.code, seed.name);
        if (roleId.created) {
          roles += 1;
          touched = true;
        }
        for (const permission of seed.permissions) {
          const granted = await ensurePermission(
            client,
            tenantId,
            tenant.created_by.trim(),
            roleId.id,
            permission,
          );
          if (granted) {
            permissions += 1;
            touched = true;
          }
        }
      }
      if (touched) tenants += 1;
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return { tenants, roles, permissions };
}

async function ensureRole(
  client: { query: QueryFn },
  tenantId: string,
  actorId: string,
  code: string,
  name: string,
): Promise<{ id: string; created: boolean }> {
  const existing = await client.query<{ id: string }>(
    'SELECT id FROM roles WHERE tenant_id = $1 AND code = $2',
    [tenantId, code],
  );
  const found = existing.rows[0];
  if (found !== undefined) return { id: found.id.trim(), created: false };

  const id = Ulid.generate(clock);
  const now = clock.now();
  await client.query(
    `INSERT INTO roles (id, tenant_id, code, name, is_system, created_at, updated_at, created_by, updated_by, version)
     VALUES ($1, $2, $3, $4, TRUE, $5, $5, $6, $6, 1)`,
    [id, tenantId, code, name, now, actorId],
  );
  return { id, created: true };
}

async function ensurePermission(
  client: { query: QueryFn },
  tenantId: string,
  actorId: string,
  roleId: string,
  permissionCode: string,
): Promise<boolean> {
  const existing = await client.query<{ id: string }>(
    'SELECT id FROM role_permissions WHERE tenant_id = $1 AND role_id = $2 AND permission_code = $3',
    [tenantId, roleId, permissionCode],
  );
  if (existing.rows[0] !== undefined) return false;

  const now = clock.now();
  await client.query(
    `INSERT INTO role_permissions (id, tenant_id, role_id, permission_code, created_at, updated_at, created_by, updated_by, version)
     VALUES ($1, $2, $3, $4, $5, $5, $6, $6, 1)`,
    [Ulid.generate(clock), tenantId, roleId, permissionCode, now, actorId],
  );
  return true;
}

type QueryFn = <T>(
  sql: string,
  values?: readonly unknown[],
) => Promise<{ rows: T[] }>;

void main();
