import { join } from 'node:path';

import { createPool, runMigrations } from '@sher/adapter-postgres';

import { loadConfig } from './config';

/**
 * `pnpm db:migrate`. Forward-only, one transaction per file (SRS 3.10).
 * The migrations directory is at the repository root, not inside a package.
 */
async function main(): Promise<void> {
  const pool = createPool(loadConfig().databaseUrl);
  try {
    const applied = await runMigrations(pool, join(__dirname, '../../../migrations'));
    process.stdout.write(
      applied.length === 0
        ? 'No pending migrations.\n'
        : `Applied ${String(applied.length)} migration(s): ${applied.join(', ')}\n`,
    );
  } finally {
    await pool.end();
  }
}

void main();
