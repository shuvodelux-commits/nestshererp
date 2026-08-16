import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text'],
      // A bug in Money or Qty corrupts every number in the system, so their
      // coverage is a build gate, not a report (slice 0.2 acceptance criterion).
      thresholds: {
        'src/money.ts': { branches: 100, functions: 100, lines: 100, statements: 100 },
        'src/qty.ts': { branches: 100, functions: 100, lines: 100, statements: 100 },
      },
    },
  },
});
