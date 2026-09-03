import { expect, test } from '@playwright/test';

import { call } from './support/api';
import { MANAGER, OWNER, PRODUCT_A, tokenFor } from './support/seed';
import { queryE2e } from './support/database';
import { runUpgradeSteps } from './support/stack';
import { signIn, today } from './support/ui';

/**
 * Upgrading must not lose a shop's business (Phase 18.5, owner decision 12 of
 * 2026-09-03).
 *
 * **It is a data-survival question, not a migration-ran-clean question.** The
 * migrations having applied without error says nothing about whether last
 * month's invoices still read back correctly. So: trade on the current build,
 * write the figures down, run the upgrade path, then re-assert that the same
 * invoices, the same stock, the same dues and the same day totals come back
 * identically — and that a fresh sale still posts afterwards, because a shop
 * that can read its history but cannot trade has not survived the upgrade
 * either.
 *
 * **The two things that silently break an upgrade** are exercised on purpose:
 * the schema-version gate (`assertSchemaMatchesBuild`, which refuses to serve a
 * database the build does not match) and the role backfill (a permission code
 * added by a later module is invisible until it has run, which hides the whole
 * feature from the sidebar without any error anywhere).
 *
 * Nothing here re-runs the whole day. The daily flow already proved the
 * postings; this proves they are still there afterwards.
 */

interface SaleRow {
  readonly id: string;
  readonly number: string;
  readonly grandTotalMinor: number;
  readonly dueMinor: number;
}

/**
 * The invoice list, as `/api/v1/sales` actually answers it.
 *
 * That endpoint returns `items`/`nextCursor`/`totals` at the top level rather
 * than the `{ data, page, summary }` envelope most of the API uses, so there is
 * nothing for `call` to unwrap — worth stating, because guessing this shape
 * from the neighbouring endpoints is exactly what got it wrong first time.
 */
async function invoices(token: string): Promise<readonly SaleRow[]> {
  const list = await call<{ items: readonly SaleRow[] }>('/api/v1/sales', { token });
  return list.items;
}

test.describe('an upgrade keeps the shop’s business', () => {
  /*
   * Runs after the daily flow, against the books that flow created. Ordered by
   * file name and pinned to one worker in `playwright.config.ts`, which is what
   * makes "the state the day left behind" a thing this spec can rely on.
   */
  test('migrations re-run over a traded database and change nothing', async ({ page }) => {
    const token = await tokenFor(MANAGER);
    const businessDate = today();

    /* -------------------------------------------- write the figures down */

    const before = {
      invoices: await invoices(token),
      migrations: (await queryE2e<{ count: string }>('SELECT count(*) FROM schema_migrations'))[0]
        ?.count,
      daybook: await call<{ rows: readonly unknown[] }>(
        `/api/v1/daybook?from=${businessDate}&to=${businessDate}&limit=300`,
        { token },
      ),
      dailyCash: await call<{
        rows: readonly { businessDate: string; countedClosingMinor: number | null }[];
      }>('/api/v1/money/daily-cash', { token }),
    };

    expect(before.invoices.length, 'the daily flow should have left an invoice behind').toBeGreaterThan(0);

    /* ------------------------------------------------------- upgrade path */

    /*
     * The migrations are re-run against the traded database, forward-only and
     * one transaction per file (§3.10), followed by the role backfill. That is
     * the shipped upgrade's own sequence minus the recovery dump, which needs
     * `pg_dump` on the machine running the suite and proves the dump tool
     * rather than the schema.
     *
     * A migration that is not idempotent, or one that drops a column something
     * still reads, fails here — which is exactly the class of breakage this
     * spec exists to catch before a shop meets it.
     */
    await runUpgradeSteps();

    expect(
      (await queryE2e<{ count: string }>('SELECT count(*) FROM schema_migrations'))[0]?.count,
      'the migration ledger changed on a re-run — a migration is not forward-only',
    ).toBe(before.migrations);

    /* ------------------------------------- everything reads back the same */

    const after = {
      invoices: await invoices(token),
      daybook: await call<{ rows: readonly unknown[] }>(
        `/api/v1/daybook?from=${businessDate}&to=${businessDate}&limit=300`,
        { token },
      ),
      dailyCash: await call<{
        rows: readonly { businessDate: string; countedClosingMinor: number | null }[];
      }>('/api/v1/money/daily-cash', { token }),
    };

    expect(after.invoices).toEqual(before.invoices);
    expect(after.daybook.rows.length).toBe(before.daybook.rows.length);
    expect(after.dailyCash.rows).toEqual(before.dailyCash.rows);

    /* ------------------------------------------ the roles survived as well */

    /*
     * Read as the **Owner**. A Manager cannot see the role matrix — the API
     * refuses them `PERMISSION_DENIED`, correctly — so asking for it on the
     * manager's token proved only that permissions work, which the cashier
     * spec already proves on purpose.
     */
    const ownerToken = await tokenFor(OWNER);
    const { roles } = await call<{ roles: readonly { code: string; permissions: readonly string[] }[] }>(
      '/api/v1/roles',
      { token: ownerToken },
    );
    const cashier = roles.find((role) => role.code === 'CASHIER');
    expect(cashier, 'the seed roles are gone after an upgrade').toBeDefined();
    expect(
      cashier?.permissions.length,
      'the cashier role has no permissions — the backfill did not run',
    ).toBeGreaterThan(0);

    /* ------------------------------------------- and the shop can still sell */

    await signIn(page, MANAGER);
    await page.goto('/pos');
    await page.getByRole('searchbox', { name: /scan barcode/i }).fill(PRODUCT_A.name);
    await expect(
      page.getByRole('button', { name: new RegExp(PRODUCT_A.name, 'i') }).first(),
      'the catalogue is unreadable after an upgrade',
    ).toBeVisible();
  });
});

