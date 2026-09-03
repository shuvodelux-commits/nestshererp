import { z } from 'zod';

/**
 * Global Search (Phase 18.1, owner decision 2026-09-03).
 *
 * One box at the top of every screen that answers the three questions a shop
 * actually asks a computer: *do we have this*, *who is this person*, and *where
 * is that paper*. It is a **read across what already exists** — the same
 * product ranking the counter uses, the same party rows the Parties list draws,
 * the same invoice and bill filters those two screens filter with. Nothing here
 * introduces a query the shop could not already run; it removes the need to
 * know which screen to run it on.
 *
 * **Two kinds of answer, never interleaved.** Records come back in these
 * groups; screen names (`Go to…`) are resolved on the client from the
 * navigation architecture it already holds, because a menu entry is not a row
 * in a database and a server round-trip to find one would be theatre. The
 * owner accepted the readability risk of a mixed palette on the condition that
 * the two halves stay visibly apart.
 *
 * **Permission-filtered by omission.** A caller without `party.supplier.view`
 * does not get an empty supplier group — they get no supplier group at all, so
 * the palette never advertises a category of answer they may not have.
 */

/** What a hit is, in the shopkeeper's terms rather than the table's. */
export const globalSearchKindSchema = z.enum([
  'PRODUCT',
  'CUSTOMER',
  'SUPPLIER',
  'VENDOR',
  'SALE',
  'PURCHASE',
]);
export type GlobalSearchKind = z.infer<typeof globalSearchKindSchema>;

export const globalSearchQuerySchema = z.object({
  /**
   * What was typed. Trimmed and length-capped: a search box is the easiest
   * place in an application to paste a megabyte into.
   */
  q: z.string().trim().min(1).max(80),
  /** Per group, not overall — five products and five customers, not five rows. */
  limit: z.coerce.number().int().min(1).max(10).optional(),
});
export type GlobalSearchQuery = z.infer<typeof globalSearchQuerySchema>;

/**
 * One answer.
 *
 * No route: where a hit opens is the client's business (R-B3 in spirit — the
 * application layer does not know the browser's URL scheme), and the palette
 * maps `kind` + `id` onto the route it already registered in `router.ts`.
 *
 * `amountMinor` is minor units like every other money field, and `null` for
 * the kinds that are not an amount — a product's price is not what a person
 * searching for it wants to be told first, and a party's balance is behind a
 * permission this endpoint deliberately does not evaluate.
 */
export const globalSearchHitSchema = z.object({
  kind: globalSearchKindSchema,
  id: z.string(),
  title: z.string(),
  /** The one line that tells two similar rows apart — a phone, a code, a name. */
  subtitle: z.string().nullable(),
  amountMinor: z.number().int().nullable(),
  /** Business date for a document, `null` for a product or a party. */
  date: z.string().nullable(),
});
export type GlobalSearchHit = z.infer<typeof globalSearchHitSchema>;

export const globalSearchGroupSchema = z.object({
  kind: globalSearchKindSchema,
  /** Already in the shopkeeper's words, so the palette prints it as it arrives. */
  label: z.string(),
  hits: z.array(globalSearchHitSchema),
});
export type GlobalSearchGroup = z.infer<typeof globalSearchGroupSchema>;

export const globalSearchResponseSchema = z.object({
  data: z.object({
    /** In the order the shop thinks: goods, people, paper. */
    groups: z.array(globalSearchGroupSchema),
  }),
});
export type GlobalSearchResponse = z.infer<typeof globalSearchResponseSchema>;
