import type { AuditWriter } from '../ports/audit-writer';
import type { TenantContext } from '../ports/tenant-context';
import type { UnitOfWork } from '../ports/unit-of-work';

/**
 * Recording a refused mutation (slice 1.6, §5.22).
 *
 * §5.22: "Permission **denials** on mutating actions are audit-logged with
 * user, code, record, timestamp, trace ID. Read denials are logged in aggregate
 * only." Somebody repeatedly trying to void invoices they may not void is a
 * thing the owner needs to be able to see; somebody hitting a report they
 * cannot open is noise.
 *
 * **This runs in its own transaction, on purpose, and that is not a breach of
 * R-D5.** The refused operation's transaction has already rolled back — that is
 * what a refusal means — and an audit row written inside it would roll back
 * with it, leaving no evidence of the very thing worth evidencing. R-D5 forbids
 * splitting *one business operation* across two transactions. This is not part
 * of that operation: the operation did not happen. It is a separate security
 * event about an attempt, and it is written after the attempt is over.
 *
 * A failure to record must never turn a 403 into a 500 — the caller was
 * correctly refused either way — so the caller of this service swallows its
 * errors. That is the one place in SherERP where a write may fail quietly, and
 * it is chosen deliberately over reporting a permission refusal as a broken
 * server.
 */
export interface RecordPermissionDenialCommand {
  readonly ctx: TenantContext;
  /** The permission code that was missing. */
  readonly permissionCode: string;
  /** What was being attempted, e.g. `POST /api/v1/settings/value`. */
  readonly resource: string;
  /** Ties the row to the error the caller saw on screen (§5.26 envelope). */
  readonly traceId: string;
}

export class RecordPermissionDenialService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly audit: AuditWriter,
  ) {}

  async record(command: RecordPermissionDenialCommand): Promise<void> {
    const { ctx } = command;

    await this.uow.run(ctx, async (tx) => {
      await this.audit.append(tx, ctx, {
        // Not the entity the caller was reaching for — they never reached it,
        // and naming it would imply the record was touched. The denial itself
        // is the event, and the permission code is what identifies it.
        entityType: 'permission_denial',
        entityId: command.permissionCode,
        action: 'DENIED',
        before: null,
        after: { resource: command.resource, traceId: command.traceId },
        source: 'API',
      });
    });
  }
}
