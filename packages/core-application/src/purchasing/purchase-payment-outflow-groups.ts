/**
 * MOD-008 D06C0 — pure plan for future Class-T initial purchase outflows.
 *
 * The source payment rows remain ordered and untouched for eventual immutable
 * posting/audit. Here we compute only one amount to authorize PER physical
 * money account before any individual leg is journaled. If a shop has 4,000
 * poisha of cash, 2,000 + 3,000 from the same drawer must be tested as 5,000.
 *
 * This helper does NOT check a balance or resolve/authorize an account.
 * A future Class-T writer must:
 *  1) hold the existing tenant/cash-policy lock,
 *  2) call the real tenant-scoped account resolver for each grouped outflow,
 *  3) check account balance against the grouped amount in that transaction,
 *  4) preserve every original leg in the journal/source rows.
 * The live legacy purchase writer is not wired to this module.
 */
export interface PurchasePaymentOutflowInput {
  readonly accountCode: string;
  readonly amountMinor: number;
}

export interface PurchasePaymentOutflowGroup {
  readonly accountId: string;
  /** Original submitted code, for authoritative resolution (not journal use). */
  readonly accountCode: string;
  readonly amountMinor: number;
}

const ACCOUNT_REF = /^(?:CASH|BANK|MFS):([A-Za-z0-9_-]{1,35})$/;

export function groupPurchasePaymentOutflows(
  paymentLegs: readonly PurchasePaymentOutflowInput[],
): readonly PurchasePaymentOutflowGroup[] {
  if (paymentLegs.length > 10) {
    throw new RangeError('A purchase may have at most ten payment legs');
  }

  const byAccountId = new Map<string, PurchasePaymentOutflowGroup>();
  let purchasePaidMinor = 0;
  for (const leg of paymentLegs) {
    const accountId = ACCOUNT_REF.exec(leg.accountCode)?.[1];
    if (accountId === undefined) {
      throw new RangeError('Payment must name a valid cash, bank or MFS account');
    }
    if (!Number.isSafeInteger(leg.amountMinor) || leg.amountMinor <= 0) {
      throw new RangeError('Payment outflow must be positive integer poisha');
    }

    const existing = byAccountId.get(accountId);
    // BANK:<id> and MFS:<id> can refer to one account. Do not aggregate
    // across distinct submitted aliases and lose a stale/forged family:
    // the single account resolver would otherwise only validate one of them.
    if (existing !== undefined && existing.accountCode !== leg.accountCode) {
      throw new RangeError('One money account must use one consistent account code');
    }

    const combinedMinor = (existing?.amountMinor ?? 0) + leg.amountMinor;
    const nextPaidMinor = purchasePaidMinor + leg.amountMinor;
    if (!Number.isSafeInteger(combinedMinor) || !Number.isSafeInteger(nextPaidMinor)) {
      throw new RangeError('Combined purchase payments exceed safe integer poisha');
    }

    purchasePaidMinor = nextPaidMinor;
    byAccountId.set(accountId, {
      accountId,
      accountCode: leg.accountCode,
      amountMinor: combinedMinor,
    });
  }

  // The future writer will resolve these accounts in this deterministic order.
  // Original leg order must be retained separately for journal/source posting.
  return [...byAccountId.values()].sort((a, b) =>
    a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0);
}
