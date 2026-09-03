import { z } from 'zod';

/**
 * Selling (Phase 6, §5.7, §5.8).
 *
 * Money crosses the wire as **integer minor units** with a `Minor` suffix
 * (§5.26, R-C2) — poisha, never a decimal taka — and quantities at scale 3.
 *
 * Nothing here carries a computed total *in*. The POS shows every figure
 * instantly by running the same domain arithmetic in the browser, but what it
 * shows is never what it sends: the client posts lines, discounts and payments,
 * and the server recomputes every total from them (§2.4, DR13.12). A screen
 * that could send its own grand total is a screen that could sell at a price
 * nobody agreed to.
 */
const ULID = z.string().length(26);
const BUSINESS_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** `CASH:01J…` or `BANK:01J…` — validated properly in the use case (§2.4). */
const ACCOUNT_CODE = z.string().min(3).max(40);

export const saleSourceSchema = z.union([
  z.literal('OWN_STOCK'),
  z.literal('VENDOR_CONSIGNMENT'),
]);
export type SaleSource = z.infer<typeof saleSourceSchema>;

export const saleInventoryAllocationSchema = z
  .object({
    sourceType: z.enum(['OWNED', 'VENDOR', 'NEGATIVE']),
    qty: z.number().int().positive(),
    vendorPartyId: ULID.nullable().default(null),
    /** Exact units determine quantity for serialized products. */
    serialUnitIds: z.array(ULID).max(200).default([]),
  })
  .strict();
export type SaleInventoryAllocation = z.infer<typeof saleInventoryAllocationSchema>;

export const saleInventoryAllocationResponseSchema = saleInventoryAllocationSchema.extend({
  id: ULID,
  ownedLotId: ULID.nullable(),
  vendorStockReceiptId: ULID.nullable(),
  vendorLotId: ULID.nullable(),
  inventoryUnitId: ULID.nullable(),
  serialNo: z.string().nullable(),
  unitCostUsed: z.number().int().nullable(),
});

export const saleLineRequestSchema = z
  .object({
    productId: ULID,
    qty: z.number().int().positive(),
    unitPriceMinor: z.number().int().nonnegative(),
    /** Knocked off this line only; the bill discount is sent separately. */
    lineDiscountMinor: z.number().int().nonnegative().default(0),
    source: saleSourceSchema.default('OWN_STOCK'),
    /** Required for a consignment line, refused on an own-stock one (§5.7). */
    vendorPartyId: ULID.nullable().default(null),
    vendorUnitCostMinor: z.number().int().nonnegative().nullable().default(null),
    /** Durable mixed-origin allocation. Empty keeps old clients backward-compatible. */
    allocations: z.array(saleInventoryAllocationSchema).max(202).default([]),
  })
  .strict();
export type SaleLineRequest = z.infer<typeof saleLineRequestSchema>;

/** One row of the split: an amount and the account it actually landed in. */
export const salePaymentRequestSchema = z
  .object({
    accountCode: ACCOUNT_CODE,
    amountMinor: z.number().int().positive(),
  })
  .strict();
export type SalePaymentRequest = z.infer<typeof salePaymentRequestSchema>;

/**
 * Posting a counter sale.
 *
 * `partyId` names a registered customer. Left null, the sale posts on the
 * system walk-in party and the typed name and phone are kept as document
 * snapshots — **unless** it leaves a due or an advance, in which case the
 * server creates the customer inside the same transaction (§5.8), because a
 * balance has to belong to somebody the ledger can name.
 */
export const createSaleRequestSchema = z
  .object({
    partyId: ULID.nullable().default(null),
    customerName: z.string().trim().max(120).nullable().default(null),
    customerPhone: z.string().trim().max(32).nullable().default(null),
    customerGuardianName: z.string().trim().max(120).nullable().default(null),
    customerAddress: z.string().trim().max(300).nullable().default(null),
    /** Explicitly keep a guest as a customer (§5.8) — never implied by a sale. */
    saveAsCustomer: z.boolean().default(false),
    businessDate: BUSINESS_DATE.optional(),
    dueDate: BUSINESS_DATE.nullable().default(null),
    lines: z.array(saleLineRequestSchema).min(1).max(200),
    discountMinor: z.number().int().nonnegative().default(0),
    payments: z.array(salePaymentRequestSchema).max(10).default([]),
    /**
     * Money handed over beyond the bill: `CHANGE` is given back across the
     * counter and never posts, `ADVANCE` is kept and sits on the customer's
     * ledger. Anything else would leave the drawer disagreeing with the day.
     */
    overpaymentHandling: z.union([z.literal('CHANGE'), z.literal('ADVANCE')]).default('CHANGE'),
    /**
     * Sell below what is on hand. Refused unless the negative-stock policy
     * allows it; sent explicitly so the shopkeeper has actually seen the
     * warning rather than the server deciding quietly (§5.7).
     */
    allowNegativeStock: z.boolean().default(false),
    notes: z.string().trim().max(500).nullable().default(null),
    sourceQuotationId: ULID.nullable().default(null),
    sourceOrderId: ULID.nullable().default(null),
    correctionOf: ULID.nullable().default(null),
    correctionVersion: z.number().int().positive().nullable().default(null),
  })
  .strict();
export type CreateSaleRequest = z.infer<typeof createSaleRequestSchema>;

export const saleLineResponseSchema = z
  .object({
    id: ULID,
    productId: ULID,
    productName: z.string(),
    /** The label this invoice prints, when it has been overridden (§5.8). */
    displayName: z.string().nullable(),
    unitName: z.string(),
    qty: z.number().int(),
    unitPriceMinor: z.number().int(),
    lineDiscountMinor: z.number().int(),
    lineTotalMinor: z.number().int(),
    discountShareMinor: z.number().int(),
    netAmountMinor: z.number().int(),
    source: saleSourceSchema,
    vendorPartyId: ULID.nullable(),
    vendorName: z.string().nullable(),
    isProvisionalCost: z.boolean(),
    tracksSerial: z.boolean(),
    allocations: z.array(saleInventoryAllocationResponseSchema).default([]),
    /* Cost, and therefore absent without `inventory.cost.view` (UI-40, R-E8). */
    costMinor: z.number().int().optional(),
  })
  .strict();
export type SaleLineResponse = z.infer<typeof saleLineResponseSchema>;

export const salePaymentResponseSchema = z
  .object({
    id: ULID,
    accountCode: z.string(),
    accountName: z.string(),
    accountType: z.union([z.literal('CASH'), z.literal('BANK')]),
    amountMinor: z.number().int(),
  })
  .strict();
export type SalePaymentResponse = z.infer<typeof salePaymentResponseSchema>;

/** §5.8's cosmetic overrides — display only, never an accounting fact. */
export const invoicePresentationSchema = z
  .object({
    customerDisplayName: z.string().trim().max(120).nullable().default(null),
    customerPhone: z.string().trim().max(32).nullable().default(null),
    customerGuardianName: z.string().trim().max(120).nullable().default(null),
    customerAddress: z.string().trim().max(300).nullable().default(null),
    deliveryAddress: z.string().trim().max(300).nullable().default(null),
    courierName: z.string().trim().max(120).nullable().default(null),
    deliveryInstruction: z.string().trim().max(300).nullable().default(null),
    paymentNote: z.string().trim().max(300).nullable().default(null),
    customLabel1: z.string().trim().max(60).nullable().default(null),
    customValue1: z.string().trim().max(300).nullable().default(null),
    customLabel2: z.string().trim().max(60).nullable().default(null),
    customValue2: z.string().trim().max(300).nullable().default(null),
    customLabel3: z.string().trim().max(60).nullable().default(null),
    customValue3: z.string().trim().max(300).nullable().default(null),
    /** Per-line printed labels, by sale line id. */
    lineNames: z
      .array(z.object({ saleLineId: ULID, displayName: z.string().trim().min(1).max(160) }).strict())
      .max(200)
      .default([]),
  })
  .strict();
export type InvoicePresentation = z.infer<typeof invoicePresentationSchema>;

export const saleResponseSchema = z
  .object({
    id: ULID,
    number: z.string(),
    partyId: ULID,
    /** True when this posted on the shop's walk-in party (§5.8). */
    isWalkIn: z.boolean(),
    customerName: z.string(),
    customerPhone: z.string().nullable(),
    customerGuardianName: z.string().nullable(),
    customerAddress: z.string().nullable(),
    businessDate: BUSINESS_DATE,
    dueDate: BUSINESS_DATE.nullable(),
    status: z.union([z.literal('POSTED'), z.literal('VOIDED')]),
    notes: z.string().nullable(),
    lines: z.array(saleLineResponseSchema),
    payments: z.array(salePaymentResponseSchema),
    itemsTotalMinor: z.number().int(),
    discountMinor: z.number().int(),
    grandTotalMinor: z.number().int(),
    /** Taken at the counter plus everything received against it since. */
    paidMinor: z.number().int(),
    dueMinor: z.number().int(),
    changeMinor: z.number().int(),
    advanceMinor: z.number().int(),
    ageing: z.union([
      z.literal('NOT_DUE'),
      z.literal('D1_30'),
      z.literal('D31_60'),
      z.literal('D61_90'),
      z.literal('D90_PLUS'),
    ]),
    /** What the goods cost — absent without `inventory.cost.view`. */
    cogsMinor: z.number().int().optional(),
    profitMinor: z.number().int().optional(),
    /** D-32: sent back when this invoice is cancelled or corrected. */
    version: z.number().int(),
    presentation: invoicePresentationSchema.nullable(),
    receipts: z
      .array(
        z.object({
          id: ULID,
          number: z.string(),
          businessDate: BUSINESS_DATE,
          accountName: z.string(),
          amountMinor: z.number().int(),
        }),
      )
      .default([]),
    /** Said once, beside the data (§5.26) — a sale below cost, a stock warning. */
    warnings: z.array(z.string()).default([]),
    /**
     * Where this invoice was typed (Phase 12.4, §18).
     *
     * Permanent and informational. A synced offline sale is an ordinary posted
     * sale in every respect — same journal, same corrections, counted in every
     * report without qualification — and this exists so a shopkeeper
     * reconciling an outage afterwards can see which slips came in late. It
     * never changes how anything behaves, and never carries warning styling.
     */
    originMode: z.union([z.literal('ONLINE'), z.literal('OFFLINE')]).default('ONLINE'),
    /** The machine that typed it, and the moment it was typed. Both null online. */
    originDeviceName: z.string().nullable().default(null),
    originDeviceCode: z.string().nullable().default(null),
    deviceCreatedAt: z.string().nullable().default(null),
  })
  .strict();
export type SaleResponse = z.infer<typeof saleResponseSchema>;

export const saleListItemSchema = z
  .object({
    originMode: z.union([z.literal('ONLINE'), z.literal('OFFLINE')]).default('ONLINE'),
    id: ULID,
    number: z.string(),
    partyId: ULID,
    customerName: z.string(),
    customerPhone: z.string().nullable(),
    businessDate: BUSINESS_DATE,
    dueDate: BUSINESS_DATE.nullable(),
    status: z.union([z.literal('POSTED'), z.literal('VOIDED')]),
    grandTotalMinor: z.number().int(),
    paidMinor: z.number().int(),
    dueMinor: z.number().int(),
    ageing: z.union([
      z.literal('NOT_DUE'),
      z.literal('D1_30'),
      z.literal('D31_60'),
      z.literal('D61_90'),
      z.literal('D90_PLUS'),
    ]),
  })
  .strict();
export type SaleListItem = z.infer<typeof saleListItemSchema>;

export const saleListResponseSchema = z
  .object({
    items: z.array(saleListItemSchema),
    nextCursor: z.string().nullable(),
    totals: z
      .object({
        salesMinor: z.number().int(),
        receivedMinor: z.number().int(),
        dueMinor: z.number().int(),
        invoiceCount: z.number().int(),
      })
      .strict(),
  })
  .strict();
export type SaleListResponse = z.infer<typeof saleListResponseSchema>;

export const saleListQuerySchema = z
  .object({
    /** One box: an invoice number or a phone number (owner decision). */
    search: z.string().trim().max(64).optional(),
    partyId: ULID.optional(),
    fromDate: BUSINESS_DATE.optional(),
    toDate: BUSINESS_DATE.optional(),
    unpaidOnly: z.coerce.boolean().optional(),
    /** Phase 12.4 (§18): all invoices, or only the ones typed during an outage. */
    origin: z.union([z.literal('ALL'), z.literal('ONLINE'), z.literal('OFFLINE')]).optional(),
    cursor: z.string().max(120).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();
export type SaleListQuery = z.infer<typeof saleListQuerySchema>;

/**
 * Receiving money from a customer (§5.8).
 *
 * `saleIds` empty means "against whatever they owe, oldest first" — the
 * customer-hub entry point. Naming one invoice is the same call from the
 * invoice screen; both run one service, so both allocate and post identically.
 */
export const receiveCustomerPaymentRequestSchema = z
  .object({
    customerPartyId: ULID,
    accountCode: ACCOUNT_CODE,
    amountMinor: z.number().int().positive(),
    saleIds: z.array(ULID).max(200).default([]),
    businessDate: BUSINESS_DATE.optional(),
    note: z.string().trim().max(300).nullable().default(null),
  })
  .strict();
export type ReceiveCustomerPaymentRequest = z.infer<typeof receiveCustomerPaymentRequestSchema>;

/**
 * Correcting a posted receipt (Phase 9.2). The whole receipt is sent again —
 * the server reverses what was posted, re-posts these figures under the same
 * number and re-allocates them against what the customer owes now.
 */
export const correctCustomerPaymentRequestSchema = receiveCustomerPaymentRequestSchema
  .extend({
    version: z.number().int().nonnegative(),
    reason: z.string().trim().max(300).nullable().default(null),
  })
  .strict();

export type CorrectCustomerPaymentRequest = z.infer<typeof correctCustomerPaymentRequestSchema>;


export const customerReceiptResponseSchema = z
  .object({
    id: ULID,
    number: z.string(),
    customerPartyId: ULID,
    customerName: z.string(),
    accountCode: z.string(),
    accountName: z.string(),
    amountMinor: z.number().int(),
    settledMinor: z.number().int(),
    advanceMinor: z.number().int(),
    businessDate: BUSINESS_DATE,
    note: z.string().nullable(),
    allocations: z.array(
      z.object({ saleId: ULID, saleNumber: z.string(), amountMinor: z.number().int() }).strict(),
    ),
    /** Phase 9.2: what a correction and a cancellation need, and what they leave. */
    status: z.enum(['POSTED', 'VOIDED']).default('POSTED'),
    entryMode: z.string().default('ON_TIME'),
    voidReason: z.string().nullable().default(null),
    version: z.number().int().default(1),
  })
  .strict();
export type CustomerReceiptResponse = z.infer<typeof customerReceiptResponseSchema>;

/** What the customer panel shows the moment a customer or phone resolves. */
export const customerStandingResponseSchema = z
  .object({
    partyId: ULID.nullable(),
    name: z.string().nullable(),
    phone: z.string().nullable(),
    /** From journal lines, never recomputed from invoices (§5.8, INV-06). */
    dueMinor: z.number().int(),
    advanceMinor: z.number().int(),
    creditLimitMinor: z.number().int().nullable(),
    openInvoices: z.array(
      z
        .object({
          id: ULID,
          number: z.string(),
          businessDate: BUSINESS_DATE,
          dueDate: BUSINESS_DATE.nullable(),
          grandTotalMinor: z.number().int(),
          outstandingMinor: z.number().int(),
        })
        .strict(),
    ),
  })
  .strict();
export type CustomerStandingResponse = z.infer<typeof customerStandingResponseSchema>;

/** What the POS grid needs for one product, including its live stock state. */
export const posProductSchema = z
  .object({
    id: ULID,
    name: z.string(),
    sku: z.string().nullable(),
    barcode: z.string().nullable(),
    brandName: z.string().nullable(),
    categoryName: z.string().nullable(),
    unitName: z.string(),
    sellingPriceMinor: z.number().int(),
    /** The customer group's price when dealer pricing is on and one applies. */
    groupPriceMinor: z.number().int().nullable(),
    qtyOnHand: z.number().int(),
    sellableOwnedQty: z.number().int().nonnegative(),
    minStockQty: z.number().int(),
    stockStatus: z.union([
      z.literal('IN_STOCK'),
      z.literal('LOW_STOCK'),
      z.literal('ZERO_STOCK'),
      z.literal('NEGATIVE_STOCK'),
    ]),
    hasImage: z.boolean(),
    tracksSerial: z.boolean(),
    /**
     * The precomputed, normalised line this product is found by (0026).
     *
     * Sent so the browser can narrow and rank the page it already has while a
     * request is in flight — with the same domain rule the server used, which
     * is what stops the grid reordering itself when the response lands.
     */
    searchText: z.string(),
    /* The eye. Absent without `inventory.cost.view` (UI-40, R-E8). */
    purchasePriceMinor: z.number().int().optional(),
  })
  .strict();
export type PosProduct = z.infer<typeof posProductSchema>;

export const posProductListSchema = z
  .object({
    items: z.array(posProductSchema),
    nextCursor: z.string().nullable(),
    negativeStockPolicy: z.enum(['BLOCK', 'WARN', 'ALLOW']),
  })
  .strict();
export type PosProductList = z.infer<typeof posProductListSchema>;

export const posProductQuerySchema = z
  .object({
    search: z.string().trim().max(120).optional(),
    /** An exact barcode: resolves to one product and adds it to the cart. */
    barcode: z.string().trim().max(64).optional(),
    categoryId: ULID.optional(),
    brandId: ULID.optional(),
    stockStatus: z
      .union([
        z.literal('IN_STOCK'),
        z.literal('LOW_STOCK'),
        z.literal('ZERO_STOCK'),
        z.literal('NEGATIVE_STOCK'),
      ])
      .optional(),
    customerPartyId: ULID.optional(),
    cursor: z.string().max(120).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();
export type PosProductQuery = z.infer<typeof posProductQuerySchema>;

/** §5.8's invoice design settings — one row per tenant, one renderer. */
export const invoiceSettingsSchema = z
  .object({
    language: z.union([z.literal('EN'), z.literal('BN')]),
    defaultTemplate: z.union([z.literal('A4'), z.literal('THERMAL_80')]),
    showLogo: z.boolean(),
    showBusinessBlock: z.boolean(),
    showCustomerBlock: z.boolean(),
    showSku: z.boolean(),
    showBarcode: z.boolean(),
    showDiscount: z.boolean(),
    showPaymentBreakdown: z.boolean(),
    showDue: z.boolean(),
    showAmountInWords: z.boolean(),
    /**
     * The shop's own header (owner decision 2026-08-25). A Bangladeshi invoice
     * opens with a line of its own — বিসমিল্লাহির রাহমানির রাহিম on most of
     * them — calls itself a Cash Memo rather than an Invoice, and prints the
     * trading name the shopkeeper wants on paper, which is not always the
     * registered business profile. Null means "use the business profile".
     */
    headerText: z.string().nullable(),
    showHeaderText: z.boolean(),
    invoiceTitle: z.string().nullable(),
    businessNameEn: z.string().nullable(),
    proprietorName: z.string().nullable(),
    proprietorNote: z.string().nullable(),
    businessDescription: z.string().nullable(),
    businessPhone2: z.string().nullable(),
    /** Every number the shop prints, in the order it wants them (owner decision). */
    contactPhones: z.array(
      z.object({ label: z.string().max(40), number: z.string().max(40) }).strict(),
    ),
    /** Where a customer can send money: বিকাশ, নগদ, each with its number. */
    mfsNumbers: z.array(
      z.object({ label: z.string().max(40), number: z.string().max(40) }).strict(),
    ),
    /** The lines printed at the foot of every invoice, in order. */
    terms: z.array(z.string().max(200)),
    paymentTermsDays: z.number().int().min(0).max(365),
    paymentTermsLabel: z.string().nullable(),
    thermalPaper: z.union([z.literal('58mm'), z.literal('80mm')]),
    showSignatureLines: z.boolean(),
    /** True when a logo has been uploaded; the bytes are served separately. */
    hasLogo: z.boolean(),
    businessName: z.string().nullable(),
    businessAddress: z.string().nullable(),
    businessPhone: z.string().nullable(),
    footerText: z.string().nullable(),
    termsText: z.string().nullable(),
    businessPadEnabled: z.boolean(),
    businessPadTopMm: z.number().int().min(0).max(150),
    pageMarginMm: z.number().int().min(0).max(50),
  })
  .strict();
export type InvoiceSettings = z.infer<typeof invoiceSettingsSchema>;

export const updateInvoiceSettingsRequestSchema = invoiceSettingsSchema.partial().strict();
export type UpdateInvoiceSettingsRequest = z.infer<typeof updateInvoiceSettingsRequestSchema>;

/** The wholesale drafts (§5.7). They reserve nothing and post nothing. */
export const quotationLineRequestSchema = z
  .object({
    productId: ULID,
    qty: z.number().int().positive(),
    unitPriceMinor: z.number().int().nonnegative(),
    lineDiscountMinor: z.number().int().nonnegative().default(0),
  })
  .strict();
export type QuotationLineRequest = z.infer<typeof quotationLineRequestSchema>;

export const createQuotationRequestSchema = z
  .object({
    kind: z.union([z.literal('QUOTATION'), z.literal('ORDER')]).default('QUOTATION'),
    partyId: ULID.nullable().default(null),
    customerName: z.string().trim().min(1).max(120),
    customerPhone: z.string().trim().max(32).nullable().default(null),
    validUntil: BUSINESS_DATE.nullable().default(null),
    businessDate: BUSINESS_DATE.optional(),
    lines: z.array(quotationLineRequestSchema).min(1).max(200),
    discountMinor: z.number().int().nonnegative().default(0),
    notes: z.string().trim().max(500).nullable().default(null),
    sourceQuotationId: ULID.nullable().default(null),
  })
  .strict();
export type CreateQuotationRequest = z.infer<typeof createQuotationRequestSchema>;

export const quotationResponseSchema = z
  .object({
    id: ULID,
    kind: z.union([z.literal('QUOTATION'), z.literal('ORDER')]),
    number: z.string(),
    partyId: ULID.nullable(),
    customerName: z.string(),
    customerPhone: z.string().nullable(),
    validUntil: BUSINESS_DATE.nullable(),
    businessDate: BUSINESS_DATE,
    status: z.string(),
    itemsTotalMinor: z.number().int(),
    discountMinor: z.number().int(),
    grandTotalMinor: z.number().int(),
    notes: z.string().nullable(),
    lines: z.array(
      z
        .object({
          id: ULID,
          productId: ULID,
          productName: z.string(),
          unitName: z.string(),
          qty: z.number().int(),
          unitPriceMinor: z.number().int(),
          lineDiscountMinor: z.number().int(),
          lineTotalMinor: z.number().int(),
          qtyConverted: z.number().int(),
        })
        .strict(),
    ),
  })
  .strict();
export type QuotationResponse = z.infer<typeof quotationResponseSchema>;

/** The shop's logo, resized in the browser before it is sent (§5.8). */
export const saveInvoiceLogoRequestSchema = z
  .object({
    mime: z.union([
      z.literal('image/webp'),
      z.literal('image/jpeg'),
      z.literal('image/png'),
      z.literal('image/gif'),
    ]),
    dataBase64: z.string().min(16).max(2 * 1024 * 1024),
  })
  .strict();
export type SaveInvoiceLogoRequest = z.infer<typeof saveInvoiceLogoRequestSchema>;

/**
 * A parked cart (§5.7, owner decision 2026-08-26).
 *
 * **Not a document.** It has no number, posts nothing and may be deleted — the
 * whole point of it is to be neither a sale nor a loss. The cart travels as
 * opaque JSON because it is one screen's unfinished state, written by the POS
 * and read back by the POS; the server stores it and never reasons about it.
 */
export const saveSaleDraftRequestSchema = z
  .object({
    label: z.string().trim().min(1).max(80),
    customerName: z.string().trim().max(120).nullable().default(null),
    itemCount: z.number().int().min(0).max(500),
    grandTotalMinor: z.number().int().min(0),
    cart: z.record(z.unknown()),
  })
  .strict();
export type SaveSaleDraftRequest = z.infer<typeof saveSaleDraftRequestSchema>;

export const saleDraftResponseSchema = z
  .object({
    id: ULID,
    label: z.string(),
    customerName: z.string().nullable(),
    itemCount: z.number().int(),
    grandTotalMinor: z.number().int(),
    businessDate: BUSINESS_DATE,
    savedAt: z.string(),
    cart: z.record(z.unknown()),
  })
  .strict();
export type SaleDraftResponse = z.infer<typeof saleDraftResponseSchema>;
