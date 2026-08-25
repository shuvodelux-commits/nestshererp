import type { TenantContext } from '../ports/tenant-context';
import type { Tx } from '../ports/unit-of-work';

/** Closing a month (§5.19, D-25). The guard reads these rows on every write. */
export interface PeriodRow {
  readonly year: number;
  readonly month: number;
  readonly status: 'OPEN' | 'CLOSED';
  readonly entryCount: number;
  readonly closedAt: Date | null;
  readonly closedByName: string | null;
}

export interface PeriodRepository {
  /**
   * Every month with activity, plus every month already closed, newest first.
   *
   * A month nobody posted in and nobody closed is not listed: there is nothing
   * to decide about it, and a list of empty months is a list nobody reads.
   */
  listPeriods(tx: Tx, ctx: TenantContext, limit: number): Promise<readonly PeriodRow[]>;
  findPeriod(tx: Tx, ctx: TenantContext, year: number, month: number): Promise<PeriodRow | null>;
  close(
    tx: Tx,
    ctx: TenantContext,
    lock: {
      readonly id: string;
      readonly year: number;
      readonly month: number;
      readonly note: string | null;
    },
  ): Promise<void>;
}
