import { z } from 'zod';

const ULID = z.string().length(26);
const BUSINESS_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * Serial numbers, and the claims that follow them (Phase 8, §5.19, D-18).
 *
 * **Serials are read off the goods, never generated** — there is no endpoint
 * here that makes one up, and there never should be.
 *
 * **A claim carries no balance.** §5.19 is explicit that no warranty receivable
 * is created: a claim waiting on a supplier is a status on this record, not an
 * asset on the balance sheet, because these are frequently never recovered.
 */

export const serialUnitStatusSchema = z.enum([
  'IN_STOCK',
  'SOLD',
  'WITH_SUPPLIER',
  'WRITTEN_OFF',
  'RETURNED_TO_VENDOR',
  // Handed over to settle a warranty claim (§5.19). Not `SOLD`: no sale, no
  // invoice, no revenue — the cost went to `WARRANTY_EXPENSE`.
  'WARRANTY_REPLACEMENT',
]);
export type SerialUnitStatusValue = z.infer<typeof serialUnitStatusSchema>;

/**
 * Adding scanned serials to a purchase line.
 *
 * Sent as a batch because the two rules that matter — no duplicates, and never
 * more than the quantity received — are only answerable with the whole batch in
 * view. A line may be filled in over several goes; the server counts what is
 * already there.
 */
export const recordSerialsRequestSchema = z
  .object({
    purchaseLineId: ULID,
    serials: z.array(z.string().trim().min(1).max(64)).min(1).max(500),
  })
  .strict();
export type RecordSerialsRequest = z.infer<typeof recordSerialsRequestSchema>;

export const serialUnitResponseSchema = z
  .object({
    id: ULID,
    serialNo: z.string(),
    productId: ULID,
    displayName: z.string(),
    status: serialUnitStatusSchema,
    receivedDate: BUSINESS_DATE,
    soldDate: BUSINESS_DATE.nullable(),
    supplierName: z.string().nullable(),
    vendorPartyId: ULID.nullable(),
    vendorStockReceiptId: ULID.nullable(),
    vendorLotId: ULID.nullable(),
    customerName: z.string().nullable(),
    invoiceNumber: z.string().nullable(),
    /** Both ends, already worked out: the customer's from the sale, the shop's from the delivery. */
    customerWarrantyEnd: BUSINESS_DATE.nullable(),
    supplierWarrantyEnd: BUSINESS_DATE.nullable(),
    customerWarrantyLive: z.boolean(),
    supplierWarrantyLive: z.boolean(),
  })
  .strict();
export type SerialUnitResponse = z.infer<typeof serialUnitResponseSchema>;

/** What a purchase line still owes in serials, so the bill can say "6 to enter". */
export const serialProgressResponseSchema = z
  .object({
    purchaseLineId: ULID,
    productId: ULID,
    displayName: z.string(),
    qty: z.number().int(),
    recorded: z.number().int(),
    outstanding: z.number().int(),
    serials: z.array(z.string()),
  })
  .strict();
export type SerialProgressResponse = z.infer<typeof serialProgressResponseSchema>;

// ------------------------------------------------------------------- claims

export const claimStatusSchema = z.enum([
  'RECEIVED',
  'CHECKING',
  'SENT_TO_SUPPLIER',
  'SETTLED',
  'RETURNED_TO_CUSTOMER',
  'CLOSED',
]);
export type ClaimStatusValue = z.infer<typeof claimStatusSchema>;

export const claimSettlementSchema = z.enum(['REPLACED', 'REPAIRED', 'ADJUSTED', 'REJECTED']);
export type ClaimSettlementValue = z.infer<typeof claimSettlementSchema>;

export const claimHandlingSchema = z.enum(['SHOP', 'COURIER']);
export type ClaimHandlingValue = z.infer<typeof claimHandlingSchema>;

/**
 * Finding what the customer brought in.
 *
 * Serial first, because it alone identifies the unit, the invoice, the
 * customer, the delivery, the supplier and both warranty dates with nothing
 * typed. Phone and invoice number are the fallbacks for goods that carry no
 * serial or whose owner has lost the receipt.
 */
export const claimLookupQuerySchema = z
  .object({
    serial: z.string().trim().max(64).optional(),
    phone: z.string().trim().max(30).optional(),
    invoiceNumber: z.string().trim().max(40).optional(),
  })
  .strict();
export type ClaimLookupQuery = z.infer<typeof claimLookupQuerySchema>;

export const claimCandidateResponseSchema = z
  .object({
    inventoryUnitId: ULID.nullable(),
    serialNo: z.string().nullable(),
    productId: ULID,
    displayName: z.string(),
    saleId: ULID.nullable(),
    invoiceNumber: z.string().nullable(),
    soldDate: BUSINESS_DATE.nullable(),
    customerPartyId: ULID.nullable(),
    customerName: z.string().nullable(),
    customerPhone: z.string().nullable(),
    purchaseId: ULID.nullable(),
    supplierPartyId: ULID.nullable(),
    supplierName: z.string().nullable(),
    customerWarrantyEnd: BUSINESS_DATE.nullable(),
    supplierWarrantyEnd: BUSINESS_DATE.nullable(),
    customerWarrantyLive: z.boolean(),
    supplierWarrantyLive: z.boolean(),
  })
  .strict();
export type ClaimCandidateResponse = z.infer<typeof claimCandidateResponseSchema>;

export const createWarrantyClaimRequestSchema = z
  .object({
    productId: ULID,
    inventoryUnitId: ULID.nullable().default(null),
    saleId: ULID.nullable().default(null),
    customerPartyId: ULID.nullable().default(null),
    customerName: z.string().trim().min(1).max(120),
    customerPhone: z.string().trim().max(30).nullable().default(null),
    complaint: z.string().trim().min(1).max(500),
    handling: claimHandlingSchema.default('SHOP'),
    courierName: z.string().trim().max(120).nullable().default(null),
    receivedDate: BUSINESS_DATE.optional(),
  })
  .strict();
export type CreateWarrantyClaimRequest = z.infer<typeof createWarrantyClaimRequestSchema>;

/**
 * One step along the claim.
 *
 * `SETTLED` needs a settlement type, and the two that bring goods back may
 * post: a replacement handed out of own stock charges `WARRANTY_EXPENSE`, and
 * a supplier's replacement, repair or cash adjustment credits it back. All of
 * it goes through the ordinary stock and ledger use cases (§5.19).
 */
export const moveWarrantyClaimRequestSchema = z
  .object({
    status: claimStatusSchema,
    settlement: claimSettlementSchema.nullable().default(null),
    note: z.string().trim().max(500).nullable().default(null),
    /** The unit given to the customer out of the shop's own stock. */
    replacementUnitId: ULID.nullable().default(null),
    /** For `ADJUSTED`: what the supplier credited, and where it landed. */
    recoveryMinor: z.number().int().nonnegative().nullable().default(null),
    recoveryAccountCode: z.string().max(60).nullable().default(null),
    businessDate: BUSINESS_DATE.optional(),
    version: z.number().int().nonnegative(),
  })
  .strict();
export type MoveWarrantyClaimRequest = z.infer<typeof moveWarrantyClaimRequestSchema>;

export const warrantyClaimResponseSchema = z
  .object({
    id: ULID,
    claimNumber: z.string(),
    status: claimStatusSchema,
    settlement: claimSettlementSchema.nullable(),
    settlementNote: z.string().nullable(),
    customerPartyId: ULID.nullable(),
    customerName: z.string(),
    customerPhone: z.string().nullable(),
    productId: ULID,
    displayName: z.string(),
    serialNo: z.string().nullable(),
    invoiceNumber: z.string().nullable(),
    supplierPartyId: ULID.nullable(),
    supplierName: z.string().nullable(),
    complaint: z.string(),
    handling: claimHandlingSchema,
    courierName: z.string().nullable(),
    receivedDate: BUSINESS_DATE,
    sentToSupplierDate: BUSINESS_DATE.nullable(),
    settledDate: BUSINESS_DATE.nullable(),
    customerWarrantyEnd: BUSINESS_DATE.nullable(),
    supplierWarrantyEnd: BUSINESS_DATE.nullable(),
    customerWarrantyLive: z.boolean(),
    supplierWarrantyLive: z.boolean(),
    /** What this claim has cost the shop so far, net of anything recovered. */
    warrantyCostMinor: z.number().int().optional(),
    nextStatuses: z.array(claimStatusSchema),
    version: z.number().int(),
  })
  .strict();
export type WarrantyClaimResponse = z.infer<typeof warrantyClaimResponseSchema>;

export const warrantyClaimListQuerySchema = z
  .object({
    status: claimStatusSchema.optional(),
    search: z.string().trim().max(80).optional(),
    openOnly: z.coerce.boolean().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export type WarrantyClaimListQuery = z.infer<typeof warrantyClaimListQuerySchema>;

export const warrantyClaimListResponseSchema = z
  .object({ data: z.array(warrantyClaimResponseSchema) })
  .strict();
export type WarrantyClaimListResponse = z.infer<typeof warrantyClaimListResponseSchema>;
