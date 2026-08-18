import type { AuditValues } from '../ports/audit-writer';
import type { TenantContext } from '../ports/tenant-context';
import type { Tx } from '../ports/unit-of-work';

/** One row of the trail, as stored. Names are resolved by the use case. */
export interface AuditEventRow {
  readonly id: string;
  readonly occurredAt: Date;
  readonly actorId: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly action: string;
  readonly before: AuditValues | null;
  readonly after: AuditValues | null;
  readonly reason: string | null;
  readonly source: string;
}

/**
 * What the caller asked to see. Every field is optional; absent means "no
 * restriction on this dimension".
 *
 * `fromInclusive`/`toExclusive` are absolute instants, already converted from
 * the tenant-local dates the screen sent. The conversion is a business decision
 * — a day means a day in the tenant's timezone (§3.5) — so it happens in the
 * use case, never in SQL.
 */
export interface AuditFilter {
  readonly fromInclusive?: Date | undefined;
  readonly toExclusive?: Date | undefined;
  readonly actorId?: string | undefined;
  readonly entityType?: string | undefined;
  readonly action?: string | undefined;
  readonly entityId?: string | undefined;
  /** Keyset cursor: return rows strictly older than this id (§3.9). */
  readonly beforeId?: string | undefined;
  /** Rows to fetch. The use case asks for one extra to learn whether more exist. */
  readonly limit: number;
}

/** The values the filter dropdowns offer, taken from what this tenant actually has. */
export interface AuditFacets {
  readonly actions: readonly string[];
  readonly entityTypes: readonly string[];
  readonly actors: readonly { readonly id: string; readonly name: string }[];
}

/**
 * Reading the audit trail (slice 1.6, §5.22).
 *
 * Read-only by design. `AuditWriter` is the only way a row is ever created, and
 * there is deliberately no update or delete method anywhere — the table is
 * append-only (R-C7) and its integrity is the point of it existing.
 */
export interface AuditQueryRepository {
  list(tx: Tx, ctx: TenantContext, filter: AuditFilter): Promise<readonly AuditEventRow[]>;
  facets(tx: Tx, ctx: TenantContext): Promise<AuditFacets>;
  /** Display names for the actors on the page being returned. */
  namesFor(
    tx: Tx,
    ctx: TenantContext,
    userIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>>;
}
