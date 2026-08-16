import type { AuditEvent, AuditWriter, TenantContext, Tx } from '@sher/core-application';
import { SYSTEM_ACTOR_ID } from '@sher/core-application';
import type { Clock } from '@sher/shared-utils';
import { Ulid } from '@sher/shared-utils';

import { auditEvents } from './schema';
import { txOf } from './unit-of-work';

/** Append-only. There is no update and no delete here, by design (R-C7). */
export class PostgresAuditWriter implements AuditWriter {
  constructor(private readonly clock: Clock) {}

  async append(tx: Tx, ctx: TenantContext, event: AuditEvent): Promise<void> {
    await txOf(tx)
      .insert(auditEvents)
      .values({
        id: Ulid.generate(this.clock),
        tenantId: ctx.tenantId,
        createdAt: this.clock.now(),
        createdBy: ctx.userId,
        entityType: event.entityType,
        entityId: event.entityId,
        action: event.action,
        beforeJson: event.before,
        afterJson: event.after,
        reason: event.reason ?? null,
        source: event.source,
      });
  }

  /** A null tenant is visible to no tenant — which is what a platform event is. */
  async appendPlatform(tx: Tx, event: AuditEvent): Promise<void> {
    await txOf(tx)
      .insert(auditEvents)
      .values({
        id: Ulid.generate(this.clock),
        tenantId: null,
        createdAt: this.clock.now(),
        createdBy: SYSTEM_ACTOR_ID,
        entityType: event.entityType,
        entityId: event.entityId,
        action: event.action,
        beforeJson: event.before,
        afterJson: event.after,
        reason: event.reason ?? null,
        source: event.source,
      });
  }
}
