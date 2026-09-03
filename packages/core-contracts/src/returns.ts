import { z } from 'zod';

const ULID = z.string().length(26);
const BUSINESS_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * Goods coming back — from a customer, or to a supplier (Phase 7, §5.11).
 *
 * **A return is always against its document.** There is no free-standing return
 * request: the invoice or the bill is named, the lines are its lines, and the
 * server re-derives every figure from what that document actually sold or
 * bought. Nothing the screen computes is posted (DR13.12) — the amounts below
 * travel only so the shopkeeper's choices arrive, never the arithmetic.
 */

/** Why the goods came back. Closed, because free text cannot be counted. */
export const returnReasonSchema = z.enum([
  'DAMAGED',
  'WRONG_ITEM',
  'CHANGED_MIND',
  'EXTRA_QUANTITY',
  'OTHER',
]);
export type ReturnReason = z.infer<typeof returnReasonSchema>;

export const returnLineRequestSchema = z
  .object({
    /** The line of the original document this quantity is coming back from. */
    sourceLineId: ULID,
    /** Scale 3, as every quantity is. Zero lines are simply left out. */
    qty: z.number().int().positive(),
    serialUnitIds: z.array(ULID).max(200).default([]),
  })
  .strict();

export const createSalesReturnRequestSchema = z
  .object({
    saleId: ULID,
    lines: z.array(returnLineRequestSchema).min(1).max(200),
    reason: returnReasonSchema,
    note: z.string().trim().max(500).nullable().default(null),
    /**
     * What is handed back in cash or bank. `0` leaves the whole value on the
     * customer's account — their dues first, the rest as an advance.
     */
    refundMinor: z.number().int().nonnegative().default(0),
    /** Where a refund comes out of. Required only when `refundMinor > 0`. */
    refundAccountCode: z.string().max(60).nullable().default(null),
    /**
     * The approver's PIN, when the refund is over the caller's role limit
     * (owner decision 2026-08-26). The server checks it belongs to a live user
     * whose own role allows the amount, and stores who approved.
     */
    approvalPin: z.string().min(4).max(12).nullable().default(null),
    /**
     * The customer, for a guest sale whose return leaves money on account.
     *
     * §5.8 lets a fully paid sale create nobody, but credit is a balance and a
     * balance needs a name. Blank falls back to what the invoice recorded when
     * the sale was made, which is usually exactly right.
     */
    customerName: z.string().trim().max(120).nullable().default(null),
    customerPhone: z.string().trim().max(20).nullable().default(null),
    customerAddress: z.string().trim().max(300).nullable().default(null),
    customerGuardianName: z.string().trim().max(120).nullable().default(null),
    /** Backdating (§5.19): today unless the caller holds `period.backdate`. */
    businessDate: BUSINESS_DATE.optional(),
    backdateReason: z.string().trim().max(300).nullable().default(null),
  })
  .strict();

export type CreateSalesReturnRequest = z.infer<typeof createSalesReturnRequestSchema>;

/**
 * One line of an invoice as the return modal sees it: what was sold, what has
 * already come back, and what a unit is worth returning.
 */
export const returnableLineSchema = z
  .object({
    saleLineId: ULID,
    productId: ULID,
    productName: z.string(),
    unitName: z.string(),
    qtySold: z.number().int(),
    qtyReturned: z.number().int(),
    qtyReturnable: z.number().int(),
    unitPriceMinor: z.number().int(),
    /** What the customer paid for the whole line, after both discounts. */
    netAmountMinor: z.number().int(),
    /**
     * False for consignment goods: they were never the shop's stock, so the
     * modal shows the line but cannot take it back (INV-04).
     */
    returnable: z.boolean(),
    tracksSerial: z.boolean().default(false),
    serials: z
      .array(
        z
          .object({
            id: ULID,
            serialNo: z.string(),
            sourceType: z.enum(['OWNED', 'VENDOR']),
            vendorPartyId: ULID.nullable(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export const returnableInvoiceSchema = z
  .object({
    saleId: ULID,
    number: z.string(),
    businessDate: BUSINESS_DATE,
    customerName: z.string(),
    customerPhone: z.string().nullable(),
    customerAddress: z.string().nullable(),
    customerGuardianName: z.string().nullable(),
    partyId: ULID,
    isWalkIn: z.boolean(),
    grandTotalMinor: z.number().int(),
    dueMinor: z.number().int(),
    lines: z.array(returnableLineSchema),
    /**
     * What this caller may refund in cash before a PIN is needed — the role's
     * two caps, with what today has already used. `null` is unlimited.
     */
    refundLimit: z
      .object({
        perReturnMinor: z.number().int().nullable(),
        perDayMinor: z.number().int().nullable(),
        usedTodayMinor: z.number().int(),
      })
      .strict(),
  })
  .strict();

export type ReturnableInvoiceResponse = z.infer<typeof returnableInvoiceSchema>;

export const salesReturnLineSchema = z
  .object({
    id: ULID,
    saleLineId: ULID,
    productId: ULID,
    productName: z.string(),
    unitName: z.string(),
    qty: z.number().int(),
    valueMinor: z.number().int(),
  })
  .strict();

export const salesReturnSchema = z
  .object({
    id: ULID,
    number: z.string(),
    saleId: ULID,
    saleNumber: z.string(),
    partyId: ULID,
    customerName: z.string(),
    businessDate: BUSINESS_DATE,
    reason: returnReasonSchema,
    note: z.string().nullable(),
    returnValueMinor: z.number().int(),
    refundMinor: z.number().int(),
    creditMinor: z.number().int(),
    refundAccountCode: z.string().nullable(),
    refundAccountName: z.string().nullable(),
    approvedByName: z.string().nullable(),
    lines: z.array(salesReturnLineSchema),
    createdAt: z.string(),
  })
  .strict();

export type SalesReturnResponse = z.infer<typeof salesReturnSchema>;

export const salesReturnListSchema = z
  .object({
    returns: z.array(salesReturnSchema),
    nextCursor: z.string().nullable(),
    totalValueMinor: z.number().int(),
    totalRefundMinor: z.number().int(),
  })
  .strict();

export type SalesReturnListResponse = z.infer<typeof salesReturnListSchema>;

/* ------------------------------------------------- goods back to a supplier */

export const createPurchaseReturnRequestSchema = z
  .object({
    purchaseId: ULID,
    lines: z.array(returnLineRequestSchema).min(1).max(200),
    reason: returnReasonSchema,
    note: z.string().trim().max(500).nullable().default(null),
    /**
     * What the supplier hands back in cash or bank. `0` leaves the whole value
     * against what the shop still owes them — their bills first, the rest as a
     * credit the next purchase spends.
     */
    receivedMinor: z.number().int().nonnegative().default(0),
    receiptAccountCode: z.string().max(60).nullable().default(null),
    businessDate: BUSINESS_DATE.optional(),
    backdateReason: z.string().trim().max(300).nullable().default(null),
  })
  .strict();

export type CreatePurchaseReturnRequest = z.infer<typeof createPurchaseReturnRequestSchema>;

export const returnableBillLineSchema = z
  .object({
    purchaseLineId: ULID,
    productId: ULID,
    productName: z.string(),
    unitName: z.string(),
    lotId: ULID,
    qtyReceived: z.number().int(),
    qtyReturned: z.number().int(),
    qtyReturnable: z.number().int(),
    /** Still in the lot: goods already sold cannot go back to the supplier. */
    qtyRemainingInLot: z.number().int(),
    billedNetMinor: z.number().int(),
    actualUnitCost: z.number().int(),
  })
  .strict();

export const returnableBillSchema = z
  .object({
    purchaseId: ULID,
    number: z.string(),
    businessDate: BUSINESS_DATE,
    supplierName: z.string(),
    supplierPartyId: ULID,
    grandTotalMinor: z.number().int(),
    outstandingMinor: z.number().int(),
    lines: z.array(returnableBillLineSchema),
  })
  .strict();

export type ReturnableBillResponse = z.infer<typeof returnableBillSchema>;

export const purchaseReturnLineSchema = z
  .object({
    id: ULID,
    purchaseLineId: ULID,
    productId: ULID,
    productName: z.string(),
    unitName: z.string(),
    qty: z.number().int(),
    valueMinor: z.number().int(),
  })
  .strict();

export const purchaseReturnSchema = z
  .object({
    id: ULID,
    number: z.string(),
    purchaseId: ULID,
    purchaseNumber: z.string(),
    supplierPartyId: ULID,
    supplierName: z.string(),
    businessDate: BUSINESS_DATE,
    reason: returnReasonSchema,
    note: z.string().nullable(),
    returnValueMinor: z.number().int(),
    receivedMinor: z.number().int(),
    creditMinor: z.number().int(),
    receiptAccountCode: z.string().nullable(),
    receiptAccountName: z.string().nullable(),
    lines: z.array(purchaseReturnLineSchema),
    createdAt: z.string(),
  })
  .strict();

export type PurchaseReturnResponse = z.infer<typeof purchaseReturnSchema>;

export const purchaseReturnListSchema = z
  .object({
    returns: z.array(purchaseReturnSchema),
    nextCursor: z.string().nullable(),
    totalValueMinor: z.number().int(),
    totalReceivedMinor: z.number().int(),
  })
  .strict();

export type PurchaseReturnListResponse = z.infer<typeof purchaseReturnListSchema>;
