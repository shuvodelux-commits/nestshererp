import 'primeicons/primeicons.css';
import './design/tokens.css';
import './design/components.css';
import './design/print.css';

import PrimeVue from 'primevue/config';
import ConfirmationService from 'primevue/confirmationservice';
import ToastService from 'primevue/toastservice';
import Tooltip from 'primevue/tooltip';
import { createApp } from 'vue';

import App from './App.vue';
import { SherPreset } from './design/preset';
import { initTheme } from './design/theme';
import { registerServiceWorker } from './offline/service-worker';
import router from './router';

/**
 * PrimeVue 4 in styled mode, self-hosted (D-37, UI-03, UI-06). No CDN: §6.5
 * requires COOP/COEP on the app origin for SQLite WASM in Phase 12, and a
 * cross-origin asset breaks it.
 */

// Before mount, so a device set to dark never shows a white flash first.
initTheme();

/*
 * Phase 12.1 (§5.23, D-24). The service worker is what makes the browser offer
 * "Install SherERP" — the first rung of the D-24 ladder — and what lets the app
 * shell open on a bad line. It never caches the API; see `public/sw.js`.
 */
registerServiceWorker();

const app = createApp(App)
  .use(PrimeVue, {
    theme: {
      preset: SherPreset,
      options: {
        // `.sher-dark` is set by `design/theme.ts` from the user's own choice.
        // Not `system`: a shop's OS setting must never flip the whole ERP to a
        // theme nobody in the shop chose.
        darkModeSelector: '.sher-dark',
      },
    },
  })
  .use(ConfirmationService)
  .use(ToastService)
  .directive('tooltip', Tooltip)
  .use(router);

/*
 * Mounted only once the router knows where it is. The shell and the sign-in
 * screen are different layouts, and mounting first means rendering one frame of
 * the wrong one before the first route resolves — a flash of the whole ERP
 * behind the login form.
 */
void router.isReady().then(() => app.mount('#app'));
