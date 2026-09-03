import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import pg from 'pg';

/**
 * The control plane's own pool and its own migration runner.
 *
 * It deliberately does **not** reuse `@sher/adapter-postgres`. That package is
 * the ERP's data plane — tenant scoping, the golden invariants, the discovered
 * backup table list — and importing it here would put the shop's persistence
 * layer one line away from vendor code. `pnpm test:boundaries` forbids it, and
 * this file is what makes the ban costless: forty lines, applied forward-only,
 * one transaction per file, exactly like the ERP's own runner.
 */
export function createControlPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl, max: 10 });
}

export async function runControlMigrations(pool: pg.Pool, dir: string): Promise<string[]> {
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
    const already = new Set(done.rows.map((row) => row.name));

    for (const file of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) {
      if (already.has(file)) continue;
      const sql = readFileSync(join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
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
