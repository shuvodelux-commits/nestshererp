import { resolve } from 'node:path';

import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

/**
 * The shared packages are bundled from source, matching the `paths` in
 * `tsconfig.json` and the aliases in `vitest.config.ts`.
 *
 * Reading them from `dist/` instead would mean the app served in development
 * could be a build behind the contracts it is typechecked against.
 */
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@sher/core-contracts': resolve(__dirname, '../../packages/core-contracts/src/index.ts'),
      '@sher/core-domain': resolve(__dirname, '../../packages/core-domain/src/index.ts'),
      '@sher/shared-utils': resolve(__dirname, '../../packages/shared-utils/src/index.ts'),
    },
  },
  server: { port: 5173 },
});
