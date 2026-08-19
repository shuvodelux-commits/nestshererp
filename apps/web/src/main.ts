import 'primeicons/primeicons.css';
import './design/tokens.css';
import './design/components.css';

import PrimeVue from 'primevue/config';
import ConfirmationService from 'primevue/confirmationservice';
import ToastService from 'primevue/toastservice';
import Tooltip from 'primevue/tooltip';
import { createApp } from 'vue';

import App from './App.vue';
import { SherPreset } from './design/preset';
import { initTheme } from './design/theme';
import router from './router';

/**
 * PrimeVue 4 in styled mode, self-hosted (D-37, UI-03, UI-06). No CDN: §6.5
 * requires COOP/COEP on the app origin for SQLite WASM in Phase 12, and a
 * cross-origin asset breaks it.
 */

// Before mount, so a device set to dark never shows a white flash first.
initTheme();

createApp(App)
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
  .use(router)
  .mount('#app');
