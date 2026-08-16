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
   * A transaction that starts with no `app.tenant_id`, for the steps that
   * happen before the tenant is known: sending a signup OTP to an identifier
   * with no account yet, and resolving a login identifier or refresh token to
   * the account that owns it. Until a tenant is adopted, only the tables
   * without one — `otp_codes`, `user_identifiers`, `refresh_tokens` — are
   * reachable; RLS hides the rest, which is the protection, not an obstacle.
   *
   * `adoptTenant` sets `app.tenant_id` **once the token or index has proved
   * which tenant this is**, so the rest of the work runs tenant-scoped inside
   * the same transaction (R-D5: a login is not two transactions). It is the
   * only sanctioned way to widen a transaction's reach.
   *
   * **Do not use this to escape RLS.** The tenant id passed to `adoptTenant`
   * must come from a lookup the caller just performed, never from a request
   * payload (R-C4).
   */
  runWithoutTenant<T>(
    work: (tx: Tx, adoptTenant: (tenantId: string) => Promise<void>) => Promise<T>,
  ): Promise<T>;
}
