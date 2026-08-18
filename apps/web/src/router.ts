import { createRouter, createWebHistory } from 'vue-router';

import { useSession } from './auth/session';
import { GOOGLE_REDIRECT_PATH } from './auth/google';
import AuditPage from './pages/AuditPage.vue';
import DashboardPage from './pages/DashboardPage.vue';
import ForgotPasswordPage from './pages/ForgotPasswordPage.vue';
import GoogleCallbackPage from './pages/GoogleCallbackPage.vue';
import LoginPage from './pages/LoginPage.vue';
import RolesPage from './pages/RolesPage.vue';
import UsersPage from './pages/UsersPage.vue';
import RegisterPage from './pages/RegisterPage.vue';
import SettingsPage from './pages/SettingsPage.vue';
import SettingsSecurityPage from './pages/SettingsSecurityPage.vue';

/**
 * UI-13: every screen has a stable path and is reachable from navigation or
 * from a parent record.
 *
 * The guard is convenience, never the authority — every endpoint enforces its
 * own access server-side (R-D2). Routing someone away from a page they cannot
 * see is politeness; the API refusing them is the security.
 */
const PUBLIC_ROUTES = new Set(['login', 'register', 'google-callback', 'forgot-password']);

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/dashboard' },
    { path: '/login', name: 'login', component: LoginPage },
    { path: '/register', name: 'register', component: RegisterPage },
    // Public by necessity: someone who has lost their password cannot sign in
    // to reach the page that resets it.
    { path: '/forgot-password', name: 'forgot-password', component: ForgotPasswordPage },
    { path: GOOGLE_REDIRECT_PATH, name: 'google-callback', component: GoogleCallbackPage },
    { path: '/dashboard', name: 'dashboard', component: DashboardPage },
    { path: '/users', name: 'users', component: UsersPage },
    { path: '/roles', name: 'roles', component: RolesPage },
    { path: '/audit', name: 'audit', component: AuditPage },
    { path: '/settings', name: 'settings', component: SettingsPage },
    { path: '/settings/security', name: 'settings-security', component: SettingsSecurityPage },
  ],
});

router.beforeEach((to) => {
  const { isSignedIn } = useSession();
  if (typeof to.name === 'string' && PUBLIC_ROUTES.has(to.name)) return true;
  return isSignedIn() ? true : { name: 'login' };
});

export default router;
