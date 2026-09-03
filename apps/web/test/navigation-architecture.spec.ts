import { describe, expect, it } from 'vitest';

import { resolveNavigation, SHER_NAVIGATION_ARCHITECTURE } from '../src/components/shell/navigation';

const allFeatures = () => SHER_NAVIGATION_ARCHITECTURE
  .flatMap((category) => category.subcategories)
  .flatMap((subcategory) => subcategory.features);

describe('navigation architecture', () => {
  it('has unique stable keys at category, subcategory and feature levels', () => {
    const categories = SHER_NAVIGATION_ARCHITECTURE.map((category) => category.id);
    const subcategories = SHER_NAVIGATION_ARCHITECTURE.flatMap((category) => category.subcategories.map((item) => item.id));
    const features = allFeatures().map((feature) => feature.id);
    expect(new Set(categories).size).toBe(categories.length);
    expect(new Set(subcategories).size).toBe(subcategories.length);
    expect(new Set(features).size).toBe(features.length);
    expect(features.every((id) => id.includes('.'))).toBe(true);
  });

  it('resolves only category and subcategory levels, keeping feature leaves inside hubs', () => {
    const resolved = resolveNavigation({ can: () => true, featureEnabled: () => true });
    // `inventory.warranty` arrived with Phase 8 (§5.19): a claim is about a
    // physical unit the shop is holding, so it hangs off Inventory rather than
    // becoming a category of its own.
    expect(resolved.find((category) => category.id === 'inventory')?.subcategories.map((item) => item.id)).toEqual([
      'inventory.products', 'inventory.reporting', 'inventory.warranty',
    ]);
    expect(resolved.flatMap((category) => category.subcategories).some((item) => 'features' in item)).toBe(false);
    /*
     * `sales` was a placeholder with no shipped route until Phase 6 gave it the
     * POS, the invoice list and the returns history, so it now resolves like any
     * other category. `finance` was the same kind of placeholder until Phase
     * 12.2 shipped its six screens, so the assertion that it stays absent has
     * become the assertion that it resolves to exactly those six — still the
     * thing that would notice an invented entry (UI-09).
     */
    expect(resolved.find((category) => category.id === 'sales')?.subcategories.map((item) => item.id)).toEqual([
      'sales.counter',
    ]);
    expect(resolved.find((category) => category.id === 'finance')?.subcategories.map((item) => item.id)).toEqual([
      'finance.overview', 'finance.accounts', 'finance.transfers',
      'finance.capital', 'finance.ledger', 'finance.reconciliation',
    ]);
  });

  it('hides empty subcategories and categories after permission and feature filtering', () => {
    const customerOnly = resolveNavigation({ can: (permission) => permission === 'party.customer.view' });
    expect(customerOnly.find((category) => category.id === 'parties')?.subcategories.map((item) => item.id)).toEqual(['customers.management']);
    // The customer ledger ships now, as a contextual leaf on the same hub
    // (§5.6 — it opens from a party, so it is named here without a route of
    // its own, exactly as stock adjustment is on Products).
    expect(customerOnly.find((category) => category.id === 'parties')?.subcategories[0]?.featureIds).toEqual(['parties.customers', 'parties.customer_ledger']);
    expect(customerOnly.find((category) => category.id === 'administration')).toBeUndefined();
    // Phase 18.1: `overview` is gone as a category — Dashboard moved inside
    // `daily`, which has no permission on it, so it is what every signed-in
    // person still resolves however little else they may read.
    expect(customerOnly.find((category) => category.id === 'daily')?.subcategories[0]?.id).toBe('daily.dashboard');
  });

  it('requires both vendor permission and the vendor feature flag', () => {
    const denied = resolveNavigation({ can: () => true });
    expect(denied.find((category) => category.id === 'parties')?.subcategories.some((item) => item.id === 'parties.vendors')).toBe(false);
    // The real §5.21 setting key. It used to read `vendors_enabled`, which no
    // setting has ever been called — so the tab could never appear however the
    // shop configured itself, and this test passed against the invented name.
    const allowed = resolveNavigation({ can: () => true, featureEnabled: (flag) => flag === 'vendor_management_enabled' });
    expect(allowed.find((category) => category.id === 'parties')?.subcategories.some((item) => item.id === 'parties.vendors')).toBe(true);
  });

  it('preserves every current signed-in route through a hub and does not resurrect LIFO or V1 tax', () => {
    const routes = new Set(allFeatures().flatMap((feature) => feature.route === undefined ? [] : [feature.route.split('?')[0]]));
    // `/import` is §5.6's guided onboarding import, added with path 2.4.
    // `/daily-cash` is Phase 4's, under `Daily` per UI-67. `/pos` and
    // `/sales` arrived with Phase 6, and `/sales-returns` with Phase 7 — a
    // history page, because a return is always taken from the invoice it comes
    // off. `/purchase-plans`, `/warranty` and `/vendor-stock` are Phase 8's
    // three. The six `/finance/*` routes are Phase 12.2's.
    //
    // **Two routes have ever been removed from this list, both deliberately.**
    //
    // `/settings/accounts` (owner decision 2026-08-31): Money Accounts moved to
    // `/finance/accounts` and the old path is now a redirect, not a menu entry.
    //
    // `/sync` (Phase 18.3, owner decision 2026-09-03): Sync folded into the
    // Offline page, which now claims `/sync` as one of its `activePrefixes` —
    // so the sidebar still lights up on it and the route is still reachable,
    // from a card on that page rather than from a menu entry of its own.
    //
    // Both keep every bookmark working, which is the thing this assertion
    // protects — a route silently *lost* still fails here, because it would be
    // reachable from nowhere at all.
    expect(routes).toEqual(new Set(['/dashboard', '/products', '/catalog', '/import', '/inventory-report', '/purchases', '/purchases/new', '/purchase-plans', '/warranty', '/vendor-stock', '/vendors/workspace', '/parties', '/daily-cash', '/counter', '/daybook', '/reports/sales', '/reports/purchases', '/reports/money', '/pos', '/sales', '/sales-returns', '/purchase-returns', '/expenses', '/stock-count', '/users', '/roles', '/audit', '/settings', '/finance', '/finance/accounts', '/finance/transfers', '/finance/capital-loans', '/finance/ledger', '/finance/reconciliation', '/settings/invoice-design', '/settings/periods', '/settings/backup', '/settings/license', '/settings/offline', '/settings/security']));
    expect(allFeatures().some((feature) => feature.label === 'LIFO')).toBe(false);
    expect(allFeatures().some((feature) => feature.label === 'Tax')).toBe(false);
  });
});
