import type { PeriodGuard, TenantContext, Tx } from '@sher/core-application';
import { AppError, ErrorCode } from '@sher/core-contracts';
import { and, eq } from 'drizzle-orm';

import { periodLocks } from './schema';
import { txOf } from './unit-of-work';

/**
 * Period lock, calendar month per tenant (D-25).
 *
 * No row means the month is open — locking is an explicit act, so a tenant that
 * has never closed a period can still write. A CLOSED month rejects the write
 * with PERIOD_LOCKED; unlocking needs `finance.period.unlock`, step-up auth and
 * a reason, and is built in Phase 7.
 */
export class PostgresPeriodGuard implements PeriodGuard {
  async assertOpen(tx: Tx, ctx: TenantContext, businessDate: string): Promise<void> {
    const year = Number(businessDate.slice(0, 4));
    const month = Number(businessDate.slice(5, 7));

    const rows = await txOf(tx)
      .select({ status: periodLocks.status })
      .from(periodLocks)
      .where(
        and(
          eq(periodLocks.tenantId, ctx.tenantId),
          eq(periodLocks.periodYear, year),
          eq(periodLocks.periodMonth, month),
        ),
      )
      .limit(1);

    if (rows[0]?.status === 'CLOSED') {
      throw new AppError(
        ErrorCode.PERIOD_LOCKED,
        `The period ${businessDate.slice(0, 7)} is closed`,
        { period: businessDate.slice(0, 7) },
      );
    }
  }
}
