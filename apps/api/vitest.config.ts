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
      '@sher/core-application': resolve(__dirname, '../../packages/core-application/src/index.ts'),
      '@sher/adapter-postgres': resolve(__dirname, '../../packages/adapter-postgres/src/index.ts'),
    },
  },
  test: {
    fileParallelism: false,
    testTimeout: 30000,
    env: {
      DATABASE_URL:
        process.env['TEST_DATABASE_URL'] ?? 'postgres://sher_app:sher_app_test@localhost:5432/sher_test',
      JWT_SECRET: 'test-secret-not-used-in-production',
    },
  },
});
