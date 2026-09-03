import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { prepareDatabase, startApi } from './support/stack';
import { seedBaseline } from './support/seed';

/**
 * One reset, one migrate, one backfill, one API, one seed — before any spec
 * runs (Phase 18.5).
 *
 * The order matters and is the whole reason this is a global setup rather than
 * two `webServer` entries: the database has to be dropped and migrated *before*
 * a process connects to it, and the baseline has to be seeded *after* that
 * process is answering. The guard inside `prepareDatabase` refuses outright
 * unless the database is `sher_e2e`.
 */
async function globalSetup(): Promise<void> {
  await prepareDatabase();
  await startApi();
  const baseline = await seedBaseline();

  // Written to disk rather than passed in memory: Playwright runs each spec
  // file in its own worker process, and a value returned from here would not
  // reach any of them.
  writeFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '.baseline.json'),
    `${JSON.stringify(baseline, null, 2)}\n`,
    'utf8',
  );
}

export default globalSetup;
