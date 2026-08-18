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
  // No parameter: there is no subscription to read yet, so the instant is not
  // consulted. Phase 10 gives this a body that needs it.
  current(): Entitlement {
    return { state: 'ACTIVE', modules: [], validUntil: null };
  }
}
