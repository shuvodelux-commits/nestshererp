import type pg from 'pg';

/**
 * The application refuses normal service when its executable and its database
 * schema are incompatible (Phase 10, owner decision 2026-08-30).
 *
 * **Both directions are refusals, and for the same reason.** A database *behind*
 * the build has tables and columns the code expects and will not find; a
 * database *ahead* of it — an operator who rolled the binary back without
 * rolling the schema back — has shapes this code has never seen. Either way the
 * software would run, look healthy, and be wrong about a shop's money, which is
 * exactly the failure a version gate exists to prevent.
 *
 * It refuses at boot rather than per request. A half-upgraded installation that
 * served reads and refused writes would be an installation somebody keeps using
 * for the afternoon, and the point is that nobody uses it at all until the
 * upgrade is finished.
 *
 * The message names both versions in full, because the person reading it is on
 * the phone to somebody who needs to hear them.
 */
export async function assertSchemaMatchesBuild(
  pool: pg.Pool,
  buildSchemaVersion: string,
): Promise<void> {
  const applied = await newestApplied(pool);

  if (applied === null) {
    throw new Error(
      'This database has no SherERP schema in it yet. Run the upgrade command to create it.',
    );
  }
  if (applied === buildSchemaVersion) return;

  const behind = applied < buildSchemaVersion;
  throw new Error(
    behind
      ? `SherERP will not start: this database is at ${applied} and this version of the ` +
        `software needs ${buildSchemaVersion}. Run the upgrade command, which takes a ` +
        'verified recovery copy before it changes anything.'
      : `SherERP will not start: this database is at ${applied}, which is newer than the ` +
        `${buildSchemaVersion} this software understands. Install the matching version of ` +
        'SherERP, or restore the recovery copy taken before the upgrade.',
  );
}

/**
 * `schema_migrations` is not RLS-scoped — it belongs to the installation rather
 * than to a business — so this reads without a tenant, which is the only way it
 * could work at boot.
 */
async function newestApplied(pool: pg.Pool): Promise<string | null> {
  const result = await pool.query<{ name: string }>(
    'SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1',
  );
  return result.rows[0]?.name ?? null;
}
