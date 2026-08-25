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
    expect(resolved.find((category) => category.id === 'inventory')?.subcategories.map((item) => item.id)).toEqual([
      'inventory.products', 'inventory.reporting',
    ]);
    expect(resolved.flatMap((category) => category.subcategories).some((item) => 'features' in item)).toBe(false);
    expect(resolved.find((category) => category.id === 'sales')).toBeUndefined();
    expect(resolved.find((category) => category.id === 'finance')).toBeUndefined();
  });

  it('hides empty subcategories and categories after permission and feature filtering', () => {
    const customerOnly = resolveNavigation({ can: (permission) => permission === 'party.customer.view' });
    expect(customerOnly.find((category) => category.id === 'parties')?.subcategories.map((item) => item.id)).toEqual(['customers.management']);
    // The customer ledger ships now, as a contextual leaf on the same hub
    // (§5.6 — it opens from a party, so it is named here without a route of
    // its own, exactly as stock adjustment is on Products).
    expect(customerOnly.find((category) => category.id === 'parties')?.subcategories[0]?.featureIds).toEqual(['parties.customers', 'parties.customer_ledger']);
    expect(customerOnly.find((category) => category.id === 'administration')).toBeUndefined();
    expect(customerOnly.find((category) => category.id === 'overview')).toBeDefined();
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
    // `/daily-cash` and `/settings/accounts` are Phase 4's money screens —
    // Daily Cash under `Daily` per UI-67, the account setup under Settings per
    // the owner's decision of 2026-08-24. `/pos` and `/sales` arrived with
    // Phase 6, and `/sales-returns` with Phase 7 — a history page, because a
    // return is always taken from the invoice it comes off. The list grows only
    // when a real implemented route ships; nothing is ever removed from it,
    // which is what makes a lost route fail here.
    expect(routes).toEqual(new Set(['/dashboard', '/products', '/catalog', '/import', '/inventory-report', '/purchases', '/purchases/new', '/parties', '/daily-cash', '/pos', '/sales', '/sales-returns', '/users', '/roles', '/audit', '/settings', '/settings/accounts', '/settings/security']));
    expect(allFeatures().some((feature) => feature.label === 'LIFO')).toBe(false);
    expect(allFeatures().some((feature) => feature.label === 'Tax')).toBe(false);
  });
});
