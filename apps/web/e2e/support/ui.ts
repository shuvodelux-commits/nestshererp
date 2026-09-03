import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import type { Page } from '@playwright/test';
import { SystemClock } from '@sher/shared-utils';

import type { Baseline } from './seed';

/**
 * The few things every spec does (Phase 18.5).
 *
 * **Selectors follow what a shopkeeper sees** (owner decision 2026-09-03):
 * accessible roles and visible text, never a class name. A spec should break
 * when a screen becomes unusable, not when somebody renames a CSS class — and
 * because an element with no accessible name cannot be found this way at all,
 * the discipline doubles as an accessibility check on every screen it touches.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The day buttons, in both languages.
 *
 * Daily Cash labels its own primary action from `MONEY_BN` — the accessible
 * name really is `দিন শুরু করুন` and nothing else — while the dialog it opens
 * labels its footer from `MONEY_EN` (`Start day`). A spec matching only English
 * finds the dialog's button and never the one that opens it, which is exactly
 * how the first run of this suite failed.
 *
 * Matched rather than corrected: whether an Owner-facing screen should carry a
 * Bangla-only primary action is UI-14's question and the owner's to answer, and
 * Phase 18 was explicitly not allowed to change wording on adjacent screens.
 */
export const START_DAY = /Start day|দিন শুরু করুন/;
export const END_DAY = /End day|দিন শেষ করুন/;

/** What `global-setup` seeded, read back per worker process. */
export function baseline(): Baseline {
  return JSON.parse(readFileSync(resolve(HERE, '../.baseline.json'), 'utf8')) as Baseline;
}

/**
 * Go to a screen and wait for it to have finished loading its own data.
 *
 * Every one of these pages fetches reference data on mount — Counter loads the
 * customer and supplier lists, Expenses loads its categories — and a dialog
 * opened before that lands is a dialog with an empty dropdown in it. Two legs
 * of the daily flow failed exactly that way, intermittently, which is the worst
 * kind of failure to leave in a suite.
 */
export async function open(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.waitForLoadState('networkidle');
}

/**
 * Signs in through the real login form.
 *
 * The page opens on the PIN pad when this browser profile has signed in before,
 * so the password form is asked for explicitly rather than assumed — a spec
 * that assumed it passed on a cold profile and failed on the second run.
 */
export async function signIn(
  page: Page,
  person: { identifier: string; password: string },
): Promise<void> {
  await page.goto('/login');

  const usePassword = page.getByRole('button', { name: /use password/i });
  if (await usePassword.isVisible().catch(() => false)) await usePassword.click();

  await page.getByLabel(/mobile number or email/i).fill(person.identifier);
  await page.getByLabel(/^password$/i).fill(person.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();

  // Phase 18.1 made Daily the landing route, and Dashboard its first entry.
  await page.waitForURL(/\/dashboard/);
}

/**
 * Today, in the business timezone the server dates documents by.
 *
 * Through the `Clock` port like everything else — `new Date()` is legal in
 * exactly one file in this repository and `pnpm test:boundaries` fails the
 * build on any other use, test setup included. `businessDate` is also simply
 * the right answer: a sale at 00:30 in Dhaka belongs to that day, not to the
 * UTC day before it, and the server dates the document the same way.
 */
const clock = new SystemClock();

export function today(): string {
  return clock.businessDate('Asia/Dhaka');
}
