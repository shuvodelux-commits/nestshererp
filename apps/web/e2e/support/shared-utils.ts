import { createRequire } from 'node:module';

import type * as SharedUtils from '@sher/shared-utils';

/**
 * Playwright executes this E2E harness as ESM, but the shared-utils workspace
 * package is compiled to CommonJS for the NestJS API. Node cannot reliably
 * discover its named exports from TS-generated `Object.defineProperty` calls.
 *
 * Only this test harness needs the bridge. Keep the package's published
 * runtime format, application imports, and the test assertions unchanged.
 */
const sharedUtils = createRequire(import.meta.url)('@sher/shared-utils') as typeof SharedUtils;

export const SystemClock = sharedUtils.SystemClock;
export const addDays = sharedUtils.addDays;
