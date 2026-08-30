import { accountCodeFor } from '@sher/core-domain';
import type { AccountCode } from '@sher/core-domain';
import { AppError, ErrorCode, Permission } from '@sher/core-contracts';
import { Money } from '@sher/shared-utils';

import type { AccessControl } from '../ports/access-control';
import type { TenantContext } from '../ports/tenant-context';
import type { Tx } from '../ports/unit-of-work';
import type { MoneyRepository } from '../money/money-repository';

/**
 * The account money left, resolved from the code a client sent (§2.4, §5.16).
 *
 * Shared by both ways of paying a supplier — the "Paid now" box on a bill and
 * the Pay Supplier dialog — because a client sends a **string**, and this is
 * the boundary that refuses one naming an account of another shop, an account
 * that has been retired, or a fixed account like `AP` that is not a place money
 * physically sits. Without it, `AP` in the paid-account field would settle a
 * bill with the very debt it created.
 *
 * **The drawer rule is here too** (owner decision 2026-08-24, revised the same
 * day): cash may not leave a drawer on a day nobody opened, because that money
 * belongs to a count that will never see it and the day would close short by
 * exactly this amount. Bank and bKash are unaffected — there is nothing to
 * count — so a shop that has not started the day can still pay by transfer.
 * The refusal carries `reason: CASH_DAY_NOT_STARTED` so the screen can offer
 * `দিন শুরু করুন` in place, without the shopkeeper losing what they typed.
 *
 * **A cash box cannot pay out money it does not hold** (bug reported by the
 * owner 2026-08-26). Without this, an expense or a supplier payment larger than
 * the drawer drove the balance negative and nothing complained — and the day
 * then could not be closed at all, because a physical count can never be a
 * negative number. Only **cash** is guarded and only on the way **out**: a bank
 * account may legitimately be overdrawn, and money coming in never needs a
 * balance to arrive against.
 */
export interface ResolvedPaymentAccount {
  readonly code: AccountCode;
  readonly name: string;
  /** The open session this payment belongs to, when it touched the drawer. */
  readonly sessionId: string | null;
}

export interface PaymentAccountDeps {
  readonly access: AccessControl;
  readonly money: MoneyRepository;
}

export async function resolvePaymentAccount(
  deps: PaymentAccountDeps,
  tx: Tx,
  ctx: TenantContext,
  code: string,
  businessDate: string,
  /**
   * What is leaving this account, in poisha. Omitted by every caller taking
   * money **in**, which is what keeps a receipt from being refused for a drawer
   * that happens to be empty.
   */
  outflowMinor?: number,
): Promise<ResolvedPaymentAccount> {
  const separatorAt = code.indexOf(':');
  const accountId = separatorAt === -1 ? '' : code.slice(separatorAt + 1);
  const account = accountId === '' ? null : await deps.money.findAccountById(tx, ctx, accountId);

  if (account === null) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, 'That is not an account of this shop');
  }

  await deps.access.require(
    tx,
    ctx,
    account.type === 'CASH' ? Permission.CASH_ACCOUNT_VIEW : Permission.BANK_ACCOUNT_VIEW,
  );

  if (account.status === 'INACTIVE') {
    throw new AppError(ErrorCode.VALIDATION_FAILED, `“${account.name}” is no longer in use`);
  }

  /*
   * Checked against the live journal rollup, not a stored column, so it is the
   * same figure the account list and the statement show. A shop that genuinely
   * paid from elsewhere records it against that account instead; a shop that
   * has miscounted finds out here rather than at the end of the day, when the
   * only way out is a short/over adjustment.
   */
  if (
    account.type === 'CASH' &&
    outflowMinor !== undefined &&
    outflowMinor > 0 &&
    outflowMinor > account.balanceMinor
  ) {
    throw new AppError(
      ErrorCode.VALIDATION_FAILED,
      `“${account.name}” only has ${Money(account.balanceMinor).format()} in it`,
      {
        reason: 'CASH_ACCOUNT_SHORT',
        accountId: account.id,
        balanceMinor: String(account.balanceMinor),
      },
    );
  }

  if (!account.isDrawer) {
    // Rebuilt from the row rather than trusted from the request: the two agree
    // for an honest client, and where they would not, the row is right.
    return { code: accountCodeFor(account.type, account.id), name: account.name, sessionId: null };
  }

  const session = await deps.money.findOpenSession(tx, ctx);
  if (session === null || session.businessDate !== businessDate) {
    throw new AppError(
      ErrorCode.VALIDATION_FAILED,
      'The cash day is not started, so money cannot leave the drawer yet',
      { reason: 'CASH_DAY_NOT_STARTED' },
    );
  }

  return {
    code: accountCodeFor(account.type, account.id),
    name: account.name,
    sessionId: session.id,
  };
}
