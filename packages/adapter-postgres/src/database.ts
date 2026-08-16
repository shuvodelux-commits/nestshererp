import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import pg from 'pg';

import * as schema from './schema';

export type Database = NodePgDatabase<typeof schema>;
/** Drizzle's transaction handle — what the opaque `Tx` really is. */
export type DatabaseTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * BIGINT arrives from pg as a string by default, which would put money into a
 * string and invite `Number()` on it. Money and quantity are integers, so parse
 * int8 to a number here, once, at the driver boundary — and fail loudly rather
 * than silently lose precision above 2^53.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (value: string) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new RangeError(`BIGINT ${value} exceeds the safe integer range`);
  }
  return parsed;
});

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString });
}

export function createDatabase(pool: pg.Pool): Database {
  return drizzle(pool, { schema });
}

/**
 * Sets `app.tenant_id` for the current transaction, which is what the RLS
 * policies read (SRS 3.2). `set_config(..., true)` is transaction-local, so the
 * value cannot leak to the next borrower of a pooled connection.
 */
export async function setTenantForTransaction(
  tx: DatabaseTransaction,
  tenantId: string,
): Promise<void> {
  await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
}

export type { PoolClient };
