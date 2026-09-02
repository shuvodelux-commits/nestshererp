import { AppError, ErrorCode, Permission, resolutionsFor } from '@sher/core-contracts';
import type { ResolveSyncConflictRequest, SyncConflictResponse } from '@sher/core-contracts';
import { Ulid } from '@sher/shared-utils';
import type { Clock } from '@sher/shared-utils';

import type { DeviceRepository } from '../devices/device-repository';
import type { AccessControl } from '../ports/access-control';
import type { AuditWriter } from '../ports/audit-writer';
import type { TenantContext } from '../ports/tenant-context';
import type { UnitOfWork } from '../ports/unit-of-work';
import { label, replayOperation } from './operation-registry';
import type { SyncServices } from './operation-registry';
import { toConflictResponse } from './sync-read-service';
import { OP_DOCUMENT_TABLE } from './sync-repository';
import type { SyncConflictRow, SyncRepository } from './sync-repository';

/**
 * What a person decides about a document the books would not accept
 * (§15, §16, §24 of the owner's specification for Phase 12.4).
 *
 * **Every resolution that posts goes back through the same service that
 * refused it**, against live state, at this moment. There is no path here that
 * writes a document directly, edits a posted one, or relaxes a rule to make
 * synchronisation pass — a resolution can only ever post what the counter could
 * have posted online, which is why a manager may be trusted with it at all.
 *
 * The four actions, and what each really is:
 *
 * - **RETRY** — try it again. The month was reopened, the permission given
 *   back, the product un-archived; nothing about the document changes.
 * - **MERGE** — the thing it collided with is the thing it meant. The colliding
 *   reference is rewritten to what the shop already has, and the operation is
 *   run again.
 * - **KEEP_BOTH_EDIT** — the manager's correction to what was typed, validated
 *   by the operation's own schema exactly as a fresh request would be.
 * - **DISCARD_WITH_REASON** — this will never be posted. Nothing is erased:
 *   the operation, its payload, who decided and why all stay readable forever
 *   (§16). Owner alone.
 */
export class ResolveConflictService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly access: AccessControl,
    private readonly sync: SyncRepository,
    private readonly devices: DeviceRepository,
    private readonly services: SyncServices,
    private readonly audit: AuditWriter,
    private readonly clock: Clock,
  ) {}

  async resolve(command: {
    readonly ctx: TenantContext;
    readonly conflictId: string;
    readonly request: ResolveSyncConflictRequest;
  }): Promise<SyncConflictResponse> {
    const { ctx, request } = command;
    const now = this.clock.now();

    const conflict = await this.uow.run(ctx, async (tx) => {
      await this.access.require(
        tx,
        ctx,
        request.resolution === 'DISCARD_WITH_REASON'
          ? Permission.SYNC_CONFLICT_DISCARD
          : Permission.SYNC_CONFLICT_RESOLVE,
      );
      const row = await this.sync.findConflictById(tx, ctx, command.conflictId);
      if (row === null) throw new AppError(ErrorCode.NOT_FOUND, 'That sync issue is not here');
      return row;
    });

    if (conflict.status !== 'OPEN') {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        'Somebody has already decided about this one',
      );
    }

    const allowed = resolutionsFor(conflict.reasonCode);
    if (!allowed.includes(request.resolution)) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        `That is not something you can do about this refusal. You can ${allowed.join(' or ')}.`,
      );
    }

    if (request.resolution === 'DISCARD_WITH_REASON') {
      return this.discard(ctx, conflict, request.reason ?? '', now);
    }

    return this.repost(ctx, conflict, request, now);
  }

  /**
   * Not posted, not erased.
   *
   * The operation is marked so it is never tried again — a device that pushes
   * it once more is told the shop has decided — and everything about it stays
   * exactly where it was: the payload it carried, the machine that made it, the
   * refusal it met, who decided, when, and why.
   */
  private async discard(
    ctx: TenantContext,
    conflict: SyncConflictRow,
    reason: string,
    now: Date,
  ): Promise<SyncConflictResponse> {
    if (reason.trim().length < 3) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        'Say why this will never be posted. It stays in the shop’s record either way.',
      );
    }

    return this.uow.run(ctx, async (tx) => {
      await this.sync.recordOutcome(tx, ctx, conflict.syncOperationId, {
        status: 'DISCARDED',
        errorCode: conflict.reasonCode,
        errorMessage: conflict.reasonMessage,
        at: now,
      });
      await this.sync.closeConflict(tx, ctx, conflict.id, {
        status: 'DISCARDED',
        resolution: 'DISCARD_WITH_REASON',
        reason,
        at: now,
      });
      await this.audit.append(tx, ctx, {
        entityType: 'sync_conflict',
        entityId: conflict.id,
        action: 'DISCARD',
        before: { status: 'OPEN', reasonCode: conflict.reasonCode },
        after: {
          status: 'DISCARDED',
          operationId: conflict.operation.operationId,
          opType: conflict.operation.opType,
        },
        reason,
        source: 'SYNC',
      });

      const saved = await this.sync.findConflictById(tx, ctx, conflict.id);
      if (saved === null) throw new Error('sync conflict vanished while being resolved');
      return toConflictResponse(saved);
    });
  }

  /**
   * Hand it back to the service that refused it.
   *
   * Deliberately outside a transaction of this service's own: the posting
   * service opens exactly one and does the whole document in it, and an outer
   * transaction would be a second connection deadlocking against the first —
   * the same rule replay follows, for the same reason.
   */
  private async repost(
    ctx: TenantContext,
    conflict: SyncConflictRow,
    request: ResolveSyncConflictRequest,
    now: Date,
  ): Promise<SyncConflictResponse> {
    const op = conflict.operation;
    const device = await this.uow.run(ctx, async (tx) =>
      this.devices.findById(tx, ctx, op.deviceId),
    );

    /*
     * `KEEP_BOTH_EDIT` and `MERGE` both arrive as a corrected payload: the
     * manager has changed the phone number that collided, or pointed the
     * document at the customer the shop already has. It is validated by the
     * operation's own schema inside `replayOperation`, exactly as a fresh
     * request would be — a patch cannot smuggle a field past the endpoint.
     */
    const payload = request.patch === undefined ? op.payload : request.patch;

    const replayCtx: TenantContext = {
      tenantId: ctx.tenantId,
      // Still the person who did the work at the counter, not the manager
      // clearing the queue. Who resolved it is on the conflict row and in the
      // audit trail, where a decision belongs.
      userId: op.context.userId,
      timezone: ctx.timezone,
      deviceCode: device?.deviceCode ?? null,
    };

    try {
      const replayed = await replayOperation(
        this.services,
        replayCtx,
        op.opType,
        op.operationId,
        payload,
        { documentNumber: op.resultDocumentNumber },
      );

      return await this.uow.run(ctx, async (tx) => {
        await this.sync.recordOutcome(tx, ctx, conflict.syncOperationId, {
          status: 'APPLIED',
          resultDocumentId: replayed.documentId,
          resultDocumentNumber: replayed.documentNumber,
          serverResultDigest: replayed.digest,
          assignServerSeq: true,
          at: now,
        });
        if (device !== null) {
          await this.sync.markOffline(tx, ctx, {
            table: OP_DOCUMENT_TABLE[op.opType],
            documentId: replayed.documentId,
            deviceId: device.id,
            deviceCreatedAt: op.deviceCreatedAt,
            deviceSeq: op.localSeq,
            syncedAt: now,
          });
        }
        await this.sync.closeConflict(tx, ctx, conflict.id, {
          status: 'RESOLVED',
          resolution: request.resolution,
          reason: request.reason ?? null,
          at: now,
        });
        await this.audit.append(tx, ctx, {
          entityType: 'sync_conflict',
          entityId: conflict.id,
          action: 'RESOLVE',
          before: { status: 'OPEN', reasonCode: conflict.reasonCode },
          after: {
            status: 'RESOLVED',
            resolution: request.resolution,
            documentId: replayed.documentId,
            documentNumber: replayed.documentNumber,
          },
          ...(request.reason === undefined ? {} : { reason: request.reason }),
          source: 'SYNC',
        });

        const saved = await this.sync.findConflictById(tx, ctx, conflict.id);
        if (saved === null) throw new Error('sync conflict vanished while being resolved');
        return toConflictResponse(saved);
      });
    } catch (cause) {
      /*
       * It refused again. The conflict stays open with the new reason on it —
       * a second row would give the manager the same document to read twice,
       * and the count in the top bar would stop meaning "things to deal with".
       */
      const message =
        cause instanceof AppError
          ? cause.message
          : `The shop’s books still would not take this ${label(op.opType)}.`;

      await this.uow.run(ctx, async (tx) => {
        await this.sync.countAttempt(tx, ctx, conflict.syncOperationId, now);
        await this.sync.upsertConflict(tx, ctx, {
          id: Ulid.generate(this.clock),
          syncOperationId: conflict.syncOperationId,
          reasonCode: conflict.reasonCode,
          reasonMessage: message,
          localState: conflict.localState,
          serverState: conflict.serverState,
          suggestedActions: resolutionsFor(conflict.reasonCode),
          at: now,
        });
      });

      throw cause instanceof AppError
        ? cause
        : new AppError(ErrorCode.VALIDATION_FAILED, message);
    }
  }
}
