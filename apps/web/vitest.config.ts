import { resolve } from 'node:path';

import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

/**
 * Component tests only (UI-44): renders, loading, error. Business assertions
 * live in the domain and integration suites, never here.
 */
export default defineConfig({
  plugins: [vue()],
  // The same source-not-dist resolution as `vite.config.ts` and `tsconfig.json`.
  resolve: {
    alias: {
      '@sher/core-contracts': resolve(__dirname, '../../packages/core-contracts/src/index.ts'),
      '@sher/core-domain': resolve(__dirname, '../../packages/core-domain/src/index.ts'),
      '@sher/shared-utils': resolve(__dirname, '../../packages/shared-utils/src/index.ts'),
      '@sher/adapter-sqlite-wasm': resolve(
        __dirname,
        '../../packages/adapter-sqlite-wasm/src/index.ts',
      ),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.spec.ts'],
    setupFiles: ['./test/setup.ts'],
  },
});
