import type { TenantContext } from './tenant-context';
import type { Tx } from './unit-of-work';

/**
 * Values recorded on both sides of a mutation. Money and quantity are integer
 * minor units, exactly as stored — an audit trail that rounds is not evidence.
 */
export type AuditValues = Readonly<Record<string, string | number | null>>;

/**
 * The actor on a platform event that no user performed — an OTP sent to an
 * identifier that has no account yet. A reserved, ULID-shaped constant, so
 * `created_by` stays NOT NULL and a real user id can never collide with it.
 */
export const SYSTEM_ACTOR_ID = '00000000000000000000000000';

export interface AuditEvent {
  readonly entityType: string;
  readonly entityId: string;
  readonly action: string;
  /** null for a create. */
  readonly before: AuditValues | null;
  /** null for a delete. */
  readonly after: AuditValues | null;
  readonly reason?: string;
  /** Where the mutation came from: API, DAYBOOK, SYNC, MCP (§5.22). */
  readonly source: string;
}

/**
 * Append-only audit trail (R-D4, SRS 5.22). Every mutation writes one event,
 * inside the same transaction as the change it describes. Audit logging cannot
 * be disabled by configuration.
 */
export interface AuditWriter {
  append(tx: Tx, ctx: TenantContext, event: AuditEvent): Promise<void>;
  /**
   * A platform event that happened before any tenant existed: an OTP send, a
   * failed verification, a signup lockout (§5.3 requires all three to be
   * audited — R-13, SIM swap). Written with a null tenant and the reserved
   * system actor, and readable by no tenant, because it belongs to none.
   */
  appendPlatform(tx: Tx, event: AuditEvent): Promise<void>;
}
