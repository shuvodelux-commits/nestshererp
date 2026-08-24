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
    // Phase 4 — §5.16.8's Daily Cash sits under `Daily` (UI-67); the account
    // setup screens sit under Settings (owner decision 2026-08-24), because a
    // till is configured once and the cashier's menu stays short.
    {
      path: '/daily-cash',
      name: 'daily-cash',
      component: () => import('./pages/DailyCashPage.vue'),
    },
    {
      path: '/settings/accounts',
      name: 'money-accounts',
      component: () => import('./pages/MoneyAccountsPage.vue'),
    },
    {
      path: '/settings/accounts/:id/statement',
      name: 'account-statement',
      component: () => import('./pages/AccountStatementPage.vue'),
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
