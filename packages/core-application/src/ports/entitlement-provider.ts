import type { LicenseState } from '@sher/core-domain';

/**
 * D-35: where entitlements come from is pluggable.
 *
 *   `SubscriptionEntitlementProvider` — SaaS, answered from the subscription.
 *   `LicenseKeyEntitlementProvider`  — on-premise, answered from a signed
 *   licence key validated **offline** against an embedded public key. No
 *   phone-home.
 *
 * **On-premise does not skip entitlement checks — it answers them from the
 * licence.** That is the whole reason this is a port and not an `if (isOnPrem)`,
 * which R-A/anti-overengineering names as the pattern that starts the fork.
 *
 * `modules[]` feeds the **existing Settings module** (§5.21). There is no second
 * feature-flag system: a module the plan does not include is one the settings
 * registry reports as unavailable, through the same chain everything else uses
 * — `Plan → Feature → Setting → Permission → Access`.
 */
export interface Entitlement {
  readonly state: LicenseState;
  /** Module codes this deployment is licensed for. Empty means "everything". */
  readonly modules: readonly string[];
  /** When the term ends, for the banner the owner sees. */
  readonly validUntil: Date | null;
}

export interface EntitlementProvider {
  /**
   * The deployment's current entitlement.
   *
   * **Never throws for a missing or invalid licence** (D-35: "Missing/invalid
   * license → READ_ONLY, never a crash, never data loss"). A shop whose licence
   * file was deleted must still be able to open SherERP and export its data.
   */
  current(now: Date): Entitlement;
}
