import { z } from 'zod';

/**
 * Daybook (§5.27, D-27) — the shop owner's daily review screen.
 *
 * **Daybook owns no business tables and posts nothing.** Everything in this
 * file is either a read, or the two things Daybook is allowed to write about
 * itself: that a day was checked, and that a day was printed. Every action on
 * a row goes to the owning module's own use case (DR1), which is why no
 * schema here describes a sale, a receipt or an expense — only which of those
 * actions a row supports.
 */

const ULID = z.string().length(26);
const BUSINESS_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * `BUSINESS_DATE` is the day a transaction belongs to and is the default
 * (DR3). `CREATED_AT` is the audit view — the moment it was actually typed —
 * and needs `daybook.view.entry_date`.
 */
export const dateBasisSchema = z.enum(['BUSINESS_DATE', 'CREATED_AT']);
export type DateBasis = z.infer<typeof dateBasisSchema>;

/**
 * What a row is, in the shopkeeper's terms rather than the ledger's.
 *
 * These are journal `source_document_type` values grouped into the kinds a
 * person recognises, because "PURCHASE_REVERSAL" is not a thing anybody at a
 * counter has heard of; the screen labels them and the filter uses them.
 */
export const daybookKindSchema = z.enum([
  'SALE',
  'SALES_RETURN',
  'PURCHASE',
  'PURCHASE_RETURN',
  'CUSTOMER_RECEIPT',
  'SUPPLIER_PAYMENT',
  'EXPENSE',
  'CASH_MOVEMENT',
  'STOCK_ADJUSTMENT',
  'STOCK_COUNT',
  'OPENING',
  'DAY_CLOSE',
  'WARRANTY',
  'VENDOR_STOCK',
  'OTHER',
]);
export type DaybookKind = z.infer<typeof daybookKindSchema>;

export const daybookQuerySchema = z
  .object({
    from: BUSINESS_DATE,
    to: BUSINESS_DATE,
    dateBasis: dateBasisSchema.default('BUSINESS_DATE'),
    kind: daybookKindSchema.optional(),
    partyId: ULID.optional(),
    userId: ULID.optional(),
    accountCode: z.string().max(64).optional(),
    cursor: z.string().max(64).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  })
  .strict();
export type DaybookQuery = z.infer<typeof daybookQuerySchema>;

/**
 * What may be done to a row, decided by the server.
 *
 * The screen draws the ⋯ menu from these flags and never guesses: whether a
 * bill can still be corrected depends on the period lock, the document's
 * status, what has been drawn from its lots and the user's own permissions —
 * four things the browser does not know. `edit` and `remove` are the
 * shopkeeper's words for **correct** (reversal and repost, same number) and
 * **void** (reversal); a posted document is never mutated and never deleted
 * (§2.5).
 */
export const daybookActionsSchema = z
  .object({
    open: z.boolean(),
    edit: z.boolean(),
    remove: z.boolean(),
    receivePayment: z.boolean(),
    payBill: z.boolean(),
    returnGoods: z.boolean(),
    /**
     * Phase 11.2. Unlike the others this one may be offered on a row inside a
     * closed month — a closed period is protected, not immutable, and the
     * owner who may reach into one is told what that costs at the dialog
     * (owner decision 2026-08-31).
     */
    changeDate: z.boolean(),
    print: z.boolean(),
    /** Why an action is unavailable, in one sentence a person can act on. */
    blockedReason: z.string().nullable(),
  })
  .strict();
export type DaybookActions = z.infer<typeof daybookActionsSchema>;

export const daybookRowSchema = z
  .object({
    id: ULID,
    kind: daybookKindSchema,
    sourceType: z.string(),
    sourceId: ULID,
    sourceNumber: z.string(),
    businessDate: BUSINESS_DATE,
    createdAt: z.string(),
    createdBy: ULID,
    createdByName: z.string(),
    description: z.string(),
    partyId: ULID.nullable(),
    partyName: z.string().nullable(),
    accountCode: z.string().nullable(),
    accountLabel: z.string().nullable(),
    /** The row's headline figure, always positive; `direction` carries the sign. */
    amountMinor: z.number().int(),
    /** Cash and bank effect only — what the day's money summary adds up. */
    cashEffectMinor: z.number().int(),
    qty: z.number().int().nullable(),
    status: z.enum(['POSTED', 'VOIDED', 'CORRECTED', 'REVERSAL']),
    /** The entry that undid this one, so a voided row links to its reversal (DR4). */
    reversedByNumber: z.string().nullable(),
    /** DR5 — a row inside a closed month is read-only, and says why. */
    locked: z.boolean(),
    /** DR7 — recorded on a different day than the one it belongs to. */
    backdated: z.boolean(),
    /**
     * Phase 11.2 — the day this document sat on before it was moved, so the
     * `CORRECTED` badge can say *moved from 12 Aug* rather than only that
     * something was corrected. Null on a document that has never been moved.
     */
    originalBusinessDate: BUSINESS_DATE.nullable(),
    /** Why it was corrected or moved, shown with the badge above. */
    correctionReason: z.string().nullable(),
    entryMode: z.string(),
    /**
     * The owning document's version, so a cancellation started from here
     * carries D-32's optimistic lock: whoever saves second is told rather than
     * undoing something that changed underneath them.
     */
    documentVersion: z.number().int().nullable(),
    actions: daybookActionsSchema,
  })
  .strict();
export type DaybookRow = z.infer<typeof daybookRowSchema>;

export const daybookMovementSchema = z
  .object({
    id: ULID,
    label: z.string(),
    reason: z.string().nullable(),
    amountMinor: z.number().int(),
    accountLabel: z.string(),
  })
  .strict();
export type DaybookMovement = z.infer<typeof daybookMovementSchema>;

/**
 * The money summary at the top of a day (§5.27, cash drawer session history).
 * These come from the session rows and the journal — Daybook recomputes
 * nothing of its own.
 *
 * A shortage or an overage belongs to the day it was counted and is never
 * netted against another day, so this is per-day and not a range figure.
 */
export const daybookDaySummarySchema = z
  .object({
    businessDate: BUSINESS_DATE,
    openingCashMinor: z.number().int(),
    cashInMinor: z.number().int(),
    cashOutMinor: z.number().int(),
    expectedClosingMinor: z.number().int(),
    countedMinor: z.number().int().nullable(),
    differenceMinor: z.number().int().nullable(),
    /** DR6 — the previous day's close disagreeing with this day's opening. */
    openingMismatchMinor: z.number().int(),
    dayStatus: z.enum(['NOT_STARTED', 'OPEN', 'CLOSED']),
    movements: z.array(daybookMovementSchema),
    salesMinor: z.number().int(),
    purchasesMinor: z.number().int(),
    receiptsMinor: z.number().int(),
    paymentsMinor: z.number().int(),
    expensesMinor: z.number().int(),
    returnsMinor: z.number().int(),
    transactionCount: z.number().int(),
    reviewedAt: z.string().nullable(),
    reviewedByName: z.string().nullable(),
    reviewNote: z.string().nullable(),
  })
  .strict();
export type DaybookDaySummary = z.infer<typeof daybookDaySummarySchema>;

export const daybookResponseSchema = z
  .object({
    from: BUSINESS_DATE,
    to: BUSINESS_DATE,
    dateBasis: dateBasisSchema,
    /** One per business date in the range, newest first. */
    days: z.array(daybookDaySummarySchema),
    rows: z.array(daybookRowSchema),
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
    /** False when the user lacks `daybook.view.all_users` (§5.27). */
    allUsers: z.boolean(),
    /**
     * DR7 — entries dated inside the range but recorded outside it, and the
     * other way round. The printed report cannot omit them and neither can the
     * screen.
     */
    backdatedRows: z.array(daybookRowSchema),
  })
  .strict();
export type DaybookResponse = z.infer<typeof daybookResponseSchema>;

export const markDayReviewedRequestSchema = z
  .object({
    businessDate: BUSINESS_DATE,
    note: z.string().trim().max(500).nullable().default(null),
  })
  .strict();
export type MarkDayReviewedRequest = z.infer<typeof markDayReviewedRequestSchema>;

export const dayReviewSchema = z
  .object({
    businessDate: BUSINESS_DATE,
    reviewedAt: z.string(),
    reviewedByName: z.string(),
    note: z.string().nullable(),
  })
  .strict();
export type DayReview = z.infer<typeof dayReviewSchema>;

export const daybookPrintFormatSchema = z.enum(['A4', 'THERMAL_80']);
export type DaybookPrintFormat = z.infer<typeof daybookPrintFormatSchema>;

export const daybookPrintRequestSchema = z
  .object({
    from: BUSINESS_DATE,
    to: BUSINESS_DATE,
    format: daybookPrintFormatSchema.default('A4'),
    /** Set when reprinting an earlier print, which stamps the copy REPRINT. */
    reprintOfId: ULID.optional(),
  })
  .strict();
export type DaybookPrintRequest = z.infer<typeof daybookPrintRequestSchema>;

/**
 * A recorded print (§5.27, `daybook_prints`).
 *
 * It exists so a reprint can be proved identical to — or explicitly different
 * from — the paper somebody is holding, which is why its totals are stored
 * rather than recomputed when the row is read.
 */
export const daybookPrintSchema = z
  .object({
    id: ULID,
    from: BUSINESS_DATE,
    to: BUSINESS_DATE,
    format: daybookPrintFormatSchema,
    printedAt: z.string(),
    printedByName: z.string(),
    openingCashMinor: z.number().int(),
    closingCashMinor: z.number().int(),
    transactionCount: z.number().int(),
    salesMinor: z.number().int(),
    purchasesMinor: z.number().int(),
    receiptsMinor: z.number().int(),
    paymentsMinor: z.number().int(),
    expensesMinor: z.number().int(),
    isReprint: z.boolean(),
    reprintOfId: ULID.nullable(),
    printSerial: z.number().int(),
  })
  .strict();
export type DaybookPrint = z.infer<typeof daybookPrintSchema>;
