import { createRouter, createWebHistory } from 'vue-router';

import { useSession } from './auth/session';
import { GOOGLE_REDIRECT_PATH } from './auth/google';
import DashboardPage from './pages/DashboardPage.vue';
import GoogleCallbackPage from './pages/GoogleCallbackPage.vue';
import LoginPage from './pages/LoginPage.vue';
import RegisterPage from './pages/RegisterPage.vue';

/**
 * UI-13: every screen has a stable path and is reachable from navigation or
 * from a parent record.
 *
 * The guard is convenience, never the authority — every endpoint enforces its
 * own access server-side (R-D2). Routing someone away from a page they cannot
 * see is politeness; the API refusing them is the security.
 */
const PUBLIC_ROUTES = new Set(['login', 'register', 'google-callback']);

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/dashboard' },
    { path: '/login', name: 'login', component: LoginPage },
    { path: '/register', name: 'register', component: RegisterPage },
    { path: GOOGLE_REDIRECT_PATH, name: 'google-callback', component: GoogleCallbackPage },
    { path: '/dashboard', name: 'dashboard', component: DashboardPage },
  ],
});

router.beforeEach((to) => {
  const { isSignedIn } = useSession();
  if (typeof to.name === 'string' && PUBLIC_ROUTES.has(to.name)) return true;
  return isSignedIn() ? true : { name: 'login' };
});

export default router;
