import { AppError, ErrorCode, Permission } from '@sher/core-contracts';

import type { AccessControl } from '../ports/access-control';
import type { TenantContext } from '../ports/tenant-context';
import type { Tx } from '../ports/unit-of-work';

/**
 * Who may see a loan account (Finance module, owner decision 2026-08-31).
 *
 * **Two codes, either one.** `loan.account.manage` is for the person who opens
 * and edits the loan; `loan.movement.record` is for the person who enters the
 * instalments. Both have to be able to *see* the loan — a bookkeeper who can
 * record a repayment but cannot read which loans exist could not choose one,
 * and the permission would name an action nobody could perform.
 *
 * It is deliberately not `cash.account.view` or `bank.account.view`. A loan is
 * not money the shop holds, and a cashier who may count the till has no reason
 * to learn what the business owes.
 *
 * Setting a loan **up** still needs `loan.account.manage` on its own — that
 * check lives with the other manage permissions in `ManageAccountsService`.
 */
export const LOAN_VISIBILITY_CODES: readonly string[] = [
  Permission.LOAN_ACCOUNT_MANAGE,
  Permission.LOAN_MOVEMENT_RECORD,
];

/** Whether a set of held permissions admits the shop's loans. */
export function seesLoans(held: readonly string[]): boolean {
  return LOAN_VISIBILITY_CODES.some((code) => held.includes(code));
}

/**
 * The `require` an `AccessControl` cannot express on its own: it takes one
 * code, and this rule is satisfied by either of two.
 */
export async function requireLoanVisibility(
  accessControl: AccessControl,
  tx: Tx,
  ctx: TenantContext,
): Promise<void> {
  const held = await accessControl.permissionsOf(tx, ctx);
  if (seesLoans(held)) return;

  throw new AppError(
    ErrorCode.PERMISSION_DENIED,
    'You do not have permission to see the shop’s loans',
  );
}
