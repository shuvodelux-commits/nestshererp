import { SettingKey } from '@sher/core-contracts';

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


/**
 * Only implemented, SRS-approved SherERP capabilities belong here. The
 * hierarchy organizes real routes; it is never a backlog or a reason to invent
 * one page per feature. Contextual leaves share their existing module hub.
 */
export const SHER_NAVIGATION_ARCHITECTURE: readonly SherNavigationCategory[] = [
  {
    id: 'overview', label: 'Overview', icon: 'pi-home', subcategories: [
      { id: 'overview.business', label: 'Overview', icon: 'pi-chart-bar', features: [
        feature('overview.dashboard', 'Dashboard', 'ব্যবসার সারসংক্ষেপ', 'Business summary and daily attention', '/dashboard'),
      ] },
    ],
  },
  {
    id: 'inventory', label: 'Inventory', icon: 'pi-warehouse', subcategories: [
      // §5.5: Products is the product working hub — stock adjustment, lots and
      // the opening figure are row actions on it, not separate destinations
      // (UI-56: a feature label does not imply a separate route).
      { id: 'inventory.products', label: 'Products', icon: 'pi-box', features: [
        feature('inventory.products.page', 'Products', 'পণ্য ও স্টক', 'Products with stock, adjustment and lots', '/products', ['catalog.product.view'], ['/products']),
        feature('inventory.stock.adjust', 'Stock Adjustment', 'স্টক ঠিক করুন', 'Correct stock for damage, recount or loss', '/products', ['catalog.product.edit'], ['/products'], false),
        feature('inventory.lots', 'Lots/Batch', 'কোন চালানের পণ্য', 'Trace stock by source batch', '/products', ['inventory.lot.view'], ['/products'], false),
        feature('inventory.import', 'Import Data', 'ফাইল থেকে তুলুন', 'Bring products, parties and opening stock in from a CSV file', '/import', ['catalog.product.create'], ['/import']),
        feature('inventory.catalog', 'Catalog Setup', 'ইউনিট, ব্র্যান্ড ও ক্যাটাগরি', 'Manage units, brands and categories', '/catalog', ['catalog.product.view'], ['/catalog']),
      ] },
      { id: 'inventory.reporting', label: 'Reports', icon: 'pi-chart-bar', features: [
        feature('inventory.report.page', 'Inventory Report', 'স্টকের হিসাব', 'Stock, low stock, movements, write-offs and valuation', '/inventory-report', ['catalog.product.view'], ['/inventory-report']),
        /*
         * The count sheet is a page of its own, not a dialog on the product:
         * one product at a time is Stock Adjustment, and the whole shelf is
         * this (§5.13, Phase 7).
         */
        feature('inventory.count', 'Stock Count', 'মাল গণনা', 'Count the shelf against the system and post the difference', '/stock-count', ['stock.count.post'], ['/stock-count']),
        feature('inventory.valuation', 'Stock Valuation', 'স্টকের হিসাব করা মূল্য', 'Reconcile stock value to the journal', '/inventory-report', ['inventory.cost.view'], ['/inventory-report'], false),
      ] },
      /*
       * §5.19. Warranty lives under Inventory because a claim is about a
       * physical unit the shop is holding — the serial that identifies it comes
       * from stock, and the replacement goes back out of stock. It is behind
       * its own §5.21 toggle, so a shop that sells nothing with a warranty
       * never sees it.
       */
      { id: 'inventory.warranty', label: 'Warranty', icon: 'pi-verified', features: [
        { ...feature('inventory.warranty.page', 'Warranty', 'ওয়ারেন্টি', 'Take faulty goods in, send them to the supplier and settle the claim', '/warranty', ['warranty.claim.view'], ['/warranty']), featureFlag: SettingKey.WARRANTY_ENABLED },
      ] },
    ],
  },
  {
    // UI-67: `Daily` is the first operational category. It resolves POS,
    // Counter, Daybook and Daily Cash as each one ships — only Daily Cash does
    // today, and an entry for the others would be the speculative placeholder
    // UI-09 refuses.
    id: 'daily', label: 'Daily', icon: 'pi-calendar', subcategories: [
      /*
       * Phase 9. UI-67 always reserved a place for Daybook here, and it is
       * filled now: the day's whole activity in one list, which is the screen
       * an owner opens at closing time.
       */
      /*
       * Phase 11.2. UI-67 reserved Counter's place here from the start and it
       * is filled now: the manual money a shop handles between sales, in one
       * screen, launching the dialogs that already own each action.
       *
       * `permissionMode: 'ANY'` because Counter is six actions and holding any
       * one of them is a reason to stand here — while a person holding none
       * would get a screen with a drawer figure and nothing to press, which is
       * exactly the dead surface UI-09 refuses.
       */
      { id: 'daily.counter', label: 'Counter', icon: 'pi-inbox', features: [
        {
          ...feature('daily.counter.page', 'Counter', 'কাউন্টার', 'Take money, pay money, record what the shop spent', '/counter', [
            'sale.payment.record',
            'purchase.payment.record',
            'expense.record',
            'cash.movement.record',
            'cash.session.start',
          ]),
          permissionMode: 'ANY' as const,
        },
      ] },
      { id: 'daily.daybook', label: 'Daybook', icon: 'pi-book', features: [
        feature('daily.daybook.page', 'Daybook', 'দিনের হিসাব', 'Everything that happened on a day, in the order it happened', '/daybook', ['daybook.view'], ['/daybook']),
      ] },
      { id: 'daily.cash', label: 'Daily Cash', icon: 'pi-wallet', features: [
        feature('daily.cash.page', 'Daily Cash', 'দিনের নগদ হিসাব', 'Expected against counted, day by day', '/daily-cash', ['cash.daily.view'], ['/daily-cash']),
        /*
         * Expenses sit under Daily, not Settings: rent and salary are things a
         * shop pays *on a day*, and the person recording one is the person
         * who just counted the drawer (Phase 7, §5.12).
         */
        feature('daily.expenses', 'Expenses', 'খরচ', 'Rent, salary, electricity — everything that is not stock', '/expenses', ['expense.view'], ['/expenses']),
      ] },
    ],
  },
  {
    // §5.7, §5.8: Sales is one business module — the counter, the invoices it
    // produced, how those invoices are printed, and what came back. `Sales
    // Return` is a **history** entry: a return is always taken from the invoice
    // it comes off (owner decision 2026-08-26), so this route reads and prints
    // them rather than offering a second way to create one.
    id: 'sales', label: 'Sales (POS)', icon: 'pi-shopping-bag', subcategories: [
      { id: 'sales.counter', label: 'Sales', icon: 'pi-receipt', features: [
        feature('sales.pos', 'POS — New Sale', 'নতুন বিক্রি', 'Sell at the counter and print the invoice', '/pos', ['sale.invoice.create'], ['/pos']),
        feature('sales.list', 'Sales Invoice', 'বিক্রির তালিকা', 'Every invoice, what is paid and what is owed', '/sales', ['sale.invoice.view'], ['/sales']),
        feature('sales.receive', 'Receive Payment', 'কাস্টমারের টাকা নিন', 'Take money against what a customer owes', '/sales', ['sale.payment.record'], ['/sales'], false),
        feature('sales.returns', 'Sales Return', 'বিক্রি ফেরত', 'What customers brought back, and where the money went', '/sales-returns', ['sales.return.view'], ['/sales-returns']),
      ] },
    ],
  },
  {
    // §5.9: Purchase is one business module with its own feature navigation.
    // `Purchase Return` is a **history** entry, like its sales twin: a return
    // is always sent from the bill the goods arrived on (owner decision
    // 2026-08-26), so this route reads and prints them.
    id: 'purchases', label: 'Purchases', icon: 'pi-shopping-cart', subcategories: [
      { id: 'purchases.bills', label: 'Purchases', icon: 'pi-receipt', features: [
        feature('purchases.list', 'Purchase Invoice', 'কেনার তালিকা', 'Every supplier bill, what is paid and what is owed', '/purchases', ['purchase.bill.view'], ['/purchases']),
        feature('purchases.new', 'New Purchase', 'নতুন মাল কেনা', 'Record goods received from a supplier', '/purchases/new', ['purchase.bill.create'], ['/purchases/new']),
        feature('purchases.plan', 'Purchase Plan', 'কেনার পরিকল্পনা', 'Work out what to buy, how much, and send the supplier an order', '/purchase-plans', ['purchase.plan.view'], ['/purchase-plans', '/supplier-orders']),
        feature('purchases.returns', 'Purchase Return', 'কেনা ফেরত', 'What went back to suppliers, and what they credited', '/purchase-returns', ['purchase.return.view'], ['/purchase-returns']),
        feature('purchases.pay', 'Pay Supplier', 'সরবরাহকারীকে টাকা দিন', 'Settle a supplier from cash or bank', '/purchases', ['purchase.payment.record'], ['/purchases'], false),
      ] },
    ],
  },
  {
    id: 'parties', label: 'Parties', icon: 'pi-users', alwaysGroup: true, subcategories: [
      { id: 'customers.management', label: 'Customers', icon: 'pi-user', features: [
        feature('parties.customers', 'Customers', 'কাস্টমারের তালিকা', 'Manage customers', '/parties?role=CUSTOMER', ['party.customer.view'], ['/parties']),
        { ...feature('parties.customer_groups', 'Customer Groups', 'কাস্টমারের গ্রুপ', 'Manage customer groups', '/parties?role=CUSTOMER', ['party.customer.view'], ['/parties'], false), featureFlag: SettingKey.CUSTOMER_GROUPS_ENABLED },
        // §5.6: a party's ledger is not a destination of its own. It opens from
        // the party and lives on that party's hub, so it is a contextual leaf
        // like stock adjustment on Products (UI-56) — named here because the
        // capability now ships, with no route of its own.
        feature('parties.customer_ledger', 'Customer Ledger', 'কাস্টমারের খতিয়ান', 'Review customer transactions and balance', '/parties?role=CUSTOMER', ['party.customer.view'], ['/parties'], false),
      ] },
      { id: 'parties.suppliers', label: 'Suppliers', icon: 'pi-truck', features: [
        feature('parties.suppliers', 'Suppliers', 'সরবরাহকারীর তালিকা', 'Manage suppliers', '/parties?role=SUPPLIER', ['party.supplier.view'], ['/parties']),
        feature('parties.supplier_ledger', 'Supplier Ledger', 'সরবরাহকারীর খতিয়ান', 'Review supplier transactions and balance', '/parties?role=SUPPLIER', ['party.supplier.view'], ['/parties'], false),
      ] },
      { id: 'parties.vendors', label: 'Vendors', icon: 'pi-briefcase', features: [
        { ...feature('parties.vendors', 'Vendors', 'ভেন্ডরের তালিকা', 'Manage enabled consignment vendors', '/parties?role=VENDOR', ['party.vendor.view'], ['/parties']), featureFlag: SettingKey.VENDOR_MANAGEMENT_ENABLED },
        { ...feature('parties.consignment', 'Consignment', 'ভেন্ডরের স্টক', 'Vendor-owned stock: what they left, what sold, what goes back', '/vendor-stock', ['vendor.stock.manage'], ['/vendor-stock']), featureFlag: SettingKey.VENDOR_CONSIGNMENT_ENABLED },
        { ...feature('parties.vendor_ledger', 'Vendor Ledger', 'ভেন্ডরের খতিয়ান', 'Review vendor transactions and payable', '/parties?role=VENDOR', ['party.vendor.view'], ['/parties'], false), featureFlag: SettingKey.VENDOR_MANAGEMENT_ENABLED },
      ] },
    ],
  },
  {
    /*
     * §5.20. Four screens, each with a Group By rather than one screen per
     * question (owner decision 2026-08-30) — Stock points at the Inventory
     * Report, which is the stock report and has been since Phase 3.
     */
    id: 'reports', label: 'Reports', icon: 'pi-chart-bar', subcategories: [
      { id: 'reports.sales', label: 'Sales Reports', icon: 'pi-shopping-bag', features: [
        feature('reports.sales.page', 'Sales Reports', 'বিক্রির হিসাব', 'What sold, by day, product, customer, staff, brand, category or payment', '/reports/sales', ['report.sales.view'], ['/reports/sales']),
      ] },
      { id: 'reports.purchases', label: 'Purchase Reports', icon: 'pi-shopping-cart', features: [
        feature('reports.purchases.page', 'Purchase Reports', 'কেনাকাটার হিসাব', 'What the shop bought, from whom, and how much is still owed', '/reports/purchases', ['report.purchase.view'], ['/reports/purchases']),
      ] },
      { id: 'reports.stock', label: 'Stock Reports', icon: 'pi-box', features: [
        feature('reports.stock.page', 'Stock Reports', 'স্টকের হিসাব', 'Stock, low stock, expiry, valuation, cost of goods sold and margin', '/inventory-report', ['report.stock.view'], ['/inventory-report']),
      ] },
      { id: 'reports.money', label: 'Money Reports', icon: 'pi-wallet', features: [
        feature('reports.money.page', 'Money Reports', 'টাকার হিসাব', 'Who owes the shop, what it owes, cash, bank, expenses and profit', '/reports/money', ['report.money.view'], ['/reports/money']),
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
      { id: 'settings.business', label: 'Business', icon: 'pi-building', features: [
        feature('settings.business.page', 'Settings', 'ব্যবসার সেটিংস', 'Business details and approved feature controls', '/settings', ['settings.setting.view'], ['/settings']),
      ] },
      /*
       * Closing a month is a Settings act, not a daily one: it is the shop
       * deciding its books for that month are final (§5.19, D-25). There is no
       * reopen, so it sits beside the other one-way switches rather than in a
       * workflow anybody runs at the counter.
       */
      { id: 'settings.periods', label: 'Months', icon: 'pi-calendar', features: [
        feature('settings.periods.page', 'Months', 'হিসাবের মাস', 'Close a month so nothing more can post into it', '/settings/periods', ['settings.setting.view'], ['/settings/periods']),
      ] },
      { id: 'settings.money', label: 'Money Accounts', icon: 'pi-wallet', features: [
        feature('settings.money.cash', 'Cash Accounts', 'ক্যাশ ও সিন্দুক', 'The till, the safe and any other cash box', '/settings/accounts', ['cash.account.view'], ['/settings/accounts']),
        { ...feature('settings.money.bank', 'Bank & bKash Accounts', 'ব্যাংক ও বিকাশ', 'Bank, bKash and Nagad accounts with their statements', '/settings/accounts', ['bank.account.view'], ['/settings/accounts'], false), featureFlag: SettingKey.BANK_ACCOUNTS_ENABLED },
        /*
         * Phase 11 (§5.17, UI-70). Reconciliation is an account hub workflow,
         * not a destination of its own: it opens from the account's statement,
         * like the party ledger opens from the party. Named here because the
         * capability now ships, with no route of its own.
         */
        feature('settings.money.reconcile', 'Account Reconciliation', 'ব্যাংকের সাথে মিলিয়ে দেখা', 'Check an account against the statement the bank produced', '/settings/accounts', ['bank.reconciliation.view'], ['/settings/accounts'], false),
      ] },
      { id: 'settings.invoice', label: 'Invoice Design', icon: 'pi-file', features: [
        feature('settings.invoice.design', 'Invoice Design', 'ইনভয়েসের ডিজাইন', 'What is printed on an invoice, and on which paper', '/settings/invoice-design', ['settings.setting.edit'], ['/settings/invoice-design']),
      ] },
      /*
       * Phase 10. Two entries an owner can find by reading one word — the whole
       * point for a low-literacy user, and why they are not folded into a
       * "System" subcategory somebody would have to decode first (owner
       * decision 2026-08-30). Reset Business Data is deliberately **not** here:
       * it is an action at the foot of the Backup page, where the person
       * pressing it has just been shown when the last good backup was taken.
       */
      { id: 'settings.backup', label: 'Backup', icon: 'pi-database', features: [
        feature('settings.backup.page', 'Backup', 'ব্যাকআপ', 'Take a copy of the whole business, or put one back', '/settings/backup', ['backup.export'], ['/settings/backup']),
      ] },
      { id: 'settings.license', label: 'Licence', icon: 'pi-key', features: [
        feature('settings.license.page', 'Licence', 'লাইসেন্স', 'How long this SherERP licence runs, and what it includes', '/settings/license', ['license.term.view'], ['/settings/license']),
      ] },
      { id: 'settings.security', label: 'Security', icon: 'pi-lock', features: [
        feature('settings.security.page', 'Password & PIN', 'পাসওয়ার্ড ও পিন', 'Manage password and PIN security', '/settings/security', [], ['/settings/security']),
      ] },
    ],
  },
];

/**
 * Which module a path belongs to, by the longest `activePrefix` that claims it.
 *
 * The shell uses this to decide how one screen replaces another: moving inside
 * a module is a sideways step and slides, moving between modules is a change of
 * place and cross-fades. Without it every navigation looked identical, so
 * stepping from Products to Catalog Setup — two pages of the same module — was
 * animated as heavily as leaving Inventory altogether.
 */
export function navigationModuleId(path: string): string {
  let best = { length: 0, id: '' };
  for (const category of SHER_NAVIGATION_ARCHITECTURE) {
    for (const subcategory of category.subcategories) {
      for (const item of subcategory.features) {
        for (const prefix of item.activePrefixes) {
          const matches = path === prefix || path.startsWith(`${prefix}/`);
          if (matches && prefix.length > best.length) best = { length: prefix.length, id: category.id };
        }
      }
    }
  }
  return best.id;
}

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
