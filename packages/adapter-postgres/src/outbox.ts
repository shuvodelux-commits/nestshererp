import type { Outbox, OutboxRecord, TenantContext, Tx } from '@sher/core-application';
import type { Clock } from '@sher/shared-utils';
import { Ulid } from '@sher/shared-utils';

import { outbox } from './schema';
import { txOf } from './unit-of-work';

/**
 * Append-only change record, written in the same transaction as the change.
 * NOTHING READS IT UNTIL PHASE 12 (D7) — do not delete it as dead code.
 */
export class PostgresOutbox implements Outbox {
  constructor(private readonly clock: Clock) {}

  async append(tx: Tx, ctx: TenantContext, record: OutboxRecord): Promise<void> {
    await txOf(tx)
      .insert(outbox)
      .values({
        id: Ulid.generate(this.clock),
        tenantId: ctx.tenantId,
        createdAt: this.clock.now(),
        createdBy: ctx.userId,
        eventType: record.eventType,
        aggregateType: record.aggregateType,
        aggregateId: record.aggregateId,
        payload: record.payload,
      });
  }
}
