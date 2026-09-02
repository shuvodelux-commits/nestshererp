import { AppError, ErrorCode, Permission, SYNC_WIRE_VERSION } from '@sher/core-contracts';
import type {
  SyncConflictListQuery,
  SyncConflictResponse,
  SyncPullQuery,
  SyncPullResponse,
  SyncStatusResponse,
} from '@sher/core-contracts';
import { occupiesWriterSlot } from '@sher/core-domain';
import { parseInstant } from '@sher/shared-utils';
import type { Clock } from '@sher/shared-utils';

import type { ManageProductsService } from '../catalog/manage-products-service';
import type { DeviceRepository } from '../devices/device-repository';
import type { ManagePartiesService } from '../parties/manage-parties-service';
import type { AccessControl } from '../ports/access-control';
import type { TenantContext } from '../ports/tenant-context';
import type { UnitOfWork } from '../ports/unit-of-work';
import type { SyncConflictRow, SyncRepository } from './sync-repository';

/**
 * What the Sync screen reads, and what a reconnecting machine pulls down
 * (§5.23, Phase 12.4).
 *
 * The two live together because they answer the same question from opposite
 * ends — "is this machine level with the shop?" — and because both are reads
 * that post nothing at all.
 */
export class SyncReadService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly access: AccessControl,
    private readonly sync: SyncRepository,
    private readonly devices: DeviceRepository,
    private readonly products: ManageProductsService,
    private readonly parties: ManagePartiesService,
    private readonly clock: Clock,
  ) {}

  async status(ctx: TenantContext): Promise<SyncStatusResponse> {
    return this.uow.run(ctx, async (tx) => {
      await this.access.require(tx, ctx, Permission.SYNC_STATUS_VIEW);
      const counts = await this.sync.counts(tx, ctx);
      const writer = await this.devices.findWriter(tx, ctx);

      return {
        wireVersion: SYNC_WIRE_VERSION,
        lastPushAt: writer?.lastPushAt?.toISOString() ?? null,
        lastPullAt: writer?.lastPullAt?.toISOString() ?? null,
        cursor: writer?.syncCursor?.toISOString() ?? null,
        appliedCount: counts.applied,
        openConflictCount: counts.openConflicts,
        resolvedConflictCount: counts.resolvedConflicts,
        discardedCount: counts.discarded,
        writer:
          writer === null
            ? null
            : {
                deviceId: writer.id,
                name: writer.name,
                deviceCode: writer.deviceCode,
                status: writer.status,
              },
        serverTime: this.clock.now().toISOString(),
      };
    });
  }

  async conflicts(
    ctx: TenantContext,
    query: SyncConflictListQuery,
  ): Promise<{ readonly data: readonly SyncConflictResponse[] }> {
    return this.uow.run(ctx, async (tx) => {
      await this.access.require(tx, ctx, Permission.SYNC_STATUS_VIEW);
      const rows = await this.sync.listConflicts(tx, ctx, {
        status: query.status,
        limit: query.limit,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      });
      return { data: rows.map(toConflictResponse) };
    });
  }

  /**
   * What has changed in the shop's master data since this machine last looked.
   *
   * Served from the tables' own `updated_at` rather than a change-feed table,
   * for the reason 12.3 gave for keeping whole payloads: a feed is a second
   * record of when a product changed, and the day it drifts the counter starts
   * charging a price the shop no longer sells at.
   *
   * The rows themselves come back through the same list services the online
   * screens call, so a cashier's pull can only contain what a cashier's screen
   * would show — permissions inherited, never re-implemented.
   */
  async pull(
    ctx: TenantContext,
    deviceKey: string,
    query: SyncPullQuery,
  ): Promise<SyncPullResponse> {
    const now = this.clock.now();
    const cursor = query.cursor === undefined ? null : parseInstant(query.cursor);
    if (query.cursor !== undefined && cursor === null) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'That sync cursor is not a time');
    }

    const changed = await this.uow.run(ctx, async (tx) => {
      const device = await this.devices.findByPublicKey(tx, ctx, deviceKey);
      if (device === null || !occupiesWriterSlot(device.status)) {
        throw new AppError(
          ErrorCode.PERMISSION_DENIED,
          'This computer is not the shop’s offline computer, so there is nothing for it to catch up on',
        );
      }
      return { device, rows: await this.sync.changesSince(tx, ctx, cursor, query.limit) };
    });

    const changes = [];
    for (const row of changed.rows) {
      if (row.kind === 'TOMBSTONE') {
        changes.push({
          entity: row.entity,
          id: row.id,
          kind: 'TOMBSTONE' as const,
          entityVersion: row.entityVersion,
          payload: null,
          role: row.role,
          changedAt: row.changedAt.toISOString(),
        });
        continue;
      }

      const payload =
        row.entity === 'PRODUCT'
          ? await this.productOrNull(ctx, row.id)
          : await this.partyOrNull(ctx, row.id);

      changes.push({
        entity: row.entity,
        id: row.id,
        // A row the caller may not read comes back as a tombstone rather than
        // as nothing: the device must remove what it is no longer allowed to
        // hold, and silence would leave yesterday's copy on the disk.
        kind: payload === null ? ('TOMBSTONE' as const) : ('UPSERT' as const),
        entityVersion: row.entityVersion,
        payload,
        role: row.role,
        changedAt: row.changedAt.toISOString(),
      });
    }

    const last = changed.rows.at(-1);
    const nextCursor = last?.changedAt ?? cursor;
    const hasMore = changed.rows.length === query.limit;

    if (nextCursor !== null) {
      await this.uow.run(ctx, async (tx) => {
        await this.sync.recordPull(tx, ctx, changed.device.id, now, nextCursor);
      });
    }

    return {
      changes,
      nextCursor: nextCursor?.toISOString() ?? null,
      hasMore,
      serverTime: now.toISOString(),
    };
  }

  private async productOrNull(ctx: TenantContext, id: string): Promise<unknown> {
    try {
      return await this.products.get({ ctx, productId: id });
    } catch {
      return null;
    }
  }

  private async partyOrNull(ctx: TenantContext, id: string): Promise<unknown> {
    try {
      return await this.parties.get({ ctx, partyId: id });
    } catch {
      return null;
    }
  }
}

export function toConflictResponse(row: SyncConflictRow): SyncConflictResponse {
  return {
    id: row.id,
    operationId: row.operation.operationId,
    opType: row.operation.opType,
    documentNumber: row.operation.resultDocumentNumber,
    deviceName: row.operation.deviceName,
    deviceCode: row.operation.deviceCode,
    deviceCreatedAt: row.operation.deviceCreatedAt.toISOString(),
    businessDate: row.operation.businessDate,
    recordedByName: row.recordedByName,
    reasonCode: row.reasonCode,
    reasonMessage: row.reasonMessage,
    localState: row.localState,
    serverState: row.serverState,
    payload: row.operation.payload,
    suggestedActions: [...row.suggestedActions],
    status: row.status,
    resolution: row.resolution,
    resolutionReason: row.resolutionReason,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolvedByName: row.resolvedByName,
    attempts: row.operation.attempts,
    createdAt: row.createdAt.toISOString(),
  };
}
