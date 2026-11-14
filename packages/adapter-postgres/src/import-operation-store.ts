import type { ImportOperationReservation, ImportOperationStore, TenantContext, Tx } from '@sher/core-application';
import type { ImportResultResponse } from '@sher/core-contracts';
import type { ImportType } from '@sher/core-domain';
import type { Clock } from '@sher/shared-utils';
import { Ulid } from '@sher/shared-utils';
import { and, eq, isNull } from 'drizzle-orm';

import { importOperations } from './schema';
import { txOf } from './unit-of-work';

/**
 * PostgreSQL's unique (tenant_id, operation_id) index is the serialization
 * point across Nest processes. INSERT .. ON CONFLICT DO NOTHING waits for the
 * transaction that claimed the same key to commit or roll back.
 *
 * Do not SELECT first and then INSERT: a two-process check-then-act race would
 * allow both callers to post business records before detecting a collision.
 */
export class PostgresImportOperationStore implements ImportOperationStore {
  constructor(private readonly clock: Clock) {}

  async reserve(
    tx: Tx,
    ctx: TenantContext,
    operationId: string,
    type: ImportType,
    requestFingerprint: string,
  ): Promise<ImportOperationReservation> {
    const created = await txOf(tx)
      .insert(importOperations)
      .values({
        id: Ulid.generate(this.clock),
        tenantId: ctx.tenantId,
        operationId,
        importType: type,
        requestFingerprint,
        createdAt: this.clock.now(),
        createdBy: ctx.userId,
      })
      .onConflictDoNothing({
        target: [importOperations.tenantId, importOperations.operationId],
      })
      .returning({ id: importOperations.id });

    if (created.length === 1) return { state: 'reserved' };

    const existing = await txOf(tx)
      .select({
        requestFingerprint: importOperations.requestFingerprint,
        responseJson: importOperations.responseJson,
      })
      .from(importOperations)
      .where(and(
        eq(importOperations.tenantId, ctx.tenantId),
        eq(importOperations.operationId, operationId),
      ))
      .limit(1);

    const winner = existing[0];
    if (winner === undefined || winner.responseJson === null) {
      // A completed transaction is never allowed to retain a pending record.
      // If it does, fail closed rather than accept a duplicate import.
      throw new Error('Import operation has no completed durable response');
    }

    return {
      state: 'replay',
      requestFingerprint: winner.requestFingerprint,
      response: winner.responseJson as ImportResultResponse,
    };
  }

  async complete(
    tx: Tx,
    ctx: TenantContext,
    operationId: string,
    response: ImportResultResponse,
  ): Promise<void> {
    const updated = await txOf(tx)
      .update(importOperations)
      .set({ responseJson: response, completedAt: this.clock.now() })
      .where(and(
        eq(importOperations.tenantId, ctx.tenantId),
        eq(importOperations.operationId, operationId),
        isNull(importOperations.responseJson),
      ))
      .returning({ id: importOperations.id });

    if (updated.length !== 1) {
      throw new Error('Import operation completion must update exactly one claim');
    }
  }
}
