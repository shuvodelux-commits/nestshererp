import { AppError, ErrorCode } from '@sher/core-contracts';
import type { TenantContext } from '../ports/tenant-context';
import type { Tx } from '../ports/unit-of-work';
import type { MoneyRepository } from './money-repository';

/** Caller holds the tenant lock shared with Close Day. */
export async function assertCashDayNotClosed(
  money: MoneyRepository, tx: Tx, ctx: TenantContext,
  businessDate: string, accountCodes: readonly string[],
): Promise<void> {
  if (!accountCodes.some((code) => code.startsWith('CASH:'))) return;
  const counted = await money.findSessionByDate(tx, ctx, businessDate);
  if (counted?.status !== 'CLOSED') return;
  if (!accountCodes.includes('CASH:' + counted.accountId)) return;
  throw new AppError(
    ErrorCode.VALIDATION_FAILED,
    'This cash day is already counted and closed; record a separate approved adjustment on an eligible date',
  );
}
