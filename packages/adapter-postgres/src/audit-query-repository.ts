import type {
  AuditEventRow,
  AuditFacets,
  AuditFilter,
  AuditQueryRepository,
  AuditValues,
  TenantContext,
  Tx,
} from '@sher/core-application';
import { and, desc, eq, gte, inArray, lt } from 'drizzle-orm';

import { auditEvents, users } from './schema';
import { txOf } from './unit-of-work';

/**
 * Reading the audit trail (§5.22, slice 1.6).
 *
 * There is no insert, update or delete in this file. Rows are written by
 * `PostgresAuditWriter` inside the transaction of the change they describe, and
 * the table is append-only (R-C7).
 *
 * No business calculation happens here (R-B6): the use case has already turned
 * tenant-local dates into instants, because what a "day" means is a business
 * rule (§3.5) and not something SQL should be deciding.
 */
export class PostgresAuditQueryRepository implements AuditQueryRepository {
  async list(tx: Tx, ctx: TenantContext, filter: AuditFilter): Promise<readonly AuditEventRow[]> {
    const conditions = [eq(auditEvents.tenantId, ctx.tenantId)];

    if (filter.fromInclusive !== undefined) {
      conditions.push(gte(auditEvents.createdAt, filter.fromInclusive));
    }
    if (filter.toExclusive !== undefined) {
      conditions.push(lt(auditEvents.createdAt, filter.toExclusive));
    }
    if (filter.actorId !== undefined) conditions.push(eq(auditEvents.createdBy, filter.actorId));
    if (filter.entityType !== undefined) {
      conditions.push(eq(auditEvents.entityType, filter.entityType));
    }
    if (filter.action !== undefined) conditions.push(eq(auditEvents.action, filter.action));
    if (filter.entityId !== undefined) conditions.push(eq(auditEvents.entityId, filter.entityId));
    // Keyset, never OFFSET (§3.9). Ids are ULIDs, so "id below the cursor" is
    // "older than the last row shown" — one column is both sort key and cursor.
    if (filter.beforeId !== undefined) conditions.push(lt(auditEvents.id, filter.beforeId));

    const rows = await txOf(tx)
      .select({
        id: auditEvents.id,
        occurredAt: auditEvents.createdAt,
        actorId: auditEvents.createdBy,
        entityType: auditEvents.entityType,
        entityId: auditEvents.entityId,
        action: auditEvents.action,
        before: auditEvents.beforeJson,
        after: auditEvents.afterJson,
        reason: auditEvents.reason,
        source: auditEvents.source,
      })
      .from(auditEvents)
      .where(and(...conditions))
      .orderBy(desc(auditEvents.id))
      .limit(filter.limit);

    return rows.map((row) => ({
      ...row,
      before: row.before as AuditValues | null,
      after: row.after as AuditValues | null,
    }));
  }

  /**
   * The filter choices, taken from what this tenant actually has rather than
   * from a hard-coded list — so a later module's events appear in the filters
   * the moment it writes its first one, with nothing to remember to update.
   */
  async facets(tx: Tx, ctx: TenantContext): Promise<AuditFacets> {
    const db = txOf(tx);

    const [actions, entityTypes, actors] = await Promise.all([
      db
        .selectDistinct({ value: auditEvents.action })
        .from(auditEvents)
        .where(eq(auditEvents.tenantId, ctx.tenantId))
        .orderBy(auditEvents.action),
      db
        .selectDistinct({ value: auditEvents.entityType })
        .from(auditEvents)
        .where(eq(auditEvents.tenantId, ctx.tenantId))
        .orderBy(auditEvents.entityType),
      db
        .selectDistinct({ id: auditEvents.createdBy, name: users.displayName })
        .from(auditEvents)
        // A left join: an actor may be the reserved system id, which is not a
        // user row. Losing those events from the filter would hide exactly the
        // ones nobody can be asked about.
        .leftJoin(users, and(eq(users.id, auditEvents.createdBy), eq(users.tenantId, ctx.tenantId)))
        .where(eq(auditEvents.tenantId, ctx.tenantId))
        .orderBy(users.displayName),
    ]);

    return {
      actions: actions.map((row) => row.value),
      entityTypes: entityTypes.map((row) => row.value),
      actors: actors.map((row) => ({ id: row.id, name: row.name ?? 'SherERP' })),
    };
  }

  async namesFor(
    tx: Tx,
    ctx: TenantContext,
    userIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    const wanted = [...new Set(userIds)];
    if (wanted.length === 0) return new Map();

    const rows = await txOf(tx)
      .select({ id: users.id, name: users.displayName })
      .from(users)
      .where(and(eq(users.tenantId, ctx.tenantId), inArray(users.id, wanted)));

    return new Map(rows.map((row) => [row.id, row.name]));
  }
}
