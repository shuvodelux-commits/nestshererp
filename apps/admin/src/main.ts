import 'primeicons/primeicons.css';
import './theme.css';

import { createApp } from 'vue';

import App from './App.vue';
import { loadSession } from './api/session';
import router from './router';

/**
 * The vendor console.
 *
 * The session is resolved **before** mounting, for the same reason `apps/web`
 * waits for its router: mounting first renders one frame of the wrong layout —
 * here, a flash of the whole console behind the sign-in form.
 *
 * No PrimeVue theme preset. This console is a handful of dense operational
 * tables for one or two people, and `theme.css` does the whole job in a file
 * somebody can read — a design system would be more to maintain than the screens
 * it dressed. The deliberate visual distance from the shop's ERP is the point
 * (owner decision 2026-09-03), and a shared preset would work against it.
 */
void loadSession()
  .then(() => router.isReady())
  .then(() => {
    createApp(App).use(router).mount('#app');
  });
