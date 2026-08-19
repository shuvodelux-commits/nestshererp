import { config } from '@vue/test-utils';
import PrimeVue from 'primevue/config';
import Tooltip from 'primevue/tooltip';

/** Component tests mount with the same PrimeVue runtime injection as the app. */
config.global.plugins = [PrimeVue];
config.global.directives = { tooltip: Tooltip };

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }),
});
