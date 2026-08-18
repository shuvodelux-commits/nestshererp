import { AUDIT_PAGE_DEFAULT, AUDIT_PAGE_MAX, Permission } from '@sher/core-contracts';
import type { AuditEventResponse, AuditListResponse } from '@sher/core-contracts';
import { addSeconds, startOfBusinessDay } from '@sher/shared-utils';

import type { AccessControl } from '../ports/access-control';
import { SYSTEM_ACTOR_ID } from '../ports/audit-writer';
import type { TenantContext } from '../ports/tenant-context';
import type { UnitOfWork } from '../ports/unit-of-work';
import type { AuditEventRow, AuditQueryRepository } from './audit-query-repository';

/**
 * Reading the audit trail (slice 1.6, §5.22).
 *
 * **WRITE CLASS: READ ONLY.** Nothing here mutates anything, and there is no
 * companion service that does: rows are written by `AuditWriter` inside the
 * transaction of the change they describe, and the table is append-only (R-C7).
 *
 * §5.22's requirement is that "the system must never make a financially
 * meaningful historical event disappear without an auditable trail" — this
 * screen is how the owner exercises that guarantee, so it filters and pages but
 * never hides.
 *
 * Dates arrive as tenant-local `YYYY-MM-DD` and are converted to instants here,
 * not in SQL. A day is a day in the tenant's timezone (§3.5): asking for the
 * 18th in Dhaka must not return six hours of the 17th because `created_at` is
 * stored in UTC.
 */
export interface ListAuditEventsCommand {
  readonly ctx: TenantContext;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly actorId?: string | undefined;
  readonly entityType?: string | undefined;
  readonly action?: string | undefined;
  readonly entityId?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

const ONE_DAY_SECONDS = 86400;

export class ListAuditEventsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly accessControl: AccessControl,
    private readonly events: AuditQueryRepository,
  ) {}

  async list(command: ListAuditEventsCommand): Promise<AuditListResponse> {
    const { ctx } = command;
    const limit = Math.min(command.limit ?? AUDIT_PAGE_DEFAULT, AUDIT_PAGE_MAX);

    return this.uow.run(ctx, async (tx) => {
      await this.accessControl.require(tx, ctx, Permission.AUDIT_VIEW);

      // `to` is inclusive to the user — "the 5th to the 7th" is three days — so
      // the exclusive bound is the start of the day *after* it.
      const rows = await this.events.list(tx, ctx, {
        fromInclusive:
          command.from === undefined ? undefined : startOfBusinessDay(command.from, ctx.timezone),
        toExclusive:
          command.to === undefined
            ? undefined
            : addSeconds(startOfBusinessDay(command.to, ctx.timezone), ONE_DAY_SECONDS),
        actorId: command.actorId,
        entityType: command.entityType,
        action: command.action,
        entityId: command.entityId,
        beforeId: command.cursor,
        // One more than asked for, so "is there another page" is answered
        // without a second count query over a table that only grows.
        limit: limit + 1,
      });

      const page = rows.slice(0, limit);
      const hasMore = rows.length > limit;

      const names = await this.events.namesFor(
        tx,
        ctx,
        page.map((row) => row.actorId),
      );
      const facets = await this.events.facets(tx, ctx);

      return {
        events: page.map((row) => toResponse(row, names)),
        timezone: ctx.timezone,
        page: {
          nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
          hasMore,
        },
        actions: [...facets.actions],
        entityTypes: [...facets.entityTypes],
        actors: facets.actors.map((actor) => ({ ...actor })),
      };
    });
  }
}

/**
 * A deleted user still owns their history. When the name cannot be resolved the
 * row keeps the id rather than going blank — an event with no actor reads as if
 * nobody did it.
 */
function nameFor(actorId: string, names: ReadonlyMap<string, string>): string {
  if (actorId === SYSTEM_ACTOR_ID) return 'SherERP';
  return names.get(actorId) ?? actorId;
}

function toResponse(row: AuditEventRow, names: ReadonlyMap<string, string>): AuditEventResponse {
  return {
    id: row.id,
    occurredAt: row.occurredAt.toISOString(),
    actorName: nameFor(row.actorId, names),
    actorId: row.actorId,
    entityType: row.entityType,
    entityId: row.entityId,
    action: row.action,
    before: row.before === null ? null : { ...row.before },
    after: row.after === null ? null : { ...row.after },
    reason: row.reason,
    source: row.source,
  };
}
