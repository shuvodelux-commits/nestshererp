import type { IdempotencyRecord, IdempotencyStore, TenantContext, Tx } from '@sher/core-application';
import type { Clock } from '@sher/shared-utils';
import { Ulid } from '@sher/shared-utils';
import { and, eq } from 'drizzle-orm';

import { idempotencyKeys } from './schema';
import { txOf } from './unit-of-work';

/**
 * The 30-day fast path. Pruning this table is safe precisely because it is not
 * the guarantee: `notes.operation_id` is unique per tenant permanently, so a
 * replay after the prune hits that constraint instead of duplicating (R-C10).
 */
export class PostgresIdempotencyStore implements IdempotencyStore {
  constructor(private readonly clock: Clock) {}

  async find(tx: Tx, ctx: TenantContext, operationId: string): Promise<IdempotencyRecord | null> {
    const rows = await txOf(tx)
      .select({
        requestFingerprint: idempotencyKeys.requestFingerprint,
        response: idempotencyKeys.responseJson,
      })
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.tenantId, ctx.tenantId),
          eq(idempotencyKeys.operationId, operationId),
        ),
      )
      .limit(1);

    return rows[0] ?? null;
  }

  async save(
    tx: Tx,
    ctx: TenantContext,
    record: IdempotencyRecord & { operationId: string },
  ): Promise<void> {
    await txOf(tx)
      .insert(idempotencyKeys)
      .values({
        id: Ulid.generate(this.clock),
        tenantId: ctx.tenantId,
        createdAt: this.clock.now(),
        createdBy: ctx.userId,
        operationId: record.operationId,
        requestFingerprint: record.requestFingerprint,
        responseJson: record.response,
      });
  }
}
