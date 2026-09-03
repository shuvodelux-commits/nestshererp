import { z } from 'zod';

const ULID = z.string().length(26);
const BUSINESS_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * Stock the shop holds but does not own (Phase 8, §5.6 M07, DR13.10, owner
 * decision 2026-08-26).
 *
 * **Receiving it posts no money.** A vendor leaving fifty shirts has not sold
 * the shop anything: the lot carries `owner_type = 'VENDOR'`, is excluded from
 * valuation and COGS, and nobody is owed a taka. When one sells, the sale
 * converts that lot to owned at the agreed vendor cost inside the same
 * transaction — the deemed purchase of DR13.10 — and *that* is what creates the
 * vendor payable.
 *
 * **Returning it posts no money either**, for the same reason: the shop never
 * bought it, so there is nothing to unpay.
 *
 * The vendor is paid through the ordinary Pay Supplier flow against their
 * party ledger. There is no second payment engine here.
 */

export const receiveVendorStockRequestSchema = z
  .object({
    vendorPartyId: ULID,
    productId: ULID,
    qty: z.number().int().positive(),
    /** What the vendor is owed per unit when one sells, in poisha. */
    vendorUnitCostMinor: z.number().int().nonnegative(),
    expiryDate: BUSINESS_DATE.nullable().default(null),
    serials: z.array(z.string().trim().min(1).max(120)).max(200).default([]),
    note: z.string().trim().max(300).nullable().default(null),
    businessDate: BUSINESS_DATE.optional(),
  })
  .strict();
export type ReceiveVendorStockRequest = z.infer<typeof receiveVendorStockRequestSchema>;

export const returnVendorStockRequestSchema = z
  .object({
    receiptId: ULID,
    qty: z.number().int().positive(),
    serialUnitIds: z.array(ULID).max(200).default([]),
    note: z.string().trim().max(300).nullable().default(null),
    businessDate: BUSINESS_DATE.optional(),
  })
  .strict();
export type ReturnVendorStockRequest = z.infer<typeof returnVendorStockRequestSchema>;

export const vendorStockReceiptResponseSchema = z
  .object({
    id: ULID,
    receiptNumber: z.string(),
    vendorPartyId: ULID,
    vendorName: z.string(),
    productId: ULID,
    displayName: z.string(),
    unitName: z.string(),
    businessDate: BUSINESS_DATE,
    expiryDate: BUSINESS_DATE.nullable(),
    note: z.string().nullable(),
    /** The four quantities the settlement summary is built from. */
    receivedQty: z.number().int(),
    soldQty: z.number().int(),
    returnedQty: z.number().int(),
    onHandQty: z.number().int(),
    vendorUnitCostMinor: z.number().int().optional(),
    /** What selling this receipt's goods has made the shop owe. */
    dueMinor: z.number().int().optional(),
    version: z.number().int(),
  })
  .strict();
export type VendorStockReceiptResponse = z.infer<typeof vendorStockReceiptResponseSchema>;

/**
 * `Received 50 · Sold 30 · Returned 20 · Due · Paid · Balance` — the line the
 * owner asked for on the vendor's hub.
 *
 * `paidMinor` and `balanceMinor` come from the vendor's ledger, not from these
 * receipts: money is the ledger's business, and a second tally of it here would
 * eventually disagree with the accounts.
 */
export const vendorSettlementResponseSchema = z
  .object({
    vendorPartyId: ULID,
    vendorName: z.string(),
    receivedQty: z.number().int(),
    soldQty: z.number().int(),
    returnedQty: z.number().int(),
    onHandQty: z.number().int(),
    dueMinor: z.number().int(),
    paidMinor: z.number().int(),
    balanceMinor: z.number().int(),
    receipts: z.array(vendorStockReceiptResponseSchema),
  })
  .strict();
export type VendorSettlementResponse = z.infer<typeof vendorSettlementResponseSchema>;

/* ------------------------------------------------- Vendor Workspace (8.3) */

/**
 * The vendor's own hub (Phase 8.3, owner decision 2026-08-31).
 *
 * **Every action here is a caller, never a second posting engine.** Receiving
 * and returning consignment stock stay with `VendorStockService` above; goods
 * charged to a vendor are an ordinary **sale** and come back as an ordinary
 * **sales return**, so `AR`, `SALES`, `COGS` and `INVENTORY` move exactly as
 * they do at the counter and the returned cost is the cost that left; money in
 * settling that receivable is the ordinary **customer receipt**. What is
 * genuinely new is only what nothing else could do: paying against
 * `VENDOR_PAYABLE`, which the deemed purchase of DR13.10 creates and the
 * supplier flow cannot touch (it debits `AP`), the advance either side of that,
 * and custody of goods lent to a vendor with no money in them at all.
 */

/**
 * Money going out, said explicitly rather than guessed from the balance.
 *
 * A shopkeeper handing over cash knows which of the two it is, and the ledger
 * cannot tell afterwards: `SETTLE_PAYABLE` clears what selling their goods made
 * the shop owe, `ADVANCE` is money paid before any of it sold. Guessing from
 * the sign would post an advance as a settlement on the first vendor whose
 * balance happened to be non-zero.
 */
export const VENDOR_PAYMENT_INTENTS = ['SETTLE_PAYABLE', 'ADVANCE'] as const;
export type VendorPaymentIntent = (typeof VENDOR_PAYMENT_INTENTS)[number];

/** Money coming in: settling what they owe, or handing back an advance. */
export const VENDOR_RECEIPT_INTENTS = ['SETTLE_RECEIVABLE', 'REFUND_ADVANCE'] as const;
export type VendorReceiptIntent = (typeof VENDOR_RECEIPT_INTENTS)[number];

export const payVendorRequestSchema = z
  .object({
    vendorPartyId: ULID,
    intent: z.enum(VENDOR_PAYMENT_INTENTS),
    amountMinor: z.number().int().positive(),
    /** `CASH:01J…` or `BANK:01J…` — never a fixed account. */
    accountCode: z.string().min(1).max(40),
    note: z.string().trim().max(300).nullable().default(null),
    businessDate: BUSINESS_DATE.optional(),
  })
  .strict();
export type PayVendorRequest = z.infer<typeof payVendorRequestSchema>;

export const receiveFromVendorRequestSchema = z
  .object({
    vendorPartyId: ULID,
    intent: z.enum(VENDOR_RECEIPT_INTENTS),
    amountMinor: z.number().int().positive(),
    accountCode: z.string().min(1).max(40),
    /**
     * Which sales this settles, oldest-first when empty. Only read for
     * `SETTLE_RECEIVABLE`, which is the customer receipt path.
     */
    saleIds: z.array(ULID).max(50).default([]),
    note: z.string().trim().max(300).nullable().default(null),
    businessDate: BUSINESS_DATE.optional(),
  })
  .strict();
export type ReceiveFromVendorRequest = z.infer<typeof receiveFromVendorRequestSchema>;

export const vendorMoneyDocumentResponseSchema = z
  .object({
    id: ULID,
    number: z.string(),
    kind: z.enum(['VENDOR_PAYMENT', 'VENDOR_RECEIPT', 'CUSTOMER_RECEIPT']),
    intent: z.enum([...VENDOR_PAYMENT_INTENTS, ...VENDOR_RECEIPT_INTENTS]),
    vendorPartyId: ULID,
    amountMinor: z.number().int(),
    accountCode: z.string(),
    accountName: z.string(),
    businessDate: BUSINESS_DATE,
    note: z.string().nullable(),
  })
  .strict();
export type VendorMoneyDocumentResponse = z.infer<typeof vendorMoneyDocumentResponseSchema>;

/**
 * Goods the shop hands to a vendor, in the two meanings it can have (owner
 * decision 2026-08-31: the mode is chosen per transaction, never inferred).
 *
 * `CHARGED` is a sale and is posted as one, through the same service the
 * counter uses — the vendor must therefore also be a customer, exactly as any
 * other party sold to on credit must be. `TEMPORARY` is custody only: the
 * goods are still the shop's, still in its valuation, and **no journal entry
 * exists**, because nothing has been bought, sold or owed.
 */
export const VENDOR_ISSUE_MODES = ['CHARGED', 'TEMPORARY'] as const;
export type VendorIssueMode = (typeof VENDOR_ISSUE_MODES)[number];

export const giveProductsToVendorRequestSchema = z
  .object({
    vendorPartyId: ULID,
    mode: z.enum(VENDOR_ISSUE_MODES),
    productId: ULID,
    qty: z.number().int().positive(),
    /**
     * The selling price when charged. Ignored for a temporary issue, which has
     * no value to agree on — the goods have not changed hands.
     */
    unitValueMinor: z.number().int().nonnegative().default(0),
    note: z.string().trim().max(300).nullable().default(null),
    businessDate: BUSINESS_DATE.optional(),
  })
  .strict();
export type GiveProductsToVendorRequest = z.infer<typeof giveProductsToVendorRequestSchema>;

/**
 * Taking them back.
 *
 * `issueId` names what is being settled and decides the path: a temporary issue
 * puts the goods back into **the very lots they left**, at the cost they left
 * at; a charged one is a sales return against the invoice it created, which is
 * the same rule enforced by the same service.
 */
export const receiveProductsBackRequestSchema = z
  .object({
    issueId: ULID,
    qty: z.number().int().positive(),
    note: z.string().trim().max(300).nullable().default(null),
    businessDate: BUSINESS_DATE.optional(),
  })
  .strict();
export type ReceiveProductsBackRequest = z.infer<typeof receiveProductsBackRequestSchema>;

export const vendorProductIssueResponseSchema = z
  .object({
    id: ULID,
    number: z.string(),
    mode: z.enum(VENDOR_ISSUE_MODES),
    vendorPartyId: ULID,
    vendorName: z.string(),
    productId: ULID,
    displayName: z.string(),
    unitName: z.string(),
    qty: z.number().int(),
    returnedQty: z.number().int(),
    openQty: z.number().int(),
    /** What the goods cost the shop — present only where the caller may see cost. */
    costMinor: z.number().int().optional(),
    valueMinor: z.number().int(),
    /** The invoice a charged issue created, so the row can link to it. */
    saleId: ULID.nullable(),
    invoiceNumber: z.string().nullable(),
    businessDate: BUSINESS_DATE,
    note: z.string().nullable(),
    version: z.number().int(),
  })
  .strict();
export type VendorProductIssueResponse = z.infer<typeof vendorProductIssueResponseSchema>;

/**
 * One line of vendor history, whatever module wrote it.
 *
 * `source` is what the row links back to (UI-52: every related row source-links
 * to the authoritative document). Nothing here is recalculated — each row is
 * read from the module that owns it.
 */
export const VENDOR_ACTIVITY_KINDS = [
  'VENDOR_STOCK',
  'VENDOR_STOCK_RETURN',
  'GIVEN_TO_VENDOR',
  'RECEIVED_BACK',
  'PAYMENT',
  'RECEIPT',
  'PRODUCT_SETTLEMENT',
] as const;
export type VendorActivityKind = (typeof VENDOR_ACTIVITY_KINDS)[number];

export const vendorActivityRowSchema = z
  .object({
    id: ULID,
    kind: z.enum(VENDOR_ACTIVITY_KINDS),
    businessDate: BUSINESS_DATE,
    number: z.string(),
    description: z.string(),
    qty: z.number().int().nullable(),
    amountMinor: z.number().int().nullable(),
    openQty: z.number().int().nullable(),
    status: z.string(),
    /** Where the row came from, for the link: `sale`, `vendor_stock_receipt`, … */
    sourceType: z.string(),
    sourceId: ULID,
  })
  .strict();
export type VendorActivityRow = z.infer<typeof vendorActivityRowSchema>;

/**
 * The four figures above the actions.
 *
 * `payableMinor` and `receivableMinor` are read from the vendor's journal lines
 * (INV-06) and never tallied here; `vendorOwnedStockValueMinor` is the
 * consignment still on the shelf, which is deliberately **not** money — it is
 * the shop's exposure, not its debt.
 */
export const vendorWorkspaceSummaryResponseSchema = z
  .object({
    vendorPartyId: ULID,
    vendorName: z.string(),
    isActive: z.boolean(),
    isAlsoCustomer: z.boolean(),
    payableMinor: z.number().int(),
    receivableMinor: z.number().int(),
    advancePaidMinor: z.number().int(),
    vendorOwnedStockQty: z.number().int(),
    vendorOwnedStockValueMinor: z.number().int(),
    openIssueCount: z.number().int(),
    openIssues: z.array(vendorProductIssueResponseSchema),
    openConsignments: z.array(vendorStockReceiptResponseSchema),
  })
  .strict();
export type VendorWorkspaceSummaryResponse = z.infer<typeof vendorWorkspaceSummaryResponseSchema>;

/* -------------------------------------- products received as AR settlement */

export const vendorProductSettlementRequestSchema = z
  .object({
    vendorPartyId: ULID,
    businessDate: BUSINESS_DATE.optional(),
    supplierBillRef: z.string().trim().max(80).nullable().default(null),
    discountMinor: z.number().int().nonnegative().default(0),
    lines: z
      .array(
        z
          .object({
            productId: ULID,
            qty: z.number().int().positive(),
            unitPriceMinor: z.number().int().nonnegative(),
            expiryDate: BUSINESS_DATE.nullable().default(null),
            serials: z.array(z.string().trim().min(1).max(64)).max(500).default([]),
          })
          .strict(),
      )
      .min(1)
      .max(200),
    landedCosts: z
      .array(
        z
          .object({
            category: z.enum(['TRANSPORT', 'LABOUR', 'LOADING', 'DELIVERY', 'CUSTOMS', 'OTHER']),
            amountMinor: z.number().int().positive(),
            method: z.enum(['BY_VALUE', 'BY_QTY', 'MANUAL']),
            description: z.string().trim().max(300).nullable().default(null),
            paidAccountCode: z.string().trim().min(3).max(40),
            manualAllocations: z
              .array(
                z.object({ lineIndex: z.number().int().nonnegative(), amountMinor: z.number().int().nonnegative() }).strict(),
              )
              .max(200)
              .default([]),
          })
          .strict(),
      )
      .max(20)
      .default([]),
    notes: z.string().trim().max(500).nullable().default(null),
  })
  .strict()
  .superRefine((value, ctx) => {
    value.landedCosts.forEach((cost, index) => {
      if (cost.category === 'OTHER' && (cost.description ?? '').trim() === '') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['landedCosts', index, 'description'], message: 'Describe the Other landed cost' });
      }
      if (cost.method === 'MANUAL') {
        const total = cost.manualAllocations.reduce((sum, row) => sum + row.amountMinor, 0);
        if (total !== cost.amountMinor) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['landedCosts', index, 'manualAllocations'], message: 'Manual allocations must equal the landed cost' });
        }
      }
    });
  });
export type VendorProductSettlementRequest = z.infer<typeof vendorProductSettlementRequestSchema>;

export const vendorProductSettlementResponseSchema = z
  .object({
    id: ULID,
    number: z.string(),
    vendorPartyId: ULID,
    purchaseId: ULID,
    purchaseNumber: z.string(),
    businessDate: BUSINESS_DATE,
    grossProductMinor: z.number().int(),
    discountMinor: z.number().int(),
    netProductMinor: z.number().int(),
    landedCostMinor: z.number().int(),
    receivableBeforeMinor: z.number().int(),
    receivableAfterMinor: z.number().int(),
    allocations: z.array(
      z.object({ saleId: ULID, saleNumber: z.string(), amountMinor: z.number().int().positive() }).strict(),
    ),
  })
  .strict();
export type VendorProductSettlementResponse = z.infer<typeof vendorProductSettlementResponseSchema>;
