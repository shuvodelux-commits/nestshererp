import { AppError, ErrorCode } from '@sher/core-contracts';
import type { TenantContext } from '../ports/tenant-context';
import type { Tx } from '../ports/unit-of-work';
import type { MoneyRepository } from './money-repository';

/** Caller holds the tenant lock shared with Close Day. */
export async function assertCashDayNotClosed(
  money: MoneyRepository, tx: Tx, ctx: TenantContext,
  businessDate: string, accountCodes: readonly string[],
): Promise<void> {
  const cashAccountIds = [...new Set(
    accountCodes.filter((code) => code.startsWith('CASH:')).map((code) => code.slice(5)),
  )];
  if (cashAccountIds.length === 0) return;
  // An earlier-dated journal also changes every later as-of closing balance.
  // Check ACTIVE counted closes for original drawer identities, not isDrawer now.
  if (!await money.hasClosedCountedDayOnOrAfter(tx, ctx, businessDate, cashAccountIds)) return;
  throw new AppError(
    ErrorCode.VALIDATION_FAILED,
    'This cash day is already counted and closed; record a separate approved adjustment on an eligible date',
  );
}
