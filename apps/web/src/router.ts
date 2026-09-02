import { createRouter, createWebHistory } from 'vue-router';

import { useSession } from './auth/session';
import { GOOGLE_REDIRECT_PATH } from './auth/google';

/**
 * UI-13: every screen has a stable path and is reachable from navigation or
 * from a parent record.
 *
 * The guard is convenience, never the authority — every endpoint enforces its
 * own access server-side (R-D2). Routing someone away from a page they cannot
 * see is politeness; the API refusing them is the security.
 */
export const PUBLIC_ROUTES = new Set(['login', 'register', 'google-callback', 'forgot-password']);

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/dashboard' },
    { path: '/login', name: 'login', component: () => import('./pages/LoginPage.vue') },
    { path: '/register', name: 'register', component: () => import('./pages/RegisterPage.vue') },
    // Public by necessity: someone who has lost their password cannot sign in
    // to reach the page that resets it.
    {
      path: '/forgot-password',
      name: 'forgot-password',
      component: () => import('./pages/ForgotPasswordPage.vue'),
    },
    {
      path: GOOGLE_REDIRECT_PATH,
      name: 'google-callback',
      component: () => import('./pages/GoogleCallbackPage.vue'),
    },
    { path: '/dashboard', name: 'dashboard', component: () => import('./pages/DashboardPage.vue') },
    { path: '/users', name: 'users', component: () => import('./pages/UsersPage.vue') },
    { path: '/roles', name: 'roles', component: () => import('./pages/RolesPage.vue') },
    { path: '/audit', name: 'audit', component: () => import('./pages/AuditPage.vue') },
    // Phase 10 (§5.25, D-36). Both are Owner-only by permission; the sidebar
    // hides them for every other role, and the use cases refuse them anyway.
    {
      path: '/settings/backup',
      name: 'settings-backup',
      component: () => import('./pages/SettingsBackupPage.vue'),
    },
    {
      path: '/settings/license',
      name: 'settings-license',
      component: () => import('./pages/SettingsLicensePage.vue'),
    },
    /*
     * Phase 12.1 (§5.23, D-01, D-24). The page itself is open to anybody signed
     * in — a cashier must be able to read why this machine cannot work offline
     * — and every control on it is drawn only for whoever holds the code for
     * it. The storage check beneath it is the O-6 spike, and is Owner-only.
     */
    {
      path: '/settings/offline',
      name: 'settings-offline',
      component: () => import('./pages/SettingsOfflinePage.vue'),
    },
    {
      path: '/settings/offline/storage-check',
      name: 'settings-offline-storage-check',
      component: () => import('./pages/StorageCheckPage.vue'),
    },
    /*
     * Phase 12.4 (§15). Not under /settings: an outage that ends with three
     * documents refused is floor work for a manager during a shift, not
     * configuration, and burying it two levels down is how a queue stays full.
     */
    { path: '/sync', name: 'sync', component: () => import('./pages/SyncIssuesPage.vue') },
    { path: '/catalog', name: 'catalog', component: () => import('./pages/CatalogPage.vue') },
    { path: '/products', name: 'products', component: () => import('./pages/ProductsPage.vue') },
    // §5.10: per-product stock work lives on the Products row menu; what is
    // left here is the cross-product reporting. `/inventory` redirects because
    // it was a real route and somebody's bookmark should not 404.
    { path: '/inventory', redirect: '/inventory-report' },
    {
      path: '/inventory-report',
      name: 'inventory-report',
      component: () => import('./pages/InventoryReportPage.vue'),
    },
    // 'new' and an id share one component: adding and editing a product are the
    // same form, and a second one would be the same fields written twice.
    { path: '/products/:id', name: 'product', component: () => import('./pages/ProductFormPage.vue') },
    { path: '/parties', name: 'parties', component: () => import('./pages/PartiesPage.vue') },
    // Phase 5 — §5.9. `new` is its own path rather than `/purchases/:id`
    // with a magic id: a bill being typed is not a bill that exists, and the
    // detail page loads by id the moment it is opened.
    { path: '/purchases', name: 'purchases', component: () => import('./pages/PurchasesPage.vue') },
    {
      path: '/purchases/new',
      name: 'purchase-new',
      component: () => import('./pages/PurchaseFormPage.vue'),
    },
    {
      path: '/purchases/:id',
      name: 'purchase',
      component: () => import('./pages/PurchaseDetailPage.vue'),
    },
    /*
     * Phase 8 — §5.9, §5.19, §5.6 M07. The planner is its own path for the same
     * reason `purchases/new` is: a plan being worked out is not a plan that
     * exists, and the saved one loads by id.
     */
    {
      path: '/purchase-plans',
      name: 'purchase-plans',
      component: () => import('./pages/PurchasePlanPage.vue'),
    },
    {
      path: '/purchase-plans/:id',
      name: 'purchase-plan-detail',
      component: () => import('./pages/PurchasePlanDetailPage.vue'),
    },
    {
      path: '/supplier-orders/:id',
      name: 'supplier-order',
      component: () => import('./pages/SupplierOrderPage.vue'),
    },
    {
      path: '/warranty',
      name: 'warranty-claims',
      component: () => import('./pages/WarrantyClaimsPage.vue'),
    },
    {
      path: '/warranty/:id',
      name: 'warranty-claim',
      component: () => import('./pages/WarrantyClaimPage.vue'),
    },
    {
      path: '/vendor-stock',
      name: 'vendor-stock',
      component: () => import('./pages/VendorStockPage.vue'),
    },
    // Phase 8.3 — the vendor's own hub (§5.6 M07, UI-52). `?vendor=` keeps
    // which vendor is open in the URL, so the party list and a ledger row can
    // link straight into it.
    {
      path: '/vendors/workspace',
      name: 'vendor-workspace',
      component: () => import('./pages/VendorWorkspacePage.vue'),
    },
    // Phase 6 — §5.7, §5.8. The POS is its own full-screen path: a sale being
    // rung up is not a sale that exists, and the counter must not sit inside a
    // list it can navigate away from by accident.
    { path: '/pos', name: 'pos', component: () => import('./pages/PosPage.vue') },
    { path: '/sales', name: 'sales', component: () => import('./pages/SalesPage.vue') },
    { path: '/expenses', name: 'expenses', component: () => import('./pages/ExpensesPage.vue') },
    { path: '/settings/periods', name: 'periods', component: () => import('./pages/PeriodsPage.vue') },
    {
      path: '/stock-count',
      name: 'stock-count',
      component: () => import('./pages/StockCountPage.vue'),
    },
    {
      path: '/purchase-returns',
      name: 'purchase-returns',
      component: () => import('./pages/PurchaseReturnsPage.vue'),
    },
    {
      path: '/sales-returns',
      name: 'sales-returns',
      component: () => import('./pages/SalesReturnsPage.vue'),
    },
    {
      path: '/sales/:id',
      name: 'sale-detail',
      component: () => import('./pages/InvoiceDetailPage.vue'),
    },
    {
      path: '/settings/invoice-design',
      name: 'invoice-design',
      component: () => import('./pages/InvoiceSettingsPage.vue'),
    },
    // Phase 4 — §5.16.8's Daily Cash sits under `Daily` (UI-67); the account
    // setup screens sit under Settings (owner decision 2026-08-24), because a
    // till is configured once and the cashier's menu stays short.
    {
      path: '/daily-cash',
      name: 'daily-cash',
      component: () => import('./pages/DailyCashPage.vue'),
    },
    /*
     * The Finance module (§5.16, §5.17, owner decisions 2026-08-31).
     *
     * Six screens over the money that is already recorded: what the shop holds,
     * moving it between its own accounts, the owner's capital and the shop's
     * loans, each account's ledger, and checking an account against the bank.
     * Expenses and Daily Cash keep their own routes above — Finance links to
     * nothing it does not own.
     */
    { path: '/finance', name: 'finance', component: () => import('./pages/FinanceOverviewPage.vue') },
    {
      path: '/finance/accounts',
      name: 'money-accounts',
      component: () => import('./pages/MoneyAccountsPage.vue'),
    },
    {
      path: '/finance/transfers',
      name: 'money-transfers',
      component: () => import('./pages/TransferMoneyPage.vue'),
    },
    {
      path: '/finance/capital-loans',
      name: 'capital-loans',
      component: () => import('./pages/CapitalLoansPage.vue'),
    },
    /*
     * Two paths, one page. `/finance/ledger` is the menu entry and opens with
     * an account picker; `/finance/accounts/:id/ledger` is where a row on
     * Money Accounts or the Overview lands, already on that account. A ledger
     * always belongs to one account, and this is the difference between
     * arriving to choose one and arriving to read one.
     */
    {
      path: '/finance/ledger',
      name: 'account-ledger',
      component: () => import('./pages/AccountLedgerPage.vue'),
    },
    {
      path: '/finance/accounts/:id/ledger',
      name: 'account-ledger-for',
      component: () => import('./pages/AccountLedgerPage.vue'),
    },
    {
      path: '/finance/reconciliation',
      name: 'reconciliation',
      component: () => import('./pages/FinanceReconciliationPage.vue'),
    },
    /*
     * Phase 11 (§5.17, UI-70). A reconciliation is a workflow, not a one-task
     * modal: two lists to compare, a statement to import and a sign-off at the
     * end. It opens from the account, which is where the owner is standing when
     * they decide to check it against the bank.
     */
    {
      path: '/finance/accounts/:accountId/reconcile/:id',
      name: 'account-reconcile',
      component: () => import('./pages/AccountReconcilePage.vue'),
    },
    /*
     * The Settings addresses these screens used to live at. Kept as redirects
     * rather than deleted: a bookmark, a printed note or a link in a message
     * still lands on the screen the person meant, which costs three lines here
     * and would otherwise cost them a dead page.
     */
    { path: '/settings/accounts', redirect: '/finance/accounts' },
    {
      path: '/settings/accounts/:id/statement',
      redirect: (to) => `/finance/accounts/${String(to.params.id)}/ledger`,
    },
    {
      path: '/settings/accounts/:accountId/reconcile/:id',
      redirect: (to) =>
        `/finance/accounts/${String(to.params.accountId)}/reconcile/${String(to.params.id)}`,
    },
    // §5.6's guided onboarding import, one screen for every file type.
    { path: '/import', name: 'import', component: () => import('./pages/ImportPage.vue') },
    // 'new' and an id share one component: adding and editing a party are the
    // same form, and a second one would be the same fields written twice.
    { path: '/parties/:id', name: 'party', component: () => import('./pages/PartyFormPage.vue') },
    {
      path: '/parties/:id/ledger',
      name: 'party-ledger',
      component: () => import('./pages/PartyLedgerPage.vue'),
    },
    /*
     * Phase 9 — §5.20's four report screens and §5.27's Daybook.
     *
     * Stock has no route of its own: the Phase 3 Inventory Report **is** the
     * stock report and grew the two sales-derived sections (owner decision
     * 2026-08-30), so `/reports/stock` redirects to it rather than a second
     * screen answering the same question.
     */
    {
      path: '/reports/sales',
      name: 'reports-sales',
      component: () => import('./pages/SalesReportPage.vue'),
    },
    {
      path: '/reports/purchases',
      name: 'reports-purchases',
      component: () => import('./pages/PurchaseReportPage.vue'),
    },
    { path: '/reports/stock', redirect: '/inventory-report' },
    {
      path: '/reports/money',
      name: 'reports-money',
      component: () => import('./pages/MoneyReportPage.vue'),
    },
    { path: '/daybook', name: 'daybook', component: () => import('./pages/DaybookPage.vue') },
    /*
     * Phase 11.2 (§5.16, D-42, UI-53). Counter is a launcher: every button on
     * it opens a dialog that already exists, under that module's own
     * permission. It has a route of its own because it is a place a cashier
     * stands, not a task they finish.
     */
    { path: '/counter', name: 'counter', component: () => import('./pages/CounterPage.vue') },
    { path: '/settings', name: 'settings', component: () => import('./pages/SettingsPage.vue') },
    {
      path: '/settings/security',
      name: 'settings-security',
      component: () => import('./pages/SettingsSecurityPage.vue'),
    },
  ],
});

router.beforeEach((to) => {
  const { isSignedIn } = useSession();
  if (typeof to.name === 'string' && PUBLIC_ROUTES.has(to.name)) return true;
  return isSignedIn() ? true : { name: 'login' };
});

export default router;
