import { z } from 'zod';

import { landedCostLineRequestSchema, landedCostResponseSchema } from './purchase-plans';

/**
 * Buying goods (Phase 5, §5.9, §5.11).
 *
 * Money crosses the wire as **integer minor units** with a `Minor` suffix
 * (§5.26, R-C2) — poisha, never a decimal taka — and quantities at scale 3.
 *
 * Nothing here carries a computed total *in*. §2.4 and DR13.12 both say the
 * server recomputes: a client sends the lines, the discount, the extra cost and
 * what was paid, and every figure on the way back was worked out here.
 */
const ULID = z.string().length(26);
const BUSINESS_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** `CASH:01J…` or `BANK:01J…` — validated properly in the use case (§2.4). */
const ACCOUNT_CODE = z.string().min(3).max(40);

export const purchaseLineRequestSchema = z
  .object({
    productId: ULID,
    qty: z.number().int().positive(),
    unitPriceMinor: z.number().int().nonnegative(),
    /** Only meaningful for a product that tracks expiry; optional either way. */
    expiryDate: BUSINESS_DATE.nullable().default(null),
    /**
     * The plan line this quantity is buying (Phase 8, §5.9).
     *
     * Null on an ordinary typed bill, which is most of them. When it is set,
     * how much of that plan has been bought becomes a SUM over posted purchase
     * lines — so voiding this bill simply makes the plan right again, with no
     * counter to unwind.
     */
    planLineId: ULID.nullable().default(null),
  })
  .strict();
export type PurchaseLineRequest = z.infer<typeof purchaseLineRequestSchema>;

/**
 * Recording a bill.
 *
 * `dueDate` is optional (owner decision 2026-08-24) — §5.9 asks for one on every
 * credit purchase, and the owner chose a blank box typed only when the supplier
 * actually named a day. A bill with no due date is unpaid but never overdue.
 */
export const createPurchaseRequestSchema = z
  .object({
    supplierPartyId: ULID,
    supplierBillRef: z.string().trim().max(64).nullable().default(null),
    businessDate: BUSINESS_DATE.optional(),
    dueDate: BUSINESS_DATE.nullable().default(null),
    lines: z.array(purchaseLineRequestSchema).min(1).max(200),
    discountMinor: z.number().int().nonnegative().default(0),
    /** Repeatable named landed costs. `extraCostMinor` remains for old clients. */
    landedCosts: z.array(landedCostLineRequestSchema).max(50).default([]),
    extraCostMinor: z.number().int().nonnegative().default(0),
    paidMinor: z.number().int().nonnegative().default(0),
    paidAccountCode: ACCOUNT_CODE.nullable().default(null),
    notes: z.string().trim().max(500).nullable().default(null),
    /**
     * The bill this one replaces (§2.5, Phase 7). Set by `Edit` on a posted
     * bill: the original is reversed and this one takes its number. Null is an
     * ordinary new purchase, which is what every existing caller sends.
     */
    correctionOf: ULID.nullable().default(null),
    /**
     * The supplier order this bill was raised from (Phase 8, §5.9).
     *
     * Set when the shopkeeper pressed Convert. The order becomes CONVERTED and
     * names this bill, so "what did we order and did it come" and "what was
     * this bill against" are both answerable afterwards.
     */
    supplierOrderId: ULID.nullable().default(null),
  })
  .strict();
export type CreatePurchaseRequest = z.infer<typeof createPurchaseRequestSchema>;

export const purchaseLineResponseSchema = z
  .object({
    id: ULID,
    productId: ULID,
    productName: z.string(),
    unitName: z.string(),
    qty: z.number().int(),
    expiryDate: BUSINESS_DATE.nullable(),
    lotId: ULID,
    /* Cost, and therefore absent without `inventory.cost.view` (UI-40, R-E8). */
    unitPriceMinor: z.number().int().optional(),
    lineTotalMinor: z.number().int().optional(),
    discountShareMinor: z.number().int().optional(),
    extraCostShareMinor: z.number().int().optional(),
    actualUnitCost: z.number().int().optional(),
  })
  .strict();
export type PurchaseLineResponse = z.infer<typeof purchaseLineResponseSchema>;

export const purchaseResponseSchema = z
  .object({
    id: ULID,
    number: z.string(),
    /** D-32 optimistic locking: what a cancel or correction must send back. */
    version: z.number().int(),
    supplierPartyId: ULID,
    supplierName: z.string(),
    supplierBillRef: z.string().nullable(),
    businessDate: BUSINESS_DATE,
    dueDate: BUSINESS_DATE.nullable(),
    status: z.union([z.literal('POSTED'), z.literal('VOIDED')]),
    notes: z.string().nullable(),
    lines: z.array(purchaseLineResponseSchema),
    /**
     * Every money figure is cost data: a role without `inventory.cost.view`
     * gets the bill without its amounts rather than a blanked-out column.
     */
    itemsTotalMinor: z.number().int().optional(),
    discountMinor: z.number().int().optional(),
    extraCostMinor: z.number().int().optional(),
    landedCosts: z.array(landedCostResponseSchema).optional(),
    grandTotalMinor: z.number().int().optional(),
    /** Paid on the bill itself plus everything allocated to it since. */
    paidMinor: z.number().int().optional(),
    dueMinor: z.number().int().optional(),
    paidAccountCode: z.string().nullable().optional(),
    paidAccountName: z.string().nullable().optional(),
    payments: z
      .array(
        z.object({
          id: ULID,
          number: z.string(),
          businessDate: BUSINESS_DATE,
          accountName: z.string(),
          amountMinor: z.number().int(),
        }),
      )
      .optional(),
    /**
     * Said once, beside the data (§5.26): the new cost is at or above what the
     * product sells for. Not an error — the bill is posted — but the shopkeeper
     * has to know before the next customer walks in.
     */
    warnings: z.array(z.string()).default([]),
    createdAt: z.string(),
  })
  .strict();
export type PurchaseResponse = z.infer<typeof purchaseResponseSchema>;

export const purchaseListRowSchema = z
  .object({
    id: ULID,
    number: z.string(),
    supplierPartyId: ULID,
    supplierName: z.string(),
    supplierBillRef: z.string().nullable(),
    businessDate: BUSINESS_DATE,
    dueDate: BUSINESS_DATE.nullable(),
    status: z.union([z.literal('POSTED'), z.literal('VOIDED')]),
    lineCount: z.number().int(),
    grandTotalMinor: z.number().int().optional(),
    paidMinor: z.number().int().optional(),
    dueMinor: z.number().int().optional(),
    /** Past its due date with something still owed, as at today. */
    overdue: z.boolean(),
  })
  .strict();
export type PurchaseListRow = z.infer<typeof purchaseListRowSchema>;

export const purchaseListQuerySchema = z
  .object({
    search: z.string().trim().max(80).optional(),
    supplierPartyId: ULID.optional(),
    fromDate: BUSINESS_DATE.optional(),
    toDate: BUSINESS_DATE.optional(),
    settlement: z.enum(['ALL', 'UNPAID', 'PAID']).optional(),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().positive().max(100).optional(),
  })
  .strict();
export type PurchaseListQuery = z.infer<typeof purchaseListQuerySchema>;

export const purchaseListResponseSchema = z.object({
  data: z.array(purchaseListRowSchema),
  page: z.object({ nextCursor: z.string().nullable() }),
  /**
   * The three figures the tiles show, counted by the same query as the rows so
   * a tile can never disagree with the table under it.
   */
  summary: z.object({
    periodTotalMinor: z.number().int().optional(),
    unpaidTotalMinor: z.number().int().optional(),
    overdueTotalMinor: z.number().int().optional(),
    purchaseCount: z.number().int(),
  }),
});
export type PurchaseListResponse = z.infer<typeof purchaseListResponseSchema>;

/* ------------------------------------------------------ paying a supplier */

/**
 * Paying a supplier. `purchaseId` is the "Pay this bill" entry point — the same
 * use case, restricted to one bill instead of settling the oldest first.
 */
export const paySupplierRequestSchema = z
  .object({
    supplierPartyId: ULID,
    amountMinor: z.number().int().positive(),
    accountCode: ACCOUNT_CODE,
    businessDate: BUSINESS_DATE.optional(),
    note: z.string().trim().max(500).nullable().default(null),
    purchaseId: ULID.nullable().default(null),
  })
  .strict();
export type PaySupplierRequest = z.infer<typeof paySupplierRequestSchema>;

/**
 * Correcting a posted supplier payment (Phase 9.2). Reversed and re-posted
 * under the same number, re-allocated oldest-first against what is owed now.
 */
export const correctSupplierPaymentRequestSchema = paySupplierRequestSchema
  .extend({
    version: z.number().int().nonnegative(),
    reason: z.string().trim().max(300).nullable().default(null),
  })
  .strict();

export type CorrectSupplierPaymentRequest = z.infer<typeof correctSupplierPaymentRequestSchema>;


export const supplierPaymentResponseSchema = z
  .object({
    id: ULID,
    number: z.string(),
    supplierPartyId: ULID,
    supplierName: z.string(),
    accountCode: z.string(),
    accountName: z.string(),
    amountMinor: z.number().int(),
    businessDate: BUSINESS_DATE,
    note: z.string().nullable(),
    /** Which bills this money settled, in the order it was applied. */
    allocations: z.array(
      z.object({
        purchaseId: ULID,
        purchaseNumber: z.string(),
        amountMinor: z.number().int(),
      }),
    ),
    /** What the supplier is still owed once this payment landed. */
    outstandingAfterMinor: z.number().int(),
    createdAt: z.string(),
    /** Phase 9.2: what a correction and a cancellation need, and what they leave. */
    status: z.enum(['POSTED', 'VOIDED']).default('POSTED'),
    entryMode: z.string().default('ON_TIME'),
    voidReason: z.string().nullable().default(null),
    version: z.number().int().default(1),
  })
  .strict();
export type SupplierPaymentResponse = z.infer<typeof supplierPaymentResponseSchema>;

/** What the Pay Supplier dialog needs to open: the debt, and the bills behind it. */
export const supplierDueResponseSchema = z.object({
  supplierPartyId: ULID,
  supplierName: z.string(),
  outstandingMinor: z.number().int(),
  bills: z.array(
    z.object({
      id: ULID,
      number: z.string(),
      businessDate: BUSINESS_DATE,
      dueDate: BUSINESS_DATE.nullable(),
      grandTotalMinor: z.number().int(),
      dueMinor: z.number().int(),
      overdue: z.boolean(),
    }),
  ),
});
export type SupplierDueResponse = z.infer<typeof supplierDueResponseSchema>;

/** Cancelling a posted bill (§2.5). The version is D-32 optimistic locking. */
export const voidPurchaseRequestSchema = z
  .object({
    version: z.number().int().positive(),
    reason: z.string().trim().max(300).nullable().default(null),
  })
  .strict();

export type VoidPurchaseRequest = z.infer<typeof voidPurchaseRequestSchema>;
