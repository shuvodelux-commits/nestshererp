import 'primeicons/primeicons.css';
import './design/tokens.css';

import PrimeVue from 'primevue/config';
import { createApp } from 'vue';

import App from './App.vue';
import { SherPreset } from './design/preset';
import router from './router';

/**
 * PrimeVue 4 in styled mode, self-hosted (D-37, UI-03, UI-06). No CDN: §6.5
 * requires COOP/COEP on the app origin for SQLite WASM in Phase 12, and a
 * cross-origin asset breaks it.
 */
createApp(App)
  .use(PrimeVue, {
    theme: {
      preset: SherPreset,
      options: {
        // SherERP is a light application; the dark selector is disabled rather
        // than left on `system`, where a shop's OS setting would silently flip
        // the whole ERP to a theme nobody designed.
        darkModeSelector: '.sher-dark',
      },
    },
  })
  .use(router)
  .mount('#app');
