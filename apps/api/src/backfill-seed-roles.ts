import { createPool } from '@sher/adapter-postgres';
import {
  SEED_EXPENSE_CATEGORIES,
  SEED_ROLES,
  SEED_UNITS,
  WALK_IN_PARTY_NAME,
} from '@sher/core-contracts';
import { SystemClock, Ulid } from '@sher/shared-utils';

import { loadConfig } from './config';

/**
 * `pnpm db:backfill`. Gives every existing tenant whatever `provisionTenant` now
 * ships with a new one but did not ship when they were created:
 *
 *   - the seed roles and their permissions (slice 1.3, §5.26) — including any
 *     permission code a later module adds to a seed role, which is why this is
 *     re-run after every module that defines one;
 *   - the D-10 units of measure (Phase 2) — a tenant with no units cannot add a
 *     product at all, because a base unit is mandatory (§5.5).
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
  readonly units: number;
  readonly walkIns: number;
  /** Phase 12.4 — short codes given to machines registered before that phase. */
  readonly deviceCodes: number;
}

async function main(): Promise<void> {
  const pool = createPool(loadConfig().databaseUrl);
  try {
    const result = await backfill(pool);
    process.stdout.write(
      `Backfilled ${String(result.roles)} role(s), ${String(result.permissions)} ` +
        `permission(s), ${String(result.units)} unit(s) and ` +
        `${String(result.walkIns)} walk-in customer(s) and ` +
        `${String(result.deviceCodes)} device code(s) across ` +
        `${String(result.tenants)} tenant(s).\n`,
    );
  } finally {
    await pool.end();
  }
}

async function backfill(pool: ReturnType<typeof createPool>): Promise<Backfilled> {
  const client = await pool.connect();
  let roles = 0;
  let permissions = 0;
  let units = 0;
  let walkIns = 0;
  let deviceCodes = 0;
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
        /*
         * The refund caps a seed role ships with (Phase 7). Applied only where
         * the shop has never set one — both columns still NULL — so a tenant
         * that raised the cashier's limit keeps it, and a tenant that has never
         * seen the setting gets the sensible default rather than "unlimited".
         */
        if (
          seed.cashRefundPerReturnMinor !== undefined &&
          (await ensureRefundCaps(
            client,
            tenantId,
            roleId.id,
            seed.cashRefundPerReturnMinor,
            seed.cashRefundPerDayMinor ?? null,
          ))
        ) {
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
      for (const category of SEED_EXPENSE_CATEGORIES) {
        const added = await ensureExpenseCategory(
          client,
          tenantId,
          tenant.created_by.trim(),
          category.code,
          category.name,
        );
        if (added) touched = true;
      }
      for (const unitName of SEED_UNITS) {
        const added = await ensureUnit(client, tenantId, tenant.created_by.trim(), unitName);
        if (added) {
          units += 1;
          touched = true;
        }
      }
      if (await ensureWalkInParty(client, tenantId, tenant.created_by.trim())) {
        walkIns += 1;
        touched = true;
      }
      const coded = await ensureDeviceCodes(client, tenantId);
      if (coded > 0) {
        deviceCodes += coded;
        touched = true;
      }
      if (await ensureSalePrefix(client, tenantId)) touched = true;
      if (touched) tenants += 1;
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return { tenants, roles, permissions, units, walkIns, deviceCodes };
}

/**
 * Adds a unit only if the tenant has none by that name, live or archived.
 *
 * `lower(name)` matches the unique index in migration 0007, and archived rows are
 * included deliberately: a shop that removed "Pipe" on purpose should not have it
 * put back by a repair script.
 */
async function ensureUnit(
  client: { query: QueryFn },
  tenantId: string,
  actorId: string,
  name: string,
): Promise<boolean> {
  const existing = await client.query<{ id: string }>(
    'SELECT id FROM units WHERE tenant_id = $1 AND lower(name) = lower($2)',
    [tenantId, name],
  );
  if (existing.rows[0] !== undefined) return false;

  const now = clock.now();
  await client.query(
    `INSERT INTO units (id, tenant_id, name, created_at, updated_at, created_by, updated_by, version)
     VALUES ($1, $2, $3, $4, $4, $5, $5, 1)`,
    [Ulid.generate(clock), tenantId, name, now, actorId],
  );
  return true;
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

/**
 * Sets a seed role's refund caps, but only if neither has ever been set.
 *
 * Returns whether anything changed, so the run's summary counts the tenant as
 * touched — the same reporting every other step here does.
 */
/**
 * One expense category per tenant, by code.
 *
 * Added only if that code is absent, live or archived: a shop that archived
 * `Transport` meant it, and a backfill that resurrected it every deploy would
 * be a bug nobody could explain.
 */
async function ensureExpenseCategory(
  client: { query: QueryFn },
  tenantId: string,
  actorId: string,
  code: string,
  name: string,
): Promise<boolean> {
  const existing = await client.query<{ id: string }>(
    'SELECT id FROM expense_categories WHERE tenant_id = $1 AND code = $2',
    [tenantId, code],
  );
  if (existing.rows[0] !== undefined) return false;

  const now = clock.now();
  await client.query(
    `INSERT INTO expense_categories
       (id, tenant_id, code, name, is_system, status, created_at, updated_at, created_by, updated_by, version)
     VALUES ($1, $2, $3, $4, TRUE, 'ACTIVE', $5, $5, $6, $6, 1)`,
    [Ulid.generate(clock), tenantId, code, name, now, actorId],
  );
  return true;
}

async function ensureRefundCaps(
  client: { query: QueryFn },
  tenantId: string,
  roleId: string,
  perReturnMinor: number,
  perDayMinor: number | null,
): Promise<boolean> {
  const updated = await client.query<{ id: string }>(
    `UPDATE roles
        SET cash_refund_per_return_minor = $3, cash_refund_per_day_minor = $4,
            updated_at = $5
      WHERE tenant_id = $1 AND id = $2
        AND cash_refund_per_return_minor IS NULL
        AND cash_refund_per_day_minor IS NULL
      RETURNING id`,
    [tenantId, roleId, perReturnMinor, perDayMinor, clock.now()],
  );
  return updated.rows.length > 0;
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

/**
 * D-02's walk-in customer, for a tenant created before path 2.3 existed.
 *
 * Matched on `is_system_reserved` rather than on the name: every fully paid
 * counter sale from Phase 6 onward points at one of these, and a second one
 * would split those sales in two.
 */
async function ensureWalkInParty(
  client: { query: QueryFn },
  tenantId: string,
  actorId: string,
): Promise<boolean> {
  const existing = await client.query<{ id: string }>(
    'SELECT id FROM parties WHERE tenant_id = $1 AND is_system_reserved = TRUE',
    [tenantId],
  );
  if (existing.rows[0] !== undefined) return false;

  const id = Ulid.generate(clock);
  const now = clock.now();
  await client.query(
    `INSERT INTO parties (id, tenant_id, name, status, is_system_reserved,
                          created_at, updated_at, created_by, updated_by, version)
     VALUES ($1, $2, $3, 'ACTIVE', TRUE, $4, $4, $5, $5, 1)`,
    [id, tenantId, WALK_IN_PARTY_NAME, now, actorId],
  );
  await client.query(
    `INSERT INTO party_roles (id, tenant_id, party_id, role,
                              created_at, updated_at, created_by, updated_by, version)
     VALUES ($1, $2, $3, 'CUSTOMER', $4, $4, $5, $5, 1)`,
    [Ulid.generate(clock), tenantId, id, now, actorId],
  );
  return true;
}


/**
 * A permanent short code for every machine registered before Phase 12.4.
 *
 * The codes are handed out in registration order — A, B, C … — so the shop's
 * oldest counter PC keeps the lowest letter, which is what a shopkeeper would
 * expect if they ever thought about it. Once assigned, a code is never changed
 * or reused, even after the device is revoked: a sale numbered
 * `S-2026-B-000044` is filed paper, and giving `B` to another machine would
 * make two documents claim the same origin.
 */
async function ensureDeviceCodes(client: { query: QueryFn }, tenantId: string): Promise<number> {
  const { rows } = await client.query<{ id: string; device_code: string | null }>(
    `SELECT id, device_code FROM device_authorizations
      WHERE tenant_id = $1 ORDER BY created_at, id`,
    [tenantId],
  );
  const taken = new Set(
    rows.filter((row) => row.device_code !== null).map((row) => String(row.device_code)),
  );

  let assigned = 0;
  let next = 0;
  for (const row of rows) {
    if (row.device_code !== null) continue;
    let code = codeFor(next);
    while (taken.has(code)) {
      next += 1;
      code = codeFor(next);
    }
    await client.query('UPDATE device_authorizations SET device_code = $1 WHERE id = $2', [
      code,
      row.id,
    ]);
    taken.add(code);
    assigned += 1;
    next += 1;
  }
  return assigned;
}

/** A, B … Z, AA, AB — the same walk the repository does when registering. */
function codeFor(index: number): string {
  let n = index;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/**
 * Sales are numbered `S-…` from Phase 12.4 (owner decision 2026-09-02).
 *
 * The counter row carries its own prefix, so an existing tenant would otherwise
 * keep issuing `INV-` forever while the new device segment appeared in the
 * middle of it. Moving the prefix here rather than in a migration makes it a
 * deliberate, reversible step the shop takes when it deploys — and every number
 * already printed is untouched, because a document keeps the number it was
 * written with (§8).
 */
async function ensureSalePrefix(client: { query: QueryFn }, tenantId: string): Promise<boolean> {
  const { rows } = await client.query<{ id: string }>(
    `UPDATE numbering_counters SET prefix = 'S'
      WHERE tenant_id = $1 AND doc_type = 'SALE' AND prefix <> 'S'
      RETURNING id`,
    [tenantId],
  );
  return rows.length > 0;
}
