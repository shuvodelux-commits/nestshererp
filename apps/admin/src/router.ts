import { createRouter, createWebHistory } from 'vue-router';

import { loadSession, session } from './api/session';
import AuditPage from './pages/AuditPage.vue';
import CustomerPage from './pages/CustomerPage.vue';
import CustomersPage from './pages/CustomersPage.vue';
import DeploymentsPage from './pages/DeploymentsPage.vue';
import InstallationPage from './pages/InstallationPage.vue';
import InstallationsPage from './pages/InstallationsPage.vue';
import KnownIssuesPage from './pages/KnownIssuesPage.vue';
import LicencesPage from './pages/LicencesPage.vue';
import LoginPage from './pages/LoginPage.vue';
import OverviewPage from './pages/OverviewPage.vue';
import ReleasesPage from './pages/ReleasesPage.vue';
import SupportPage from './pages/SupportPage.vue';
import SupportSessionPage from './pages/SupportSessionPage.vue';

/**
 * The console's routes (§25).
 *
 * The guard is a convenience, not a boundary: it stops an operator staring at
 * an empty screen after their session ends. Every route on the control plane
 * checks the operator's role itself, so a router that let someone through would
 * simply show them a page full of refusals.
 *
 * `meta.tenantName` is written by the pages that open a customer's context, and
 * `AppShell` renders it as the persistent banner. Kept on the route rather than
 * in a store so that navigating away clears it automatically — a stale banner
 * naming the wrong shop would be worse than none.
 */
const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', component: LoginPage, meta: { public: true } },
    { path: '/', component: OverviewPage },
    { path: '/customers', component: CustomersPage },
    { path: '/customers/:id', component: CustomerPage },
    { path: '/installations', component: InstallationsPage },
    { path: '/installations/:id', component: InstallationPage },
    { path: '/licences', component: LicencesPage },
    { path: '/releases', component: ReleasesPage },
    { path: '/deployments', component: DeploymentsPage },
    { path: '/known-issues', component: KnownIssuesPage },
    { path: '/support', component: SupportPage },
    { path: '/support/:id', component: SupportSessionPage },
    { path: '/audit', component: AuditPage },
  ],
});

router.beforeEach(async (to) => {
  if (to.meta['public'] === true) return true;
  if (session.operator === null) await loadSession();
  if (session.operator === null) return { path: '/login' };
  // An operator who has not finished enrolling a second factor can reach
  // nothing but the sign-in screen, which is where enrolment happens (§23).
  if (!session.operator.totpEnrolled) return { path: '/login' };
  return true;
});

export default router;
