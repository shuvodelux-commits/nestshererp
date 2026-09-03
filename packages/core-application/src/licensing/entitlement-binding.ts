import { ANY_BUSINESS, licenceIncludes } from '@sher/core-contracts';

import type { Entitlement } from '../ports/entitlement-provider';

/**
 * A licence is for one business, and only that business (owner decision
 * 2026-09-02).
 *
 * The install screen checks this before it writes anything, but that is not
 * where the rule has to hold: a key file can be dropped onto a machine by
 * anyone with a copy of somebody else's licence and access to the disk. So the
 * binding is re-checked wherever entitlement is *used* — the read-only guard
 * and the access-control step — and a licence naming another business is worth
 * exactly as much as no licence at all.
 *
 * `*` is the development wildcard: a key signed by a development signing key,
 * which the production build does not trust, so it cannot be a way in.
 */
export function licenseAppliesTo(businessId: string | null, tenantId: string | null): boolean {
  // No licence involved at all — the SaaS provider answers from a subscription.
  if (businessId === null) return true;
  if (businessId === ANY_BUSINESS) return true;
  if (tenantId === null) return true;
  return businessId === tenantId;
}

/**
 * The entitlement as it applies to this business.
 *
 * A foreign licence is reduced to the same floor D-35 gives a missing one:
 * READ_ONLY, no modules, no end date — reads, sign-in and backup export all
 * still work, and nothing new is written under a licence bought by somebody
 * else. `tenantId` is null on a request that has not been authenticated yet,
 * where the binding cannot be judged and authentication will refuse anyway.
 */
export function entitlementFor(entitlement: Entitlement, tenantId: string | null): Entitlement {
  if (licenseAppliesTo(entitlement.businessId, tenantId)) return entitlement;
  return {
    ...entitlement,
    state: 'READ_ONLY',
    licensed: false,
    modules: [],
    validUntil: null,
  };
}

/**
 * Whether this entitlement covers a licensable module.
 *
 * The one place that knows an empty `modules[]` means *everything* only when
 * there is a licence saying so. Without that distinction a machine with no
 * licence at all would report every module as bought, which is how a lapsed
 * shop would keep seeing screens it never paid for.
 */
export function entitlesModule(entitlement: Entitlement, code: string): boolean {
  return entitlement.licensed && licenceIncludes(entitlement.modules, code);
}
