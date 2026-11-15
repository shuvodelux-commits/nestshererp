import { purchasePostingWithLegs } from '@sher/core-domain';
import type { JournalEntryDraft, PurchaseCosts } from '@sher/core-domain';

import type { TenantContext } from '../ports/tenant-context';
import type { Tx } from '../ports/unit-of-work';
import type { PaymentAccountDeps } from './payment-account';
import { groupPurchasePaymentOutflows } from './purchase-payment-outflow-groups';
import type { PurchasePaymentOutflowInput } from './purchase-payment-outflow-groups';
import { resolvePurchaseInitialPaymentAccounts } from './purchase-payment-account-resolution';
import type { ResolvedPurchaseInitialPaymentLeg } from './purchase-payment-account-resolution';

/**
 * D06C1-B1a — one NONPOSTING purchase-time payment journal preparation.
 *
 * Preconditions: costs and businessDate are authoritative server values,
 * and the Tx is the *same* tenant-scoped transaction the eventual Class-T
 * writer will use. The resolver holds the existing tenant/cash-policy lock
 * and checks each physical account's aggregate outflow. This preflight
 * creates no stock, AP, journal or payment-leg database rows.
 *
 * Callers must not interpret success as a committed purchase. Persisting
 * the source, individual legs, journal, lots/stock, audit and outbox together
 * and handling idempotent replay/correction/rollback remain separate gates.
 */
export interface PreparedPurchaseInitialPaymentPosting {
  readonly paidMinor: number;
  readonly dueMinor: number;
  /** Original entered row order, with server-resolved canonical money codes. */
  readonly initialPaymentLegs: readonly ResolvedPurchaseInitialPaymentLeg[];
  /** ONE balanced journal draft, not a posted entry. */
  readonly journal: JournalEntryDraft;
}

export async function preparePurchaseInitialPaymentPosting(
  deps: PaymentAccountDeps,
  tx: Tx,
  ctx: TenantContext,
  businessDate: string,
  supplierPartyId: string,
  costs: PurchaseCosts,
  paymentLegs: readonly PurchasePaymentOutflowInput[],
): Promise<PreparedPurchaseInitialPaymentPosting> {
  const totalMinor = costs.grandTotalMinor;
  if (!Number.isSafeInteger(totalMinor) || totalMinor <= 0) {
    throw new RangeError('Purchase total must be positive safe integer poisha');
  }

  // Defense in depth: even a mistaken internal caller must not acquire money
  // account locks for inconsistent stock valuation, rounding or bill totals.
  // Server-owned purchaseCosts() normally guarantees this identity, but future
  // pricing adapters may accidentally pass a partially reconstructed object.
  if (
    !Number.isSafeInteger(costs.inventoryValueMinor) ||
    !Number.isSafeInteger(costs.roundingMinor) ||
    !Number.isSafeInteger(costs.inventoryValueMinor + costs.roundingMinor) ||
    costs.inventoryValueMinor + costs.roundingMinor !== totalMinor
  ) {
    throw new RangeError('Purchase inventory valuation plus rounding must equal the bill total');
  }

  // Validate ALL physical account references and group before the first
  // resolver call, so invalid/overpaid purchase requests never acquire a
  // partial set of account authorizations. Preserve source lines separately.
  const groups = groupPurchasePaymentOutflows(paymentLegs);
  let paidMinor = 0;
  for (const group of groups) {
    paidMinor += group.amountMinor;
    if (!Number.isSafeInteger(paidMinor)) {
      throw new RangeError('Combined purchase payments exceed safe integer poisha');
    }
  }
  if (paidMinor > totalMinor) {
    throw new RangeError('Purchase payments cannot exceed the server-calculated bill total');
  }

  const initialPaymentLegs = await resolvePurchaseInitialPaymentAccounts(
    deps,
    tx,
    ctx,
    businessDate,
    paymentLegs,
  );
  // Use only accounts authorized and normalized by the real tenant resolver,
  // and maintain the original source order in both provenance and journal.
  const journal = purchasePostingWithLegs(costs, {
    supplierPartyId,
    paymentLegs: initialPaymentLegs.map((leg) => ({
      account: leg.accountCode,
      amountMinor: leg.amountMinor,
    })),
  });

  return {
    paidMinor,
    dueMinor: totalMinor - paidMinor,
    initialPaymentLegs,
    journal,
  };
}
