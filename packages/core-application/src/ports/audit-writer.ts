import type { TenantContext } from './tenant-context';
import type { Tx } from './unit-of-work';

/**
 * Values recorded on both sides of a mutation. Money and quantity are integer
 * minor units, exactly as stored — an audit trail that rounds is not evidence.
 */
export type AuditValues = Readonly<Record<string, string | number | null>>;

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
}
