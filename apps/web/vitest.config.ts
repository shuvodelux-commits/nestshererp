import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

/**
 * Component tests only (UI-44): renders, loading, error. Business assertions
 * live in the domain and integration suites, never here.
 */
export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'jsdom',
    include: ['test/**/*.spec.ts'],
  },
});
