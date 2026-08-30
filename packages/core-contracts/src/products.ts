import { z } from 'zod';

import { productSortSchema, sortDirectionSchema } from './sorting';

/**
 * Products (Phase 2, path 2.2, §5.5).
 *
 * Money and quantity cross the wire as **integer minor units** with a `Minor`
 * suffix on money field names (§5.26) — never a float, never a formatted string.
 * Quantity is a scale-3 integer, named `Qty`.
 *
 * **Offer dates are tenant-local days, not instants.** A shopkeeper means "from
 * the 1st to the 7th", and §3.5 puts that conversion in the use case where the
 * tenant's timezone is known — never in SQL and never in the browser. The stored
 * columns are the instants §5.5 names (`offer_start_at`, `offer_end_at`); the
 * server converts in both directions and echoes the days back, so the client
 * never re-derives a date and can never be a day out.
 */
const ULID = z.string().length(26);
const BUSINESS_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

export const productStatusSchema = z.union([z.literal('ACTIVE'), z.literal('INACTIVE')]);
export type ProductStatusValue = z.infer<typeof productStatusSchema>;

export const discountTypeSchema = z.union([
  z.literal('FIXED_AMOUNT'),
  z.literal('PERCENTAGE'),
]);
export type DiscountTypeValue = z.infer<typeof discountTypeSchema>;

/**
 * The optional conversion a product may carry (D-10, D-41): one unit, and how
 * many base units it contains. `1 Pipe = 20 Feet` is `factorQty: 20000` at
 * scale 3.
 *
 * Absent on a product that does not use the feature, and every field is absent
 * together — half a rule is what turns a purchase of 5 Pipes into 5 Feet.
 */
export const productConversionSchema = z
  .object({
    unitId: ULID,
    unitName: z.string(),
    factorQty: z.number().int().positive(),
  })
  .strict();

export type ProductConversion = z.infer<typeof productConversionSchema>;

export const productResponseSchema = z
  .object({
    id: ULID,
    name: z.string(),
    /** §5.5: `Brand + Product Name` when a brand exists. Derived, never stored. */
    displayName: z.string(),
    brandId: ULID.nullable(),
    brandName: z.string().nullable(),
    categoryId: ULID.nullable(),
    categoryName: z.string().nullable(),
    /** The parent of `categoryId` when it is a subcategory, so the row reads in full. */
    parentCategoryName: z.string().nullable(),
    sku: z.string().nullable(),
    barcode: z.string().nullable(),
    description: z.string().nullable(),

    baseUnitId: ULID,
    baseUnitName: z.string(),
    sellingPriceMinor: z.number().int(),
    /**
     * **Absent** unless the caller holds `inventory.cost.view` (UI-40, §5.26:
     * "Cost not visible → the column is absent from the API response, not blank
     * or zero"). Optional in the schema for exactly that reason.
     */
    purchasePriceMinor: z.number().int().optional(),
    minStockQty: z.number().int(),
    status: productStatusSchema,

    defaultDiscountType: discountTypeSchema.nullable(),
    /** Poisha for `FIXED_AMOUNT`, hundredths of a percent for `PERCENTAGE`. */
    defaultDiscountValue: z.number().int().nullable(),
    offerEnabled: z.boolean(),
    offerPriceMinor: z.number().int().nullable(),
    offerStartDate: BUSINESS_DATE.nullable(),
    offerEndDate: BUSINESS_DATE.nullable(),
    /** Whether the promotion is live right now, decided server-side (§5.5). */
    offerLive: z.boolean(),

    hasImage: z.boolean(),
    tracksExpiry: z.boolean(),
    tracksSerial: z.boolean(),

    /**
     * `null` on an ordinary single-unit product, which is most of them. When it
     * is set, Purchase and POS offer two quantity boxes and stock reads back as
     * `5 Pipe + 5 Feet (105 Feet)` — but what is stored is always the base-unit
     * figure alone.
     */
    conversion: productConversionSchema.nullable(),

    /**
     * Stock on hand, in base units (§5.5 list column).
     *
     * Supplied by the read model rather than counted in Vue, and derived from
     * the same movements INV-02 checks — a product that has never been stocked
     * reads `0`, which is a fact, not a missing value.
     */
    stockQty: z.number().int(),
    /**
     * **Absent** without `inventory.cost.view`, like `purchasePriceMinor` — a
     * hidden column that still ships the number in the response body is the
     * leak UI-40 and R-E8 exist to catch.
     */
    stockValueMinor: z.number().int().optional(),
    /** Against the reorder level, decided server-side so two screens cannot disagree. */
    stockStatus: z.enum(['IN_STOCK', 'LOW_STOCK', 'ZERO_STOCK', 'NEGATIVE_STOCK']),
    /**
     * Whether any stock has ever moved for this product.
     *
     * One fact, two consequences, so they can never disagree: it is what makes
     * `Delete` become `Deactivate` (§3.6), and what closes the one-time opening
     * figure on the product form (§5.10). The server enforces both regardless;
     * this only decides what the UI offers.
     */
    hasStockHistory: z.boolean(),

    /** Phase 8: what the planner assumes, and what the supplier will sell. */
    usualSupplierId: ULID.nullable(),
    usualSupplierName: z.string().nullable(),
    minOrderQty: z.number().int().nullable(),
    warrantyMonths: z.number().int().nullable(),
    supplierWarrantyMonths: z.number().int().nullable(),

    /** Optimistic lock (D-32). Sent back on edit; a stale one is a 409. */
    version: z.number().int(),
  })
  .strict();

export type ProductResponse = z.infer<typeof productResponseSchema>;

/**
 * Counts for the summary tiles, from the same query as the rows.
 *
 * §2.7.I: "Every figure on a tile is derived from data already on the screen or
 * from the ledger". A paged list cannot count itself, so the server counts —
 * one source, so a tile can never disagree with its table.
 */
export const productSummarySchema = z
  .object({
    total: z.number().int(),
    active: z.number().int(),
    inactive: z.number().int(),
    /** Products with no barcode, which is what blocks scanning at the counter. */
    withoutBarcode: z.number().int(),
  })
  .strict();

export type ProductSummary = z.infer<typeof productSummarySchema>;

export const productListResponseSchema = z
  .object({
    data: z.array(productResponseSchema),
    page: z
      .object({ nextCursor: z.string().nullable(), hasMore: z.boolean() })
      .strict(),
    summary: productSummarySchema,
  })
  .strict();

export type ProductListResponse = z.infer<typeof productListResponseSchema>;

/**
 * List filters (§5.5 "Operations and search", §5.7 "Search filters").
 *
 * `search` covers product name, SKU, barcode and brand name — the four things a
 * shopkeeper actually types. `categoryId` accepts a category **or** a
 * subcategory: choosing a parent includes everything filed under it, which is
 * what a shopkeeper means by "show me Drinks".
 *
 * The stock-status filter §5.7 also lists is deliberately absent: stock does not
 * exist until Phase 3, and a filter over a table that is not there would either
 * lie or do nothing.
 */
export const productQuerySchema = z
  .object({
    search: z.string().trim().max(120).optional(),
    brandId: ULID.optional(),
    categoryId: ULID.optional(),
    status: productStatusSchema.optional(),
    /** Keyset cursor: the id of the last row of the previous page (§3.9). */
    cursor: ULID.optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    /** Which header was tapped, from the closed allow-list (UI-46). */
    sort: productSortSchema.optional(),
    direction: sortDirectionSchema.optional(),
  })
  .strict();

export type ProductQuery = z.infer<typeof productQuerySchema>;

/**
 * Prices always arrive **per base unit**. The form may let a shopkeeper type and
 * read them per conversion unit — `৳105.00/Pipe` rather than `৳5.25/Feet` — but
 * it converts before sending, so the server stores one meaning and every later
 * line total is computed from the same figure (D-41).
 */

/**
 * The mandatory field set is exactly §5.5's: name, base unit, both prices and the
 * reorder level. Everything else is optional, and G2.2 forbids making an optional
 * field mandatory because the column exists.
 *
 * Opening stock is **not** here. §5.5 has it default to `0` and says an
 * authorised opening entry goes "through the normal stock-opening service" —
 * which is Phase 3. Writing a stock figure from this form would bypass the
 * movement and journal that make it true.
 */
export const saveProductRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    baseUnitId: ULID,
    purchasePriceMinor: z.number().int().min(0),
    sellingPriceMinor: z.number().int().min(0),
    minStockQty: z.number().int().min(0),

    brandId: ULID.nullable(),
    categoryId: ULID.nullable(),
    sku: z.string().trim().max(60).nullable(),
    barcode: z.string().trim().max(60).nullable(),
    description: z.string().trim().max(2000).nullable(),

    defaultDiscountType: discountTypeSchema.nullable(),
    defaultDiscountValue: z.number().int().min(0).nullable(),
    offerEnabled: z.boolean(),
    offerPriceMinor: z.number().int().min(0).nullable(),
    offerStartDate: BUSINESS_DATE.nullable(),
    offerEndDate: BUSINESS_DATE.nullable(),

    tracksExpiry: z.boolean(),
    tracksSerial: z.boolean(),

    /** Both or neither (D-41). `factorQty` is a scale-3 quantity. */
    conversionUnitId: ULID.nullable(),
    conversionFactorQty: z.number().int().positive().nullable(),

    /**
     * Phase 8, all optional (owner decisions 2026-08-26).
     *
     * `usualSupplierId` is who the purchase planner assumes; left blank it falls
     * back to the supplier this product has most often been bought from
     * recently. `minOrderQty` is the smallest that supplier will sell, and a
     * blank one applies no minimum. The two warranty figures are months: the
     * customer's cover runs from the sale, the shop's from the delivery.
     */
    usualSupplierId: ULID.nullable().default(null),
    minOrderQty: z.number().int().positive().nullable().default(null),
    warrantyMonths: z.number().int().positive().max(600).nullable().default(null),
    supplierWarrantyMonths: z.number().int().positive().max(600).nullable().default(null),
  })
  .strict();

export type SaveProductRequest = z.infer<typeof saveProductRequestSchema>;

/** Editing carries the version it was read at (D-32). */
export const updateProductRequestSchema = saveProductRequestSchema
  .extend({ version: z.number().int().positive() })
  .strict();

export type UpdateProductRequest = z.infer<typeof updateProductRequestSchema>;

/**
 * Activate/deactivate is its own action endpoint (§5.26), not a PATCH on a status
 * field: it decides whether the product appears in every new sale and purchase
 * from that moment, and G2.3 keeps it independent of stock quantity.
 */
export const setProductStatusRequestSchema = z
  .object({ status: productStatusSchema })
  .strict();

export type SetProductStatusRequest = z.infer<typeof setProductStatusRequestSchema>;

/** What a generated barcode came back as (§5.5 "product barcode generation"). */
export const generatedBarcodeResponseSchema = z.object({ barcode: z.string() }).strict();
export type GeneratedBarcodeResponse = z.infer<typeof generatedBarcodeResponseSchema>;

/**
 * One optional product thumbnail (owner decision 2026-08-25).
 *
 * The browser resizes and compresses before it sends — a counter grid loads a
 * page of these at a time, and a phone camera's 4MB original has no business in
 * a POS tile. The cap here is the backstop, not the mechanism: 192KB of base64
 * is roughly a 140KB image, far above a 256px thumbnail and far below anything
 * that would slow the grid.
 */
export const saveProductImageRequestSchema = z
  .object({
    mime: z.union([z.literal('image/webp'), z.literal('image/jpeg'), z.literal('image/png')]),
    dataBase64: z.string().min(16).max(192 * 1024),
  })
  .strict();
export type SaveProductImageRequest = z.infer<typeof saveProductImageRequestSchema>;
