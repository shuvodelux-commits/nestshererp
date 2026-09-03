/*
 * Coverage claims, read by `pnpm test:inventory` (owner request 2026-09-03).
 *
 * These are what this file is answerable for in the test matrix. A claim naming
 * something the inventory no longer contains fails the scan, so a screen renamed
 * out from under a test cannot leave the coverage report quietly overstating itself.
 *
 * @covers screen:daily-cash
 * @covers screen:dashboard
 * @covers screen:pos
 * @covers screen:products
 * @covers screen:sales
 */
import { expect, test, type Page } from '@playwright/test';

import { CASHIER, MANAGER, PRODUCT_A } from './support/seed';
import { signIn } from './support/ui';

/**
 * The eight daily screens on a phone (Phase 18.5, owner decision 11 of
 * 2026-09-03).
 *
 * **Usability, not pixels.** There are no screenshot baselines here on purpose:
 * they break on font rendering, get bulk-approved after the third false alarm,
 * and from that moment catch nothing at all. What is asserted instead is what a
 * shopkeeper would actually notice — that the page does not scroll sideways,
 * that the thing they came to press is reachable, that a dialog is inside the
 * screen, and that the numbers are visible rather than off the right-hand edge.
 *
 * **`inputmode` is asserted rather than typed into.** Playwright cannot open a
 * virtual keyboard, so a spec that claimed to test one would be lying. What it
 * can honestly check is the attribute the phone reads to decide which keyboard
 * to draw — which is the thing that was actually wrong (Phase 18.4 found every
 * amount box in the application asking for `numeric`, the keypad with no
 * decimal point on it).
 *
 * The full business day is deliberately **not** re-run here. It is the same
 * application and the same use cases; running it twice would double the suite
 * to prove the same postings a second time.
 */

/** The eight, as the owner named them. Customers and Suppliers are one screen. */
const DAILY_SCREENS = [
  { name: 'Dashboard', path: '/dashboard' },
  { name: 'Products', path: '/products' },
  { name: 'Customers', path: '/parties?role=CUSTOMER' },
  { name: 'Suppliers', path: '/parties?role=SUPPLIER' },
  { name: 'Purchases', path: '/purchases' },
  { name: 'Counter', path: '/counter' },
  { name: 'Daybook', path: '/daybook' },
  { name: 'Daily Cash', path: '/daily-cash' },
] as const;


/** Nothing may push the document wider than the screen it is drawn on. */
async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const { scrollWidth } = document.documentElement;
    return scrollWidth - window.innerWidth;
  });
}

test.describe('the daily screens on a phone', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, MANAGER);
  });

  for (const screen of DAILY_SCREENS) {
    test(`${screen.name} fits the screen and stays usable`, async ({ page }) => {
      await page.goto(screen.path);
      await page.waitForLoadState('networkidle');

      /*
       * One pixel of tolerance, not zero: a sub-pixel rounding difference in a
       * border is not a shopkeeper scrolling sideways to find the total, and a
       * guard that fires on it gets switched off within a week.
       */
      expect(
        await horizontalOverflow(page),
        `${screen.name} scrolls sideways on a phone`,
      ).toBeLessThanOrEqual(1);

      // The bottom navigation is the phone's way between modules and must not
      // be pushed off the bottom by the page above it.
      const bottomNav = page.getByRole('navigation', { name: /primary modules/i });
      await expect(bottomNav).toBeVisible();

      const box = await bottomNav.boundingBox();
      const viewport = page.viewportSize();
      expect(box, `${screen.name} lost its bottom navigation`).not.toBeNull();
      if (box !== null && viewport !== null) {
        expect(
          box.y + box.height,
          `${screen.name} pushed the bottom navigation off the screen`,
        ).toBeLessThanOrEqual(viewport.height + 1);
      }
    });
  }

  test('a list shows its money rather than hiding it off the right edge', async ({ page }) => {
    await page.goto('/products');
    await page.waitForLoadState('networkidle');

    /*
     * Phase 18.4 turned the daily lists into cards below 640px precisely
     * because the table put the selling price out of sight. This is that
     * decision, asserted: the figure is on the screen, inside the viewport.
     */
    const price = page.getByText(new RegExp(String(PRODUCT_A.priceMinor / 100))).first();
    await expect(price).toBeVisible();

    const box = await price.boundingBox();
    const viewport = page.viewportSize();
    if (box !== null && viewport !== null) {
      expect(box.x + box.width, 'the price is off the right-hand edge').toBeLessThanOrEqual(
        viewport.width + 1,
      );
    }
  });

  /*
   * Both of these open **Record expense**, and both used to open Daily Cash's
   * day dialog instead — which meant they quietly skipped on every full run,
   * because the desktop daily flow closes the day before the mobile project
   * starts and Daily Cash then offers neither Start nor End. Two tests that
   * verify the headline of slice 18.4 were reporting as skipped rather than as
   * passing, which is the failure mode a suite is least likely to be caught at.
   *
   * Record expense is always available to somebody who may record one, has no
   * dependence on the state of the day, and its amount box is the very
   * `AmountInput` 18.4 fixed.
   */
  async function openExpenseDialog(page: Page): Promise<void> {
    await page.goto('/expenses');
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: /record expense/i }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
  }

  test('a dialog opens inside the screen', async ({ page }) => {
    await openExpenseDialog(page);
    const dialog = page.getByRole('dialog');

    const box = await dialog.boundingBox();
    const viewport = page.viewportSize();
    expect(box).not.toBeNull();
    if (box !== null && viewport !== null) {
      expect(box.x, 'the dialog starts off the left of the screen').toBeGreaterThanOrEqual(-1);
      expect(box.x + box.width, 'the dialog runs off the right of the screen').toBeLessThanOrEqual(
        viewport.width + 1,
      );
    }
  });

  test('an amount box asks the phone for a keypad with a decimal point', async ({ page }) => {
    await openExpenseDialog(page);

    const amount = page.getByRole('dialog').getByRole('spinbutton', { name: /amount/i });
    await expect(amount).toBeVisible();

    // `decimal`, never `numeric`: money has a point in it, and `numeric` is the
    // keypad that does not offer one. Before 18.4 every amount box in SherERP
    // asked for `numeric`, so a cashier on a phone could not type ৳120.50.
    await expect(amount).toHaveAttribute('inputmode', 'decimal');
  });

  test('a search box asks for the search keyboard', async ({ page }) => {
    await page.goto('/products');
    await page.waitForLoadState('networkidle');

    const search = page.getByRole('searchbox', { name: /search products/i });
    await expect(search).toHaveAttribute('inputmode', 'search');
    await expect(search).toHaveAttribute('enterkeyhint', 'search');
  });

  test('the cashier can sell on a phone, end to end', async ({ page, context }) => {
    await context.clearCookies();
    await signIn(page, CASHIER);

    await page.goto('/pos');
    await page.waitForLoadState('networkidle');

    expect(await horizontalOverflow(page), 'POS scrolls sideways on a phone').toBeLessThanOrEqual(1);

    await page.getByRole('searchbox', { name: /scan barcode/i }).fill(PRODUCT_A.name);
    await page.getByRole('button', { name: new RegExp(PRODUCT_A.name, 'i') }).first().click();

    /*
     * Cash in full, the way a cashier actually does it: the `=` button fills
     * the payment row with exactly what is owed. The account is left alone —
     * POS preselects the shop's drawer, and a spec that opened that dropdown
     * would be asserting a cashier has to touch it.
     *
     * Leaving the box blank is **not** the same thing. Blank means "full due",
     * which makes it a credit sale, and a credit sale needs a named customer —
     * so `Complete Sale` stays correctly disabled and the test hangs on a
     * button the application is right to be withholding.
     */
    await page.getByRole('button', { name: /exact amount/i }).click();

    const complete = page.getByRole('button', { name: /complete sale/i }).first();
    await expect(complete, 'the Complete Sale button is not reachable on a phone').toBeVisible();
    await complete.click();
    await page.getByRole('dialog').getByRole('button', { name: /complete sale/i }).click();

    await expect(page.getByRole('dialog')).toBeHidden({ timeout: 15_000 });
  });
});
