import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end coverage of the daily workflow (Phase 18.5, owner decisions
 * 2026-09-03).
 *
 * **The only test files an agent may write in this repository.** `AGENTS.md`
 * R-0 §1 forbids them outright, with one exception — the owner asking in the
 * current conversation — and he did, explicitly, for Playwright, on 2026-09-03.
 * That authorisation covers Playwright specs and nothing else: no vitest suite
 * may be added alongside them.
 *
 * **Chromium and a phone, not three engines.** SherERP ships on one browser in
 * one shop. Two more engines would treble the run time to protect against a
 * rendering difference in a browser nobody using this product has.
 *
 * **No screenshot baselines.** They break on font rendering, get bulk-approved
 * after the third false alarm, and from that moment catch nothing. The mobile
 * project asserts what a shopkeeper would actually notice — nothing sliding off
 * the screen, the primary action reachable, the numbers visible.
 */
export default defineConfig({
  testDir: './e2e',
  /** A business day end to end is not a unit test; it takes as long as it takes. */
  timeout: 90_000,
  expect: { timeout: 10_000 },

  /*
   * One worker, deliberately. Every spec trades against one shop's books: two
   * running at once would each see the other's stock movements and cash, and
   * the exact-number assertions the owner asked for would become flaky rather
   * than wrong — which is worse, because a flaky suite gets ignored.
   */
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env['CI']),
  retries: 0,

  reporter: process.env['CI'] === undefined ? [['list']] : [['list'], ['html', { open: 'never' }]],

  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',

  use: {
    baseURL: process.env['E2E_WEB_URL'] ?? 'http://127.0.0.1:5273',
    /** Kept only for a failure: a passing run should leave nothing behind. */
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  /*
   * Vite only. The API is started by `global-setup` because the database has to
   * be reset and migrated before anything connects to it, and `VITE_API_TARGET`
   * points this server's `/api` proxy at the E2E API rather than the owner's
   * development one — which is what lets a suite run while he is driving the
   * app on 3000/5173.
   */
  webServer: {
    command: 'pnpm exec vite',
    url: process.env['E2E_WEB_URL'] ?? 'http://127.0.0.1:5273',
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      VITE_PORT: '5273',
      VITE_API_TARGET: process.env['E2E_API_URL'] ?? 'http://127.0.0.1:3100',
    },
  },

  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: /mobile-.*\.spec\.ts/,
    },
    {
      /*
       * A real phone profile, not a resized desktop window: `devices` brings the
       * touch flag and the device pixel ratio with it, and a layout guard that
       * runs without them is testing a narrow desktop.
       */
      name: 'mobile',
      use: { ...devices['Pixel 5'] },
      testMatch: /mobile-.*\.spec\.ts/,
      dependencies: ['desktop'],
    },
  ],
});
