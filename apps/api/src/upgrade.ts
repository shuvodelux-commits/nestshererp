import { createPool, runMigrations } from '@sher/adapter-postgres';

import { loadConfig } from './config';
import { assertSchemaMatchesBuild } from './deployment/schema-version-gate';
import { PgDumpTool } from './infrastructure/database-dump-tool';
import { MIGRATIONS_DIRECTORY, newestMigration } from './infrastructure/build-info';

/**
 * `pnpm db:upgrade` — the one shipped upgrade command (Phase 10, owner decision
 * 2026-08-30).
 *
 * ```
 *   validate prerequisites
 *   → create a PostgreSQL recovery dump, and verify it can be read back
 *   → run the forward-only migrations, in order
 *   → health-check the result
 *   → on any failure, restore the dump and exit non-zero saying so
 * ```
 *
 * **Never at API startup.** An upgrade is a maintenance operation somebody
 * performs at a time they choose; a restart at nine in the morning must not
 * become a schema change at nine in the morning, with a rollback running while
 * the shop waits to open.
 *
 * **Nothing is migrated before the dump verifies.** `dumpAndVerify` reads the
 * archive back with `pg_restore --list` rather than trusting an exit code, and
 * a dump that cannot be opened stops the upgrade with the database untouched.
 *
 * The automatic rollback restores that dump. It is deliberately the *last*
 * resort and deliberately loud: it prints what it did, what state the database
 * is now in, and the error that caused it.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const target = newestMigration(MIGRATIONS_DIRECTORY);
  const pool = createPool(config.databaseUrl);

  try {
    const before = await currentSchema(pool);
    if (before === target) {
      say(`Already up to date at ${target}. Nothing to do.`);
      return;
    }
    if (before !== null && before > target) {
      throw new Error(
        `This database is at ${before}, which is newer than the ${target} this software ` +
          'ships. Install the matching version of SherERP instead of downgrading the database.',
      );
    }

    say(`Upgrading from ${before ?? 'an empty database'} to ${target}.`);
    say('Taking a recovery copy of the database…');
    const dump = await new PgDumpTool(config.databaseUrl, config.recoveryDumpDir).dumpAndVerify(
      `before-upgrade-${target}`,
    );
    say(`Recovery copy written and verified: ${dump.path} (${formatBytes(dump.byteSize)}).`);

    try {
      const applied = await runMigrations(pool, MIGRATIONS_DIRECTORY);
      say(
        applied.length === 0
          ? 'No pending migrations.'
          : `Applied ${String(applied.length)} migration(s): ${applied.join(', ')}`,
      );

      // The health check is the same gate the API applies at boot. If the
      // upgrade cannot satisfy it, the API would refuse to start anyway — far
      // better to discover that here, where the rollback is still one step away.
      await assertSchemaMatchesBuild(pool, target);
      say('Upgrade complete.');
    } catch (error) {
      say(`Upgrade FAILED: ${describe(error)}`);
      say('Restoring the recovery copy…');
      await restore(config.databaseUrl, dump.path);
      say(`Restored. The database is back at ${before ?? 'its previous state'}.`);
      say(`The recovery copy is kept at ${dump.path}.`);
      process.exitCode = 1;
      return;
    }
  } catch (error) {
    say(`Upgrade did not start: ${describe(error)}`);
    say('Nothing has been changed.');
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

async function currentSchema(pool: ReturnType<typeof createPool>): Promise<string | null> {
  try {
    const result = await pool.query<{ name: string }>(
      'SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1',
    );
    return result.rows[0]?.name ?? null;
  } catch {
    // No `schema_migrations` at all is a database that has never been migrated,
    // which is a first install rather than a failure.
    return null;
  }
}

/**
 * `pg_restore --clean --if-exists` over the same database.
 *
 * A separate process rather than a library call, for the same reason the dump
 * is: this is PostgreSQL's own tooling doing the one job it is authoritative
 * about, and a rollback is the worst possible place to be clever.
 */
async function restore(databaseUrl: string, dumpPath: string): Promise<void> {
  const { spawn } = await import('node:child_process');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      'pg_restore',
      ['--clean', '--if-exists', '--no-owner', '--dbname', databaseUrl, dumpPath],
      { stdio: ['ignore', 'ignore', 'inherit'] },
    );
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pg_restore exited with ${String(code)}`));
    });
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatBytes(bytes: number): string {
  const megabytes = bytes / (1024 * 1024);
  return megabytes < 1 ? `${String(bytes)} bytes` : `${megabytes.toFixed(1)} MB`;
}

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

void main();
