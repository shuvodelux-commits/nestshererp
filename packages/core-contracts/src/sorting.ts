import { z } from 'zod';

/**
 * Caller-selected list sorting (§3.9, UI-46).
 *
 * Every column header in every list sorts when it is tapped — the model a shop
 * owner already knows from their phone's gallery and file apps — so the sort
 * column arrives from the client. That makes the **allow-list** the whole
 * safety story, and it lives here so the API and the Vue client cannot drift
 * into disagreeing about what is sortable.
 *
 * Two rules hold for every list in the system:
 *
 * 1. **A column name is never taken from the client as a string.** It is one of
 *    a closed enum per endpoint, mapped to a real column server-side. A free
 *    column name is an injection hole, and an unindexed one is a table scan on
 *    the busiest screen in the shop.
 * 2. **`id` is always the final tiebreaker, in the same direction as the sort.**
 *    Sorting by a non-unique column — stock, price, name — without one makes
 *    rows on a page boundary shuffle between pages: paging through low stock, a
 *    shopkeeper would see one product twice and miss another entirely. Keeping
 *    the tiebreaker in the sort's own direction is what lets the keyset cursor
 *    stay a single row-value comparison.
 */

export const sortDirectionSchema = z.enum(['ASC', 'DESC']);
export type SortDirection = z.infer<typeof sortDirectionSchema>;

/**
 * What the Products list may be ordered by (§5.5, §5.7).
 *
 * `purchasePrice` is on the list but is **permission-gated at the endpoint**:
 * purchase price is omitted from the response body without `inventory.cost.view`
 * (UI-40, R-E8), and letting a caller sort by a figure they may not read would
 * hand them the ordering — enough to rank every product by cost. The endpoint
 * refuses the sort rather than silently ignoring it, because a list that
 * quietly came back in a different order than asked is worse than a refusal.
 *
 * `stockQty` is deliberately absent until Phase 3: stock is the sum of movements
 * and there are no movements yet, so offering the header now would sort by a
 * column that does not exist.
 */
export const productSortSchema = z.enum([
  'name',
  'barcode',
  'categoryName',
  'unitName',
  'sellingPrice',
  'purchasePrice',
  'minStockQty',
  'status',
]);
export type ProductSort = z.infer<typeof productSortSchema>;

/** What the Customers / Suppliers / Vendors list may be ordered by (§5.6). */
export const partySortSchema = z.enum([
  'name',
  'phone',
  'groupName',
  'creditLimit',
  'status',
  /**
   * The INV-06 rollup, not a stored column — "who owes me most" is the first
   * question anyone asks of a customer list, and answering it by exporting the
   * page and sorting it by hand is how a shop loses track of its receivables.
   * The repository orders by the same subquery the row displays, so the sort
   * and the figure can never disagree.
   */
  'balance',
]);
export type PartySort = z.infer<typeof partySortSchema>;

/**
 * The direction a header starts in on its first tap.
 *
 * Text reads naturally A→Z, but a shopkeeper tapping a **number** wants the big
 * end first every time: the point of tapping `Reorder at` or `Credit limit` is
 * "what needs attention", which is the top of the list, not the bottom. Getting
 * this wrong means every user taps twice, forever.
 */
export function defaultDirectionFor(sort: ProductSort | PartySort): SortDirection {
  const numericOrRecency: readonly string[] = [
    'sellingPrice',
    'purchasePrice',
    'minStockQty',
    'creditLimit',
    // "Current Due (High to Low)" is the whole point of tapping it.
    'balance',
  ];
  return numericOrRecency.includes(sort) ? 'DESC' : 'ASC';
}
