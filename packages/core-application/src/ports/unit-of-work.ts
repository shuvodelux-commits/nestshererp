import type { TenantContext } from './tenant-context';

/**
 * A handle to the one open database transaction. Opaque on purpose: the
 * application layer passes it to ports and never looks inside it, so no Drizzle
 * or pg type can leak past this boundary (R-B3).
 */
export interface Tx {
  readonly __transaction: unique symbol;
}

/**
 * ONE transaction per use case (R-D1, R-D5).
 *
 * The implementation opens the transaction, sets `app.tenant_id` for RLS, runs
 * the work, and commits — or rolls back everything if the work throws. A
 * business operation that seems to need two transactions is a STOP-and-report.
 */
export interface UnitOfWork {
  run<T>(ctx: TenantContext, work: (tx: Tx) => Promise<T>): Promise<T>;
}
