import type { TenantContext } from './tenant-context';
import type { Tx } from './unit-of-work';

export interface OutboxRecord {
  readonly eventType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * Append-only change record, written inside the same transaction as the change
 * (R-D7, §2.3).
 *
 * NOTHING READS THIS UNTIL PHASE 12. It is the SRS-mandated exception to YAGNI:
 * a sync engine built later against a partial change history cannot reconstruct
 * what it missed. An agent must not remove outbox writes as unused code.
 */
export interface Outbox {
  append(tx: Tx, ctx: TenantContext, record: OutboxRecord): Promise<void>;
}
