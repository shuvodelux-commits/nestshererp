import { z } from 'zod';

const ULID = z.string().length(26);
const BUSINESS_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * The Purchase Planner, the paper that goes to the supplier, and the costs that
 * arrive after the goods (Phase 8, §5.9, §5.12, owner decisions 2026-08-26).
 *
 * **Two documents, deliberately unequal.** The plan is the shop's own working
 * paper and carries cost, profit and margin. The supplier's order carries the
 * shop's pad, the supplier, the product, the quantity, a number and a date —
 * and nothing else, ever. That is not a display preference: the money fields do
 * not exist on the supplier response type at all, so no print template can grow
 * one by accident.
 *
 * **A plan posts nothing.** No lot, no movement, no payable, no journal entry,
 * and so no `Idempotency-Key` on any of these calls — there is no financial
 * write to make replay-safe. Stock and the supplier ledger happen when the plan
 * is converted and the ordinary purchase endpoint runs.
 */

export const planPrioritySchema = z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);
export type PlanPriorityValue = z.infer<typeof planPrioritySchema>;

/**
 * A plan is agreed or it is not (owner decision 2026-08-26).
 *
 * It replaced a status derived from what had been bought, because that answered
 * a question nobody was asking: the shopkeeper wants to know whether this plan
 * was *accepted*, and approving it is what produces the supplier orders.
 */
export const planStatusSchema = z.enum(['DRAFT', 'APPROVED', 'REJECTED']);
export type PlanStatusValue = z.infer<typeof planStatusSchema>;

/** A supplier order is Open until a bill is raised from it. */
export const supplierOrderStatusSchema = z.enum(['OPEN', 'CONVERTED', 'CANCELLED']);
export type SupplierOrderStatusValue = z.infer<typeof supplierOrderStatusSchema>;

/**
 * What the planner asks for. The two day-counts default from tenant settings
 * when the screen does not send them, so the first load needs no arguments.
 */
export const plannerQuerySchema = z
  .object({
    lookBackDays: z.coerce.number().int().min(1).max(365).optional(),
    coverDays: z.coerce.number().int().min(1).max(365).optional(),
    /** Poisha. Absent means no budget, which is not the same as a budget of nothing. */
    budgetMinor: z.coerce.number().int().nonnegative().optional(),
    supplierPartyId: ULID.optional(),
    search: z.string().trim().max(80).optional(),
    /** Hide everything already comfortable, which is most of a shop's catalogue. */
    needsOnly: z.coerce.boolean().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  })
  .strict();
export type PlannerQuery = z.infer<typeof plannerQuerySchema>;

/**
 * One product as the planner sees it.
 *
 * `unitCostMinor`, `sellingPriceMinor`, `investmentMinor` and
 * `expectedProfitMinor` are **absent** without `inventory.cost.view` (UI-40,
 * R-E8) — omitted from the body rather than blanked, so a screen that should
 * not show them cannot be made to.
 */
export const plannerRowResponseSchema = z
  .object({
    productId: ULID,
    displayName: z.string(),
    unitName: z.string(),
    supplierPartyId: ULID.nullable(),
    supplierName: z.string().nullable(),
    /** Where that supplier came from, so the screen can say why. */
    supplierSource: z.enum(['USUAL', 'HISTORY', 'NONE']),
    stockQty: z.number().int(),
    minStockQty: z.number().int(),
    soldQty: z.number().int(),
    sellingDays: z.number().int(),
    dailySalesQty: z.number().int(),
    coverDays: z.number().int().nullable(),
    pendingQty: z.number().int(),
    priority: planPrioritySchema,
    suggestedQty: z.number().int(),
    /** What the budget actually funds. Equals `suggestedQty` when there is none. */
    plannedQty: z.number().int(),
    partlyFunded: z.boolean(),
    /** False when the reorder level was used because history was too thin. */
    fromHistory: z.boolean(),
    packQty: z.number().int().nullable(),
    minOrderQty: z.number().int().nullable(),
    unitCostMinor: z.number().int().optional(),
    sellingPriceMinor: z.number().int().optional(),
    investmentMinor: z.number().int().optional(),
    expectedProfitMinor: z.number().int().optional(),
  })
  .strict();
export type PlannerRowResponse = z.infer<typeof plannerRowResponseSchema>;

/** The four figures across the top of the planner. Absent without cost permission. */
export const planTotalsResponseSchema = z
  .object({
    investmentMinor: z.number().int(),
    expectedSalesMinor: z.number().int(),
    expectedProfitMinor: z.number().int(),
    marginPercentHundredths: z.number().int(),
    budgetMinor: z.number().int().nullable(),
    unusedBudgetMinor: z.number().int().nullable(),
  })
  .strict();
export type PlanTotalsResponse = z.infer<typeof planTotalsResponseSchema>;

export const plannerResponseSchema = z
  .object({
    data: z.array(plannerRowResponseSchema),
    lookBackDays: z.number().int(),
    coverDays: z.number().int(),
    lineCount: z.number().int(),
    totals: planTotalsResponseSchema.optional(),
  })
  .strict();
export type PlannerResponse = z.infer<typeof plannerResponseSchema>;

export const purchasePlanLineRequestSchema = z
  .object({
    productId: ULID,
    /** What the shopkeeper decided, which may be neither the suggestion nor zero. */
    plannedQty: z.number().int().positive(),
    supplierPartyId: ULID.nullable().default(null),
  })
  .strict();
export type PurchasePlanLineRequest = z.infer<typeof purchasePlanLineRequestSchema>;

export const createPurchasePlanRequestSchema = z
  .object({
    notes: z.string().trim().max(500).nullable().default(null),
    lookBackDays: z.number().int().min(1).max(365),
    coverDays: z.number().int().min(1).max(365),
    budgetMinor: z.number().int().nonnegative().nullable().default(null),
    lines: z.array(purchasePlanLineRequestSchema).min(1).max(500),
    businessDate: BUSINESS_DATE.optional(),
  })
  .strict();
export type CreatePurchasePlanRequest = z.infer<typeof createPurchasePlanRequestSchema>;

/** Editing a saved plan replaces its lines wholesale — it posts nothing, so there is nothing to unwind. */
export const updatePurchasePlanRequestSchema = z
  .object({
    notes: z.string().trim().max(500).nullable().default(null),
    budgetMinor: z.number().int().nonnegative().nullable().default(null),
    lines: z.array(purchasePlanLineRequestSchema).min(1).max(500),
    version: z.number().int().nonnegative(),
  })
  .strict();
export type UpdatePurchasePlanRequest = z.infer<typeof updatePurchasePlanRequestSchema>;

export const purchasePlanLineResponseSchema = z
  .object({
    id: ULID,
    productId: ULID,
    displayName: z.string(),
    unitName: z.string(),
    supplierPartyId: ULID.nullable(),
    supplierName: z.string().nullable(),
    priority: planPrioritySchema,
    suggestedQty: z.number().int(),
    plannedQty: z.number().int(),
    /** Σ of posted purchase lines pointing at this one. Derived, never counted. */
    receivedQty: z.number().int(),
    remainingQty: z.number().int(),
    stockQty: z.number().int(),
    coverDays: z.number().int().nullable(),
    unitCostMinor: z.number().int().optional(),
    sellingPriceMinor: z.number().int().optional(),
  })
  .strict();
export type PurchasePlanLineResponse = z.infer<typeof purchasePlanLineResponseSchema>;

export const supplierOrderSummarySchema = z
  .object({
    id: ULID,
    orderNumber: z.string(),
    supplierPartyId: ULID,
    supplierName: z.string(),
    businessDate: BUSINESS_DATE,
    lineCount: z.number().int(),
  })
  .strict();

export const purchasePlanResponseSchema = z
  .object({
    id: ULID,
    planNumber: z.string(),
    notes: z.string().nullable(),
    status: planStatusSchema,
    lookBackDays: z.number().int(),
    coverDays: z.number().int(),
    budgetMinor: z.number().int().nullable(),
    businessDate: BUSINESS_DATE,
    lines: z.array(purchasePlanLineResponseSchema),
    orders: z.array(supplierOrderSummarySchema),
    totals: planTotalsResponseSchema.optional(),
    version: z.number().int(),
  })
  .strict();
export type PurchasePlanResponse = z.infer<typeof purchasePlanResponseSchema>;

export const purchasePlanListItemSchema = z
  .object({
    id: ULID,
    planNumber: z.string(),
    notes: z.string().nullable(),
    status: planStatusSchema,
    businessDate: BUSINESS_DATE,
    lineCount: z.number().int(),
    supplierCount: z.number().int(),
    investmentMinor: z.number().int().optional(),
    expectedProfitMinor: z.number().int().optional(),
    /** Carried because Approve, Reject and Delete act straight from the list (D-32). */
    version: z.number().int(),
  })
  .strict();

export const purchasePlanListQuerySchema = z
  .object({
    status: planStatusSchema.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export type PurchasePlanListQuery = z.infer<typeof purchasePlanListQuerySchema>;

export const purchasePlanListResponseSchema = z
  .object({ data: z.array(purchasePlanListItemSchema) })
  .strict();
export type PurchasePlanListResponse = z.infer<typeof purchasePlanListResponseSchema>;

/**
 * Agreeing a plan, or turning it down.
 *
 * Approving is the only thing that creates supplier orders — there is no
 * separate send step, because nothing is transmitted: an order is printed,
 * saved as a PDF or shared as an image (owner decision 2026-08-26).
 */
export const decidePlanRequestSchema = z
  .object({
    decision: z.enum(['APPROVED', 'REJECTED']),
    version: z.number().int().nonnegative(),
    businessDate: BUSINESS_DATE.optional(),
  })
  .strict();
export type DecidePlanRequest = z.infer<typeof decidePlanRequestSchema>;

/** One row of the Supplier Orders list. */
export const supplierOrderListItemSchema = z
  .object({
    id: ULID,
    orderNumber: z.string(),
    businessDate: BUSINESS_DATE,
    supplierPartyId: ULID,
    supplierName: z.string(),
    planId: ULID,
    planNumber: z.string(),
    itemCount: z.number().int(),
    totalQty: z.number().int(),
    status: supplierOrderStatusSchema,
    purchaseId: ULID.nullable(),
    purchaseNumber: z.string().nullable(),
  })
  .strict();
export type SupplierOrderListItem = z.infer<typeof supplierOrderListItemSchema>;

export const supplierOrderListResponseSchema = z
  .object({ data: z.array(supplierOrderListItemSchema) })
  .strict();
export type SupplierOrderListResponse = z.infer<typeof supplierOrderListResponseSchema>;

/**
 * The supplier's copy. **There is no cost, price, stock or profit field here,
 * and none may ever be added** — the owner's rule of 2026-08-26. A field that
 * does not exist cannot leak into a shared image.
 */
export const supplierPurchaseOrderResponseSchema = z
  .object({
    id: ULID,
    orderNumber: z.string(),
    businessDate: BUSINESS_DATE,
    supplierName: z.string(),
    supplierPhone: z.string().nullable(),
    supplierAddress: z.string().nullable(),
    shopName: z.string(),
    shopPhone: z.string().nullable(),
    shopAddress: z.string().nullable(),
    note: z.string().nullable(),
    status: supplierOrderStatusSchema,
    supplierPartyId: ULID,
    purchaseId: ULID.nullable(),
    purchaseNumber: z.string().nullable(),
    lines: z.array(
      z
        .object({
          lineNo: z.number().int(),
          /** Carried so Convert can seed the purchase; never drawn on the sheet. */
          productId: ULID,
          productName: z.string(),
          unitName: z.string(),
          qty: z.number().int(),
        })
        .strict(),
    ),
  })
  .strict();
export type SupplierPurchaseOrderResponse = z.infer<typeof supplierPurchaseOrderResponseSchema>;

// ------------------------------------------------------------- landed costs

export const landedCostCategorySchema = z.enum([
  'TRANSPORT',
  'LABOUR',
  'LOADING',
  'DELIVERY',
  'CUSTOMS',
  'OTHER',
]);
export type LandedCostCategoryValue = z.infer<typeof landedCostCategorySchema>;

export const landedCostMethodSchema = z.enum(['BY_VALUE', 'BY_QTY', 'MANUAL']);
export type LandedCostMethodValue = z.infer<typeof landedCostMethodSchema>;

/** A named cost carried on the bill itself, entered with it. */
export const landedCostLineRequestSchema = z
  .object({
    category: landedCostCategorySchema,
    method: landedCostMethodSchema,
    amountMinor: z.number().int().positive(),
    description: z.string().trim().max(300).nullable().default(null),
    manualAllocations: z
      .array(
        z.object({ lineIndex: z.number().int().nonnegative(), amountMinor: z.number().int().nonnegative() }).strict(),
      )
      .max(200)
      .default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.category === 'OTHER' && (value.description === null || value.description === '')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['description'], message: 'Description is required for Other' });
    }
  });
export type LandedCostLineRequest = z.infer<typeof landedCostLineRequestSchema>;

/**
 * A cost that turned up after the goods. This one **does** post money, so it
 * takes an `Idempotency-Key` like every other financial write.
 */
export const addLandedCostRequestSchema = z
  .object({
    category: landedCostCategorySchema,
    method: landedCostMethodSchema,
    amountMinor: z.number().int().positive(),
    /** Where the money went out of, or null to leave it owed to the supplier. */
    paidAccountCode: z.string().max(60).nullable().default(null),
    note: z.string().trim().max(300).nullable().default(null),
    description: z.string().trim().max(300).nullable().default(null),
    manualAllocations: z
      .array(
        z.object({ purchaseLineId: ULID, amountMinor: z.number().int().nonnegative() }).strict(),
      )
      .max(200)
      .default([]),
    businessDate: BUSINESS_DATE.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.category === 'OTHER' && (value.description === null || value.description === '')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['description'], message: 'Description is required for Other' });
    }
  });
export type AddLandedCostRequest = z.infer<typeof addLandedCostRequestSchema>;

export const landedCostResponseSchema = z
  .object({
    id: ULID,
    category: landedCostCategorySchema,
    method: landedCostMethodSchema,
    amountMinor: z.number().int(),
    inventoryShareMinor: z.number().int(),
    cogsShareMinor: z.number().int(),
    businessDate: BUSINESS_DATE,
    addedLater: z.boolean(),
    description: z.string().nullable().default(null),
    allocations: z.array(z.object({ purchaseLineId: ULID, amountMinor: z.number().int() }).strict()).default([]),
  })
  .strict();
export type LandedCostResponse = z.infer<typeof landedCostResponseSchema>;
