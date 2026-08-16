import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type pg from 'pg';

/**
 * Applies `migrations/*.sql` in filename order, once each, inside a transaction
 * per file (SRS 3.10: forward-only, no down-migrations, every migration runs in
 * a transaction). Applied names are recorded in `schema_migrations`.
 *
 * Hand-written SQL on purpose: a generated migration is not reviewable by the
 * person who has to approve it, and this schema is the thing least safe to get
 * wrong silently.
 */
export async function runMigrations(pool: pg.Pool, migrationsDir: string): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        TEXT        PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const done = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const alreadyApplied = new Set(done.rows.map((row) => row.name));

    const files = readdirSync(migrationsDir)
      .filter((name) => name.endsWith('.sql'))
      .sort();

    for (const file of files) {
      if (alreadyApplied.has(file)) continue;

      const statements = readFileSync(join(migrationsDir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(statements);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    client.release();
  }

  return applied;
}
