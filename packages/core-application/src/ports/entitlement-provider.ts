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
  /**
   * Whether a usable licence stands behind this at all.
   *
   * It has to be said separately, because `modules: []` already means
   * *everything* — an unrestricted licence — and a deployment with **no**
   * licence would otherwise claim exactly that. False for a missing, unreadable
   * or forged key file, and for one issued to another business; true for a
   * verified licence and for the SaaS provider, which answers from a
   * subscription instead.
   */
  readonly licensed: boolean;
  /** Module codes this deployment is licensed for. Empty means "everything". */
  readonly modules: readonly string[];
  /** When the term ends, for the banner the owner sees. */
  readonly validUntil: Date | null;
  /**
   * The instant this was judged at — the monotonic licence clock, which is
   * never earlier than a time the machine has already seen (owner decision
   * 2026-09-02). Everything the screen says about days remaining is measured
   * from here, so a wound-back clock cannot make the term look longer.
   */
  readonly evaluatedAt: Date;
  /**
   * The business this licence was issued for, or null when entitlement did not
   * come from a licence at all (the SaaS provider). `*` is a development
   * licence, which matches any business on the machine.
   */
  readonly businessId: string | null;
  /** The installed licence's own id, for the audit trail and the support call. */
  readonly licenceId: string | null;
  /** How far this machine's clock reads behind what it has already seen, in ms. */
  readonly clockBehindMs: number;
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
