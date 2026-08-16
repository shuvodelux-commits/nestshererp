import type { TenantContext, Tx, UnitOfWork } from '@sher/core-application';

import type { Database, DatabaseTransaction } from './database';
import { setTenantForTransaction } from './database';

/**
 * Unwraps the opaque `Tx` the application layer carries around.
 *
 * This is the ONE place a cast happens, and it exists so that no Drizzle type
 * ever appears in core-application (R-B3). Every adapter takes `Tx` and calls
 * this; nothing else may.
 */
export function txOf(tx: Tx): DatabaseTransaction {
  return tx as unknown as DatabaseTransaction;
}

/**
 * ONE transaction per use case (R-D1).
 *
 * Opens the transaction, sets `app.tenant_id` so RLS applies to every statement
 * inside it, then runs the work. Any thrown error rolls back everything —
 * document, journal, movements, audit and outbox together, never partially.
 */
export class PostgresUnitOfWork implements UnitOfWork {
  constructor(private readonly db: Database) {}

  async run<T>(ctx: TenantContext, work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(async (transaction) => {
      await setTenantForTransaction(transaction, ctx.tenantId);
      return work(transaction as unknown as Tx);
    });
  }
}
