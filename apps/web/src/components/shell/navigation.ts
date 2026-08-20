export interface SherNavigationFeature {
  readonly id: string;
  readonly label: string;
  readonly labelBn: string;
  readonly purpose: string;
  readonly status: 'LIVE' | 'PLANNED';
  readonly route?: string;
  readonly activePrefixes: readonly string[];
  readonly permissions: readonly string[];
  readonly permissionMode?: 'ANY' | 'ALL';
  readonly entitlement?: string;
  readonly featureFlag?: string;
  /** False when the capability is already inside its related hub page. */
  readonly sidebarTarget?: boolean;
}

export interface SherNavigationSubcategory {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  readonly features: readonly SherNavigationFeature[];
}

export interface SherNavigationCategory {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  readonly alwaysGroup?: boolean;
  readonly subcategories: readonly SherNavigationSubcategory[];
}

export interface ResolvedNavigationSubcategory {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  readonly route: string;
  readonly purpose: string;
  readonly activePrefixes: readonly string[];
  readonly featureIds: readonly string[];
}

export interface ResolvedNavigationCategory {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  readonly alwaysGroup: boolean;
  readonly subcategories: readonly ResolvedNavigationSubcategory[];
}

const feature = (
  id: string,
  label: string,
  labelBn: string,
  purpose: string,
  route: string,
  permissions: readonly string[] = [],
  activePrefixes: readonly string[] = [route.split('?')[0] ?? route],
  sidebarTarget = true,
): SherNavigationFeature => ({ id, label, labelBn, purpose, route, permissions, activePrefixes, sidebarTarget, status: 'LIVE' });

const planned = (id: string, label: string, labelBn: string, purpose: string): SherNavigationFeature => ({
  id, label, labelBn, purpose, status: 'PLANNED', permissions: [], activePrefixes: [],
});

/**
 * Only implemented, SRS-approved SherERP capabilities belong here. The
 * hierarchy organizes real routes; it is never a backlog or a reason to invent
 * one page per feature. Contextual leaves share their existing module hub.
 */
export const SHER_NAVIGATION_ARCHITECTURE: readonly SherNavigationCategory[] = [
  {
    id: 'overview', label: 'Overview', icon: 'pi-home', subcategories: [
      { id: 'overview.business', label: 'Business Overview', icon: 'pi-chart-bar', features: [
        feature('overview.dashboard', 'Dashboard', 'ব্যবসার সারসংক্ষেপ', 'Business summary and daily attention', '/dashboard'),
      ] },
    ],
  },
  {
    id: 'inventory', label: 'Inventory', icon: 'pi-warehouse', subcategories: [
      // §5.5: Products is the product working hub — stock adjustment, lots and
      // the opening figure are row actions on it, not separate destinations
      // (UI-56: a feature label does not imply a separate route).
      { id: 'inventory.products', label: 'Product Management', icon: 'pi-box', features: [
        feature('inventory.products.page', 'Products', 'পণ্য ও স্টক', 'Products with stock, adjustment and lots', '/products', ['catalog.product.view'], ['/products']),
        feature('inventory.stock.adjust', 'Stock Adjustment', 'স্টক ঠিক করুন', 'Correct stock for damage, recount or loss', '/products', ['catalog.product.edit'], ['/products'], false),
        feature('inventory.lots', 'Lots/Batch', 'কোন চালানের পণ্য', 'Trace stock by source batch', '/products', ['inventory.lot.view'], ['/products'], false),
        feature('inventory.catalog', 'Catalog Setup', 'ইউনিট, ব্র্যান্ড ও ক্যাটাগরি', 'Manage units, brands and categories', '/catalog', ['catalog.product.view'], ['/catalog']),
      ] },
      { id: 'inventory.reporting', label: 'Inventory Report', icon: 'pi-chart-bar', features: [
        feature('inventory.report.page', 'Inventory Report', 'স্টকের হিসাব', 'Stock, low stock, movements, write-offs and valuation', '/inventory-report', ['catalog.product.view'], ['/inventory-report']),
        feature('inventory.valuation', 'Stock Valuation', 'স্টকের হিসাব করা মূল্য', 'Reconcile stock value to the journal', '/inventory-report', ['inventory.cost.view'], ['/inventory-report'], false),
      ] },
    ],
  },
  {
    id: 'parties', label: 'Parties', icon: 'pi-users', alwaysGroup: true, subcategories: [
      { id: 'customers.management', label: 'Customers', icon: 'pi-user', features: [
        feature('parties.customers', 'Customers', 'কাস্টমারের তালিকা', 'Manage customers', '/parties?role=CUSTOMER', ['party.customer.view'], ['/parties']),
        { ...feature('parties.customer_groups', 'Customer Groups', 'কাস্টমারের গ্রুপ', 'Manage customer groups', '/parties?role=CUSTOMER', ['party.customer.view'], ['/parties'], false), featureFlag: 'customer_groups_enabled' },
        planned('parties.customer_ledger', 'Customer Ledger', 'কাস্টমারের খতিয়ান', 'Review customer transactions and balance'),
      ] },
      { id: 'parties.suppliers', label: 'Suppliers', icon: 'pi-truck', features: [
        feature('parties.suppliers', 'Suppliers', 'সরবরাহকারীর তালিকা', 'Manage suppliers', '/parties?role=SUPPLIER', ['party.supplier.view'], ['/parties']),
        planned('parties.supplier_ledger', 'Supplier Ledger', 'সরবরাহকারীর খতিয়ান', 'Review supplier transactions and balance'),
      ] },
      { id: 'parties.vendors', label: 'Vendors', icon: 'pi-briefcase', features: [
        { ...feature('parties.vendors', 'Vendors', 'ভেন্ডরের তালিকা', 'Manage enabled consignment vendors', '/parties?role=VENDOR', ['party.vendor.view'], ['/parties']), featureFlag: 'vendors_enabled' },
        planned('parties.consignment', 'Consignment', 'ভেন্ডরের স্টক', 'Review vendor-owned stock and sources'),
        planned('parties.vendor_ledger', 'Vendor Ledger', 'ভেন্ডরের খতিয়ান', 'Review vendor transactions and payable'),
      ] },
    ],
  },
  {
    id: 'administration', label: 'Administration', icon: 'pi-shield', subcategories: [
      { id: 'administration.access', label: 'Access Control', icon: 'pi-users', features: [
        feature('administration.users', 'Users', 'কর্মীদের অ্যাকাউন্ট', 'Manage staff accounts', '/users', ['user.account.view'], ['/users']),
        feature('administration.roles', 'Roles & Permissions', 'কার কী অনুমতি', 'Manage access roles and permissions', '/roles', ['user.role.view'], ['/roles']),
      ] },
      { id: 'administration.audit', label: 'Audit', icon: 'pi-history', features: [
        feature('administration.audit_log', 'Audit Trail', 'কে কী পরিবর্তন করেছে', 'Review who changed what', '/audit', ['audit.event.view'], ['/audit']),
      ] },
    ],
  },
  {
    id: 'settings', label: 'Settings', icon: 'pi-cog', subcategories: [
      { id: 'settings.business', label: 'Business Settings', icon: 'pi-building', features: [
        feature('settings.business.page', 'Settings', 'ব্যবসার সেটিংস', 'Business details and approved feature controls', '/settings', ['settings.setting.view'], ['/settings']),
      ] },
      { id: 'settings.security', label: 'Account Security', icon: 'pi-lock', features: [
        feature('settings.security.page', 'Password & PIN', 'পাসওয়ার্ড ও পিন', 'Manage password and PIN security', '/settings/security', [], ['/settings/security']),
      ] },
    ],
  },
];

export interface NavigationAccess {
  readonly can: (permission: string) => boolean;
  readonly hasEntitlement?: (entitlement: string) => boolean;
  readonly featureEnabled?: (feature: string) => boolean;
}

export function navigationFeatureAccessible(feature: SherNavigationFeature, access: NavigationAccess): boolean {
  if (feature.status !== 'LIVE' || feature.route === undefined) return false;
  if (feature.entitlement !== undefined && !access.hasEntitlement?.(feature.entitlement)) return false;
  if (feature.featureFlag !== undefined && !access.featureEnabled?.(feature.featureFlag)) return false;
  return (feature.permissionMode ?? 'ALL') === 'ANY'
    ? feature.permissions.length === 0 || feature.permissions.some(access.can)
    : feature.permissions.every(access.can);
}

/** Resolve permissions/features before the shell sees any navigation rows. */
export function resolveNavigation(access: NavigationAccess): readonly ResolvedNavigationCategory[] {
  return SHER_NAVIGATION_ARCHITECTURE.flatMap((category) => {
    const subcategories = category.subcategories.flatMap((subcategory) => {
      const features = subcategory.features.filter((item) => navigationFeatureAccessible(item, access));
      const first = features.find((item) => item.sidebarTarget !== false);
      const target = first?.route;
      if (target === undefined) return [];
      return [{
        id: subcategory.id,
        label: subcategory.label,
        icon: subcategory.icon,
        route: target,
        purpose: features.map((item) => `${item.label}: ${item.purpose}`).join(' · '),
        activePrefixes: [...new Set(features.flatMap((item) => item.activePrefixes))],
        featureIds: features.map((item) => item.id),
      }];
    });
    return subcategories.length === 0 ? [] : [{
      id: category.id,
      label: category.label,
      icon: category.icon,
      alwaysGroup: category.alwaysGroup ?? false,
      subcategories,
    }];
  });
}
