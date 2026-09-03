/*
 * Coverage claims, read by `pnpm test:inventory` (owner request 2026-09-03).
 *
 * These are what this file is answerable for in the test matrix. A claim naming
 * something the inventory no longer contains fails the scan, so a screen renamed
 * out from under a test cannot leave the coverage report quietly overstating itself.
 *
 * @covers screen:login
 * @covers workflow:permissions
 */
import { expect, test } from '@playwright/test';

import { E2eApiError, call } from './support/api';
import { CASHIER, tokenFor } from './support/seed';
import { signIn } from './support/ui';

/**
 * What a cashier may and may not do (Phase 18.5, owner decision 10 of
 * 2026-09-03).
 *
 * **Three layers, because a hidden button is a courtesy and the server is the
 * boundary.** A spec that only checked the sidebar would pass against a
 * wide-open API — the menu would be tidy and anybody who typed a URL or opened
 * the network tab could do as they liked. So this asserts, in order:
 *
 *   1. the sidebar draws only the categories a cashier holds rights in (UI-09);
 *   2. a forbidden route typed straight into the address bar is refused;
 *   3. a forbidden API call comes back `PERMISSION_DENIED` (R-D2).
 *
 * The third is the one that matters. The first two are politeness; the third is
 * the security, and it is checked against the same server the screens call.
 */

/** Administration is Owner/Manager work — a cashier never manages staff. */
const FORBIDDEN_ROUTE = '/users';

test.describe('a cashier is held to their permissions', () => {
  test('the sidebar draws only what they may open', async ({ page }) => {
    await signIn(page, CASHIER);

    const navigation = page.getByRole('navigation').first();

    // Daily is the first category and the landing route (Phase 18.1), and a
    // cashier is exactly the person it was put first for.
    await expect(navigation.getByText(/^Daily$/)).toBeVisible();

    // Administration holds Users and Roles. A cashier has neither, so the
    // whole category is absent rather than present-and-dead.
    await expect(navigation.getByText(/^Administration$/)).toBeHidden();
  });

  test('a forbidden route typed into the address bar is refused', async ({ page }) => {
    await signIn(page, CASHIER);
    await page.goto(FORBIDDEN_ROUTE);

    /*
     * Either the guard sends them away, or the screen loads and says no. Both
     * are honest answers and the application is allowed to pick; what would
     * fail this assertion is the staff list actually drawing, which is the
     * thing being guarded against.
     */
    const wasSentAway = !page.url().includes(FORBIDDEN_ROUTE);
    if (!wasSentAway) {
      await expect(
        page.getByText(/permission|not allowed|cannot/i).first(),
        'the staff list rendered for a cashier',
      ).toBeVisible();
    }
  });

  test('a forbidden API call is refused by the server', async () => {
    const token = await tokenFor(CASHIER);

    // Read of the staff list: not a write, not a trick — simply a thing this
    // role may not see. The refusal must come from the server, with the code
    // §5.26 defines, regardless of what any screen chose to draw.
    const refusal = await call('/api/v1/users', { token }).then(
      () => null,
      (cause: unknown) => cause,
    );

    expect(refusal, 'a cashier read the staff list').toBeInstanceOf(E2eApiError);
    expect((refusal as E2eApiError).code).toBe('PERMISSION_DENIED');
    expect((refusal as E2eApiError).status).toBe(403);
  });
});
