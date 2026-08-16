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
  /**
   * A transaction with no `app.tenant_id` set, for the signup steps that happen
   * before a tenant exists (§5.3 D-07: send an OTP to an identifier that has no
   * account yet). Only tables without a tenant — `otp_codes`, `user_identifiers`
   * — and platform audit rows are reachable inside it; RLS hides everything else,
   * which is the intended protection, not an obstacle to work around.
   *
   * **Do not use this to escape RLS.** Completing a registration uses `run` with
   * the newly generated tenant id, because by then the tenant is being created.
   */
  runWithoutTenant<T>(work: (tx: Tx) => Promise<T>): Promise<T>;
}
