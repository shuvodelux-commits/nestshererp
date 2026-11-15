import type { AccountCode } from '@sher/core-domain';

import type { TenantContext } from '../ports/tenant-context';
import type { Tx } from '../ports/unit-of-work';
import { resolvePaymentAccount } from './payment-account';
import type { PaymentAccountDeps, ResolvedPaymentAccount } from './payment-account';
import { groupPurchasePaymentOutflows } from './purchase-payment-outflow-groups';
import type { PurchasePaymentOutflowInput } from './purchase-payment-outflow-groups';

/**
 * MOD-008 D06C1-A: resolve every initial purchase payment account BEFORE a
 * future Class-T writer may post any journal or stock source.
 *
 * This is a reusable, NONPOSTING authorisation step, not a public endpoint.
 * Call it inside the same UOW transaction as the eventual purchase writer.
 * The existing resolver checks tenant ownership, account status, permissions,
 * cash balance and Cash Session ON/OFF, under the tenant lock. Critically it
 * sees the AGGREGATE outflow for one physical account, not each source line.
 *
 * Do not use this return value as evidence that a purchase was committed:
 * idempotency, period, payable, durable provenance, correction, journal and
 * stock must all be implemented and signed-off in the future Class-T writer.
 */
export interface ResolvedPurchaseInitialPaymentLeg {
  /** Stable 1-based source position; journal rows may repeat the same account. */
  readonly lineNo: number;
  /** Trusted canonical code returned by the resolver (MFS input -> BANK). */
  readonly accountCode: AccountCode;
  readonly amountMinor: number;
  /** The real eligible open drawer session, or null when no session applies. */
  readonly sessionId: string | null;
}

export async function resolvePurchaseInitialPaymentAccounts(
  deps: PaymentAccountDeps,
  tx: Tx,
  ctx: TenantContext,
  businessDate: string,
  paymentLegs: readonly PurchasePaymentOutflowInput[],
): Promise<readonly ResolvedPurchaseInitialPaymentLeg[]> {
  // Fully validate and aggregate BEFORE the first account lookup/lock.
  // The group helper rejects mixed aliases to one ID and unsafe amount sums.
  const groups = groupPurchasePaymentOutflows(paymentLegs);
  const byPhysicalAccount = new Map<string, ResolvedPaymentAccount>();

  // Sorted unique IDs are stable across opposite source row orders. The
  // resolver takes the existing settings/tenant lock before reading each live
  // account balance. A failure must propagate, never be swallowed or result
  // in a partial list of source rows.
  for (const group of groups) {
    const resolved = await resolvePaymentAccount(
      deps,
      tx,
      ctx,
      group.accountCode,
      businessDate,
      group.amountMinor,
    );
    if (resolved.code.slice(resolved.code.indexOf(':') + 1) !== group.accountId) {
      throw new Error('Resolved money-account identity changed during purchase validation');
    }
    byPhysicalAccount.set(group.accountId, resolved);
  }

  // Preserve original entered row count, amounts and order, using only the
  // *resolved* canonical code and session for later immutable source writes.
  return paymentLegs.map((leg, index) => {
    const accountId = leg.accountCode.slice(leg.accountCode.indexOf(':') + 1);
    const account = byPhysicalAccount.get(accountId);
    if (account === undefined) {
      throw new Error('A purchase payment account was not verified');
    }
    return {
      lineNo: index + 1,
      accountCode: account.code,
      amountMinor: leg.amountMinor,
      sessionId: account.sessionId,
    };
  });
}
