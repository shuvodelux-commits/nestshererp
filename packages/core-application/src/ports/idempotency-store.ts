import type { TenantContext } from './tenant-context';
import type { Tx } from './unit-of-work';

export interface IdempotencyRecord {
  /**
   * Canonical JSON of the request payload, compared verbatim to detect the same
   * key sent with a different body. Stored rather than hashed: an exact compare
   * cannot collide, and these payloads are small.
   */
  readonly requestFingerprint: string;
  /** The original response, replayed verbatim on a retry. */
  readonly response: unknown;
}

/**
 * The 30-day fast path for `operation_id` (§5.26, R-C10).
 *
 * This table is pruned; it is NOT the guarantee. The permanent guarantee is the
 * unique index on (tenant_id, operation_id) of the document table itself, which
 * still catches an offline replay that arrives months later.
 */
export interface IdempotencyStore {
  find(tx: Tx, ctx: TenantContext, operationId: string): Promise<IdempotencyRecord | null>;
  save(tx: Tx, ctx: TenantContext, record: IdempotencyRecord & { operationId: string }): Promise<void>;
}
