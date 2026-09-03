import { join } from 'node:path';

import { loadConfig } from './config';
import { createControlPool, runControlMigrations } from './db/pool';

/** `pnpm --filter @sher/control-plane db:migrate`. Forward-only, one transaction per file. */
async function main(): Promise<void> {
  const pool = createControlPool(loadConfig().databaseUrl);
  try {
    const applied = await runControlMigrations(pool, join(__dirname, '../migrations'));
    process.stdout.write(
      applied.length === 0
        ? 'No pending control-plane migrations.\n'
        : `Applied ${String(applied.length)}: ${applied.join(', ')}\n`,
    );
  } finally {
    await pool.end();
  }
}

void main();
