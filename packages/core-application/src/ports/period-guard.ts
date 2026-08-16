import type { TenantContext } from './tenant-context';
import type { Tx } from './unit-of-work';

/**
 * Period lock (D-25). Granularity is a calendar month per tenant; a closed month
 * rejects any write landing in it, whatever the document type.
 */
export interface PeriodGuard {
  /** Throws AppError(PERIOD_LOCKED) when `businessDate` falls in a closed month. */
  assertOpen(tx: Tx, ctx: TenantContext, businessDate: string): Promise<void>;
}
