import { createRouter, createWebHistory } from 'vue-router';

import { useSession } from './auth/session';
import DashboardPage from './pages/DashboardPage.vue';
import RegisterPage from './pages/RegisterPage.vue';

/**
 * UI-13: every screen has a stable path and is reachable from navigation.
 *
 * There is no `/login` yet — logging in is slice 1.2. Until it exists, a visitor
 * with no session lands on registration, and one with a session lands on the
 * dashboard.
 */
const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/dashboard' },
    { path: '/register', name: 'register', component: RegisterPage },
    { path: '/dashboard', name: 'dashboard', component: DashboardPage },
  ],
});

router.beforeEach((to) => {
  const { isSignedIn } = useSession();
  if (to.name !== 'register' && !isSignedIn()) return { name: 'register' };
  return true;
});

export default router;
