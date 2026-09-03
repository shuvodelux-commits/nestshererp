import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

/**
 * Integration tests run against the real PostgreSQL `sher_test` database
 * (SRS 6.4 — never `sher_dev`, so a test run cannot wipe hand-entered data).
 *
 * File parallelism is off: these tests truncate shared tables.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@sher/shared-utils': resolve(__dirname, '../../packages/shared-utils/src/index.ts'),
      '@sher/core-contracts': resolve(__dirname, '../../packages/core-contracts/src/index.ts'),
      '@sher/core-domain': resolve(__dirname, '../../packages/core-domain/src/index.ts'),
      '@sher/core-application': resolve(__dirname, '../../packages/core-application/src/index.ts'),
      '@sher/adapter-postgres': resolve(__dirname, '../../packages/adapter-postgres/src/index.ts'),
    },
  },
  test: {
    fileParallelism: false,
    testTimeout: 30000,
    // Hooks are as slow as tests here: `beforeAll` runs migrations and
    // `beforeEach` truncates every table, against a database eleven spec files
    // are taking turns on. Left at the 10s default these flake under load.
    hookTimeout: 30000,
    env: {
      DATABASE_URL:
        process.env['TEST_DATABASE_URL'] ?? 'postgres://sher_app:sher_app_test@localhost:5432/sher_test',
      JWT_SECRET: 'test-secret-not-used-in-production',
      /*
       * Entitlement comes from a subscription here, said explicitly.
       *
       * Licence mode became the default on 2026-09-02, and it is the right
       * default for a shipped installation: no licence means READ_ONLY. These
       * specs are about business rules rather than entitlement, and under that
       * default every write in every file would be refused 423 by a deployment
       * that simply has no licence key — which says nothing about the rule
       * being tested. The licence's own behaviour is exercised against a real
       * signed key, not here.
       */
      ENTITLEMENT_SOURCE: 'subscription',
    },
  },
});
