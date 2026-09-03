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
  /*
   * SQLite WASM loads its own `.wasm` relative to itself and must not be
   * rewritten by the dependency pre-bundler (Phase 12.1's storage check).
   */
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
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
  /**
   * `host: true` binds every interface, not just loopback, so the dev server is
   * reachable from a phone or a tablet on the shop's own wifi — the only way to
   * judge a screen a shopkeeper will actually use on a 6" display (UI-41).
   *
   * `/api` is **proxied** rather than called directly, which is what makes that
   * work without pinning an IP address anywhere. The browser asks the origin it
   * loaded the page from, so `apiBaseUrl` in `public/config.json` is empty and
   * the phone, the tablet and the desktop all reach the API the same way. Three
   * things fall out of that and all three matter: no CORS preflight exists to
   * fail, because there is only one origin; no LAN address is written into a
   * tracked file, so a new DHCP lease does not break the setup; and only port
   * 5173 has to cross the WSL boundary instead of two.
   */
  server: {
    port: Number(process.env['VITE_PORT'] ?? 5173),
    host: true,
    /*
     * Phase 18.5. The target is an environment variable with the same default
     * it has always had, so an ordinary `pnpm --filter @sher/web dev` is byte
     * for byte what it was. What it buys is that the Playwright run starts its
     * own API on its own port against `sher_e2e` and its own Vite in front of
     * it — so a suite can run while the owner is driving the development stack
     * on 3000/5173, and neither can see the other's data.
     */
    proxy: { '/api': { target: process.env['VITE_API_TARGET'] ?? 'http://127.0.0.1:3000' } },
  },
});
