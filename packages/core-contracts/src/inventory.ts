import { z } from 'zod';

const ULID = z.string().length(26);
const BUSINESS_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const recordOpeningStockRequestSchema = z
  .object({
    productId: ULID,
    qty: z.number().int().positive(),
    businessDate: BUSINESS_DATE.optional(),
    expiryDate: BUSINESS_DATE.nullable().default(null),
  })
  .strict();
export type RecordOpeningStockRequest = z.infer<typeof recordOpeningStockRequestSchema>;

export const openingStockResponseSchema = z.object({
  id: ULID, number: z.string(), productId: ULID, productName: z.string(),
  locationId: ULID, locationName: z.string(), qty: z.number().int(),
  unitCost: z.number().int().optional(), valueMinor: z.number().int().optional(),
  businessDate: BUSINESS_DATE, expiryDate: BUSINESS_DATE.nullable(),
}).strict();
export type OpeningStockResponse = z.infer<typeof openingStockResponseSchema>;

/**
 * Stock adjustment (§5.10) — the routine face of §5.13 reconciliation.
 *
 * `qtyDelta` is signed as the shopkeeper typed it: positive adds, negative
 * removes. The reason list is closed because the Damaged & Written-off report
 * groups by it, and free text cannot be grouped.
 */
export const stockAdjustmentReasonSchema = z.enum(['DAMAGE', 'RECOUNT', 'THEFT_LOSS', 'OTHER']);
export type StockAdjustmentReasonValue = z.infer<typeof stockAdjustmentReasonSchema>;

export const adjustStockRequestSchema = z
  .object({
    productId: ULID,
    qtyDelta: z.number().int(),
    reason: stockAdjustmentReasonSchema,
    note: z.string().trim().max(500).nullable().default(null),
    businessDate: BUSINESS_DATE.optional(),
  })
  .strict();
export type AdjustStockRequest = z.infer<typeof adjustStockRequestSchema>;

export const stockAdjustmentResponseSchema = z
  .object({
    id: ULID,
    number: z.string(),
    productId: ULID,
    productName: z.string(),
    locationId: ULID,
    locationName: z.string(),
    qtyDelta: z.number().int(),
    direction: z.union([z.literal('IN'), z.literal('OUT')]),
    qty: z.number().int(),
    reason: stockAdjustmentReasonSchema,
    note: z.string().nullable(),
    businessDate: BUSINESS_DATE,
    qtyOnHandAfter: z.number().int(),
    /** Absent without `inventory.cost.view` — omitted, not blanked (UI-40, R-E8). */
    valueMinor: z.number().int().optional(),
  })
  .strict();
export type StockAdjustmentResponse = z.infer<typeof stockAdjustmentResponseSchema>;

export const inventoryStockRowSchema = z.object({
  productId: ULID, productName: z.string(),
  productStatus: z.union([z.literal('ACTIVE'), z.literal('INACTIVE')]),
  baseUnitName: z.string(), tracksExpiry: z.boolean(),
  locationId: ULID.nullable(), locationName: z.string().nullable(),
  qtyOnHand: z.number().int(), minStockQty: z.number().int(),
  stockStatus: z.enum(['IN_STOCK', 'LOW_STOCK', 'ZERO_STOCK', 'NEGATIVE_STOCK']),
  valueMinor: z.number().int().optional(),
}).strict();
export type InventoryStockRow = z.infer<typeof inventoryStockRowSchema>;

export const inventoryMovementSchema = z.object({
  id: ULID, productId: ULID, productName: z.string(), locationName: z.string(),
  lotId: ULID.nullable(), qty: z.number().int(),
  direction: z.union([z.literal('IN'), z.literal('OUT')]), sourceType: z.string(),
  sourceId: ULID, sourceNumber: z.string(), businessDate: BUSINESS_DATE,
  createdAt: z.string(), unitCost: z.number().int().optional(),
}).strict();
export type InventoryMovement = z.infer<typeof inventoryMovementSchema>;

export const inventoryOverviewResponseSchema = z.object({
  stock: z.array(inventoryStockRowSchema), movements: z.array(inventoryMovementSchema),
}).strict();
export type InventoryOverviewResponse = z.infer<typeof inventoryOverviewResponseSchema>;

export const inventoryLotSortSchema = z.enum([
  'businessDate',
  'expiryDate',
  'qtyReceived',
  'qtyRemaining',
  'status',
]);
export type InventoryLotSort = z.infer<typeof inventoryLotSortSchema>;

/**
 * `productId` is optional so one query serves both readers: the Lots dialog on
 * a product row passes it, the Inventory Report's cross-product lot and expiry
 * sections leave it out. One query, one permission check, one sort contract —
 * a second endpoint would be the same SQL with a different name.
 */
export const inventoryLotsQuerySchema = z.object({
  productId: ULID.optional(),
  /** Report-only: lots carrying an expiry date, for the Expiry section. */
  expiringOnly: z.coerce.boolean().optional(),
  expiry: z.enum(["EXPIRED", "SOON", "MISSING"]).optional(),
  status: z.enum(['OPEN', 'CLOSED']).optional(),
  cursor: ULID.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  sort: inventoryLotSortSchema.default('businessDate'),
  direction: z.enum(['ASC', 'DESC']).default('DESC'),
}).strict();
export type InventoryLotsQuery = z.infer<typeof inventoryLotsQuerySchema>;

export const inventoryLotSchema = z.object({
  id: ULID,
  productId: ULID,
  productName: z.string(),
  locationId: ULID,
  locationName: z.string(),
  ownerType: z.enum(['OWNED', 'VENDOR']),
  sourceType: z.string(),
  sourceId: ULID,
  sourceNumber: z.string(),
  qtyReceived: z.number().int(),
  qtyRemaining: z.number().int(),
  expiryDate: BUSINESS_DATE.nullable(),
  status: z.enum(['OPEN', 'CLOSED']),
  businessDate: BUSINESS_DATE,
  purchaseUnitCost: z.number().int().optional(),
  actualUnitCost: z.number().int().optional(),
  landedCostTotal: z.number().int().optional(),
  valueMinor: z.number().int().optional(),
}).strict();
export type InventoryLot = z.infer<typeof inventoryLotSchema>;

export const expirySummarySchema = z
  .object({
    expiredCount: z.number().int(),
    expiredValueMinor: z.number().int().optional(),
    soonCount: z.number().int(),
    missingCount: z.number().int(),
    warnDays: z.number().int(),
  })
  .strict();
export type ExpirySummary = z.infer<typeof expirySummarySchema>;

export const setLotExpiryRequestSchema = z.object({ expiryDate: BUSINESS_DATE.nullable() }).strict();
export type SetLotExpiryRequest = z.infer<typeof setLotExpiryRequestSchema>;

export const inventoryLotPageSchema = z.object({
  data: z.array(inventoryLotSchema),
  page: z.object({ nextCursor: ULID.nullable(), hasMore: z.boolean() }).strict(),
  valuationMethod: z.enum(['FIFO', 'AVERAGE']),
  /** What the Expiry card's three filters hold. Absent on a per-product read. */
  expiry: expirySummarySchema.optional(),
}).strict();
export type InventoryLotPage = z.infer<typeof inventoryLotPageSchema>;

/**
 * The Inventory Report (§5.10) — the cross-product views that have no single
 * product to hang from. Per-product work lives on the Products row menu.
 *
 * Every figure here derives from stock movements and journal lines (INV-10).
 */
export const inventoryReportQuerySchema = z
  .object({
    fromDate: BUSINESS_DATE.optional(),
    toDate: BUSINESS_DATE.optional(),
    productId: ULID.optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  })
  .strict();
export type InventoryReportQuery = z.infer<typeof inventoryReportQuerySchema>;

export const stockAdjustmentRowSchema = z
  .object({
    id: ULID,
    number: z.string(),
    productId: ULID,
    productName: z.string(),
    locationName: z.string(),
    qtyDelta: z.number().int(),
    direction: z.union([z.literal('IN'), z.literal('OUT')]),
    qty: z.number().int(),
    reason: stockAdjustmentReasonSchema,
    note: z.string().nullable(),
    businessDate: BUSINESS_DATE,
    createdAt: z.string(),
    createdByName: z.string(),
    valueMinor: z.number().int().optional(),
  })
  .strict();
export type StockAdjustmentRow = z.infer<typeof stockAdjustmentRowSchema>;

export const costAdjustmentRowSchema = z
  .object({
    id: ULID,
    productId: ULID,
    productName: z.string(),
    reason: z.enum(['BACKDATE', 'EDIT', 'LANDED_COST', 'SYNC_TRUE_UP', 'NEGATIVE_STOCK_TRUE_UP']),
    documentRef: z.string(),
    amountMinor: z.number().int(),
    businessDate: BUSINESS_DATE,
  })
  .strict();
export type CostAdjustmentRow = z.infer<typeof costAdjustmentRowSchema>;

export const inventoryValuationRowSchema = z.object({
  productId: ULID,
  productName: z.string(),
  locationId: ULID,
  locationName: z.string(),
  qtyOnHand: z.number().int(),
  valueMinor: z.number().int(),
}).strict();
export type InventoryValuationRow = z.infer<typeof inventoryValuationRowSchema>;

export const inventoryValuationResponseSchema = z.object({
  method: z.enum(['FIFO', 'AVERAGE']),
  rows: z.array(inventoryValuationRowSchema),
  totalValueMinor: z.number().int(),
  inventoryAccountMinor: z.number().int(),
  differenceMinor: z.number().int(),
  reconciled: z.boolean(),
}).strict();
export type InventoryValuationResponse = z.infer<typeof inventoryValuationResponseSchema>;

/* ------------------------------------------------------ the count sheet */

/**
 * Counting the shelf against the system (§5.13, Phase 7).
 *
 * `systemQty` on a request line is what the sheet was drawn with; the server
 * re-reads live stock when Post is pressed and refuses anything that moved in
 * between, so the two figures together are what makes a recount possible.
 */
export const countLineRequestSchema = z
  .object({
    productId: ULID,
    countedQty: z.number().int().nonnegative(),
    systemQty: z.number().int(),
  })
  .strict();

export const postStockCountRequestSchema = z
  .object({
    scopeLabel: z.string().trim().max(120).default('All products'),
    note: z.string().trim().max(500).nullable().default(null),
    lines: z.array(countLineRequestSchema).min(1).max(2000),
    businessDate: BUSINESS_DATE.optional(),
    backdateReason: z.string().trim().max(300).nullable().default(null),
    /** Post against live stock for products that moved while counting. */
    acceptMoved: z.boolean().default(false),
  })
  .strict();

export type PostStockCountRequest = z.infer<typeof postStockCountRequestSchema>;

export const stockCountLineSchema = z
  .object({
    id: ULID,
    productId: ULID,
    productName: z.string(),
    unitName: z.string(),
    countedQty: z.number().int(),
    systemQty: z.number().int(),
    qtyDelta: z.number().int(),
    valueMinor: z.number().int(),
  })
  .strict();

export const stockCountSchema = z
  .object({
    id: ULID,
    number: z.string(),
    scopeLabel: z.string(),
    note: z.string().nullable(),
    businessDate: BUSINESS_DATE,
    lineCount: z.number().int(),
    differenceCount: z.number().int(),
    shortageValueMinor: z.number().int(),
    surplusValueMinor: z.number().int(),
    createdAt: z.string(),
    lines: z.array(stockCountLineSchema),
  })
  .strict();

export type StockCountResponse = z.infer<typeof stockCountSchema>;
