import { resolve } from 'node:path';

import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

/**
 * The vendor console.
 *
 * A **separate app from `apps/web`**, on a separate port, served from a
 * separate origin in production (`admin.<product-domain>`). Not a route inside
 * the shop's app behind a role: that would ship vendor screens in every
 * customer's browser bundle and blur the line between a shop's RBAC and the
 * vendor's, which §23 keeps deliberately apart.
 *
 * `/api/control` is proxied so the console and the control plane share an
 * origin in development — the same trick `apps/web` uses, for the same reasons:
 * no preflight to fail, and no address written into a tracked file.
 */
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@sher/control-contracts': resolve(__dirname, '../../packages/control-contracts/src/index.ts'),
    },
  },
  server: {
    port: 5175,
    proxy: { '/api': { target: 'http://127.0.0.1:3100', ws: true } },
  },
});
