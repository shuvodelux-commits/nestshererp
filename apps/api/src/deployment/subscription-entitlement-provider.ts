import type { Entitlement, EntitlementProvider } from '@sher/core-application';

/**
 * D-35's SaaS entitlement source.
 *
 * §5.4: "Full implementation is Phase 10; the `EntitlementService` interface
 * with a **permissive stub** exists from Phase 0." This is that stub, made
 * explicit at last — until plans and subscriptions exist there is nothing to
 * read, and every SaaS tenant is entitled to everything.
 *
 * It is deliberately a real implementation of the port rather than a special
 * case somewhere else. When Phase 10 adds plans, the change is this class
 * reading them; nothing that depends on entitlements has to move.
 *
 * `modules: []` means "everything" (see `Entitlement`) rather than a hard-coded
 * list that would silently exclude every module built after it was written.
 */
export class SubscriptionEntitlementProvider implements EntitlementProvider {
  /**
   * There is no subscription to read yet, so `now` is passed straight back as
   * the instant this was judged at. There is no licence either, which is why
   * `businessId` is null: the binding rule has nothing to bind to, and a SaaS
   * tenant is entitled by its subscription rather than by a key on a disk.
   */
  current(now: Date): Entitlement {
    return {
      state: 'ACTIVE',
      licensed: true,
      modules: [],
      validUntil: null,
      evaluatedAt: now,
      businessId: null,
      licenceId: null,
      clockBehindMs: 0,
    };
  }
}
