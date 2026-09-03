import pg from 'pg';

// `pg` is CommonJS; a named import of `Client` is not a real export under ESM.
const { Client } = pg;

/**
 * The E2E database, and the guard that stands in front of it (Phase 18.5).
 *
 * **Owner decision 2026-09-03, not negotiable:** if the database this is
 * pointed at is not called exactly `sher_e2e`, the reset aborts. It may never
 * run against development, acceptance or production data. This is the same rule
 * `apps/api/vitest.config.ts` already applies with `sher_test`, and the reason
 * it is a hard stop rather than a warning is that the failure mode is a shop's
 * real books being dropped by a test run nobody was watching.
 *
 * **What SQL is allowed to do here is create an empty database and run the real
 * migrations.** It writes no business state: no stock balance, no customer due,
 * no supplier balance and no journal total is ever inserted by hand. Everything
 * the specs trade against is created through the application's own HTTP API, so
 * the movements and the journal entries behind every figure genuinely exist —
 * which is the difference between a suite that proves the ERP works and one
 * that proves SQL can write numbers into tables.
 */

/** The one name this may ever touch. */
const REQUIRED_DATABASE = 'sher_e2e';

export const E2E_DATABASE_URL =
  process.env['E2E_DATABASE_URL'] ?? `postgresql://postgres:dev@localhost:5432/${REQUIRED_DATABASE}`;

/**
 * The name in a connection string, or `null` when there is not exactly one.
 *
 * Parsed rather than pattern-matched: `...@host/sher_dev?options=sher_e2e`
 * contains the safe word and is a development database, and a guard that can be
 * talked round by a query string is not a guard.
 */
export function databaseNameOf(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const name = parsed.pathname.replace(/^\//, '');
  return name === '' ? null : name;
}

/**
 * Throws unless the URL names `sher_e2e`. Called before anything destructive,
 * and exported so a spec can assert the guard itself rather than trusting it.
 */
export function assertE2eDatabase(url: string): void {
  const name = databaseNameOf(url);
  if (name !== REQUIRED_DATABASE) {
    throw new Error(
      `E2E refused to run: the database is "${name ?? 'unreadable'}", not "${REQUIRED_DATABASE}". ` +
        'The reset drops and recreates whatever it is pointed at, so it will only ever point at ' +
        'the dedicated E2E database. Set E2E_DATABASE_URL if yours lives elsewhere.',
    );
  }
}

/** The same server, connected to `postgres` — you cannot drop the database you are in. */
function maintenanceUrl(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

/**
 * An empty `sher_e2e`, recreated from nothing.
 *
 * Dropped and recreated rather than truncated: a migration that ran in a
 * previous version of the suite leaves a column behind, and a truncate would
 * keep it — so the suite would be testing a schema no fresh installation has.
 */
export async function resetE2eDatabase(url: string = E2E_DATABASE_URL): Promise<void> {
  assertE2eDatabase(url);

  const client = new Client({ connectionString: maintenanceUrl(url) });
  await client.connect();
  try {
    // Anything still connected would make DROP fail; this is a test database,
    // and whatever is holding it open is a leftover from a killed run.
    await client.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [REQUIRED_DATABASE],
    );
    await client.query(`DROP DATABASE IF EXISTS ${REQUIRED_DATABASE}`);
    await client.query(`CREATE DATABASE ${REQUIRED_DATABASE}`);
  } finally {
    await client.end();
  }
}

/** A single query against the E2E database — reads only, for assertions. */
export async function queryE2e<T extends Record<string, unknown>>(
  sql: string,
  values: readonly unknown[] = [],
): Promise<readonly T[]> {
  assertE2eDatabase(E2E_DATABASE_URL);
  const client = new Client({ connectionString: E2E_DATABASE_URL });
  await client.connect();
  try {
    const result = await client.query(sql, [...values]);
    return result.rows as T[];
  } finally {
    await client.end();
  }
}
