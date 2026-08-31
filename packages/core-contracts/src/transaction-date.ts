import { z } from 'zod';

/**
 * Change Transaction Date (Phase 11.2, §5.15, D-43, UI-70, UI-72).
 *
 * **One authoritative action behind every screen that offers it.** Daybook, the
 * party and account ledgers and the reconciliation compare screen all send this
 * one request; none of them re-implements the rule, and none of them writes a
 * date itself. UI-72 in one file.
 *
 * The date that moves is `business_date` — the day the money actually changed
 * hands. `created_at` is never touched by anything here, which is the whole of
 * D-43: the shop may correct *when a thing happened*, and may never rewrite
 * *when it was typed*.
 *
 * Nothing in this contract carries the document's figures. A date change is
 * exactly one field wide, so the request names the document, the day it should
 * move to and why — and the server re-posts what was already there. A screen
 * that had to resend the amount could send a different one.
 */

const ULID = z.string().length(26);
const BUSINESS_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * The documents a date may be changed on.
 *
 * The same four `reverse-money-document.ts` already knows how to reverse and
 * re-post: each posted exactly one balanced journal entry and moved no stock,
 * so moving one to another day is a matter of the entry and nothing else. A
 * sale or a purchase would also have to move its stock movements and re-run
 * cost layering, which is that module's arithmetic — those keep the date field
 * inside their own correction form (owner decision 2026-08-31).
 */
export const redatableDocumentSchema = z.enum([
  'EXPENSE',
  'CUSTOMER_RECEIPT',
  'SUPPLIER_PAYMENT',
  'CASH_MOVEMENT',
]);
export type RedatableDocument = z.infer<typeof redatableDocumentSchema>;

/**
 * Why the date is being changed — a tap, not a sentence (UI-75).
 *
 * A reason is never blank (owner decision 2026-08-31): the `CORRECTED` badge is
 * only worth opening if it always says something. Free typing is required only
 * for `OTHER`, so the common cases cost one tap and the uncommon one is still
 * explainable.
 */
export const redateReasonCodeSchema = z.enum([
  /** The day was simply typed wrongly. */
  'WRONG_DATE',
  /** Recorded days after it happened, and filed on the day of entry. */
  'ENTERED_LATE',
  /** The bank's own date for the same money differs from ours. */
  'BANK_DATE',
  'OTHER',
]);
export type RedateReasonCode = z.infer<typeof redateReasonCodeSchema>;

export const changeTransactionDateRequestSchema = z
  .object({
    documentType: redatableDocumentSchema,
    documentId: ULID,
    /**
     * D-32's optimistic lock. Whoever saves second is told, rather than moving
     * a document somebody else has already changed underneath them.
     */
    version: z.number().int().min(1),
    businessDate: BUSINESS_DATE,
    reasonCode: redateReasonCodeSchema,
    /** Required when `reasonCode` is `OTHER`, and only then. */
    reasonText: z.string().trim().max(500).nullable().default(null),
    /**
     * The caller's own password, sent only when a closed month is involved
     * (§5.3 step-up). A PIN never satisfies it.
     */
    confirmPassword: z.string().max(200).nullable().default(null),
    /**
     * Set once the person has read the closed-period warning. The server
     * refuses a closed-month move without it even from an Owner, so the
     * warning cannot be skipped by a client that forgot to draw it.
     */
    acknowledgeClosedPeriod: z.boolean().default(false),
  })
  .strict();
export type ChangeTransactionDateRequest = z.infer<typeof changeTransactionDateRequestSchema>;

/**
 * What the screen needs before it can ask the question sensibly.
 *
 * Fetched when the dialog opens: which day the document is on now, whether
 * either month is closed, and whether this person may go there at all. It keeps
 * the browser from having to know the period calendar, and it means the warning
 * and the password field appear because the server said so.
 */
export const transactionDateContextSchema = z
  .object({
    documentType: redatableDocumentSchema,
    documentId: ULID,
    number: z.string(),
    version: z.number().int(),
    businessDate: BUSINESS_DATE,
    /** Where it was before the last move, when it has been moved before. */
    originalBusinessDate: BUSINESS_DATE.nullable(),
    amountMinor: z.number().int(),
    /** Today in the shop's timezone — the latest day a transaction may claim. */
    today: BUSINESS_DATE,
    currentPeriodOpen: z.boolean(),
    mayChange: z.boolean(),
    mayChangeLocked: z.boolean(),
    /**
     * The day of the earliest invoice or bill this money settles, when it
     * settles any. A payment may not be dated before the debt it clears, so the
     * screen greys out everything before this rather than letting the shop find
     * out at Save.
     */
    earliestAllocatedDate: BUSINESS_DATE.nullable(),
    earliestAllocatedNumber: z.string().nullable(),
    /**
     * Set when the money went through a counted drawer. A drawer's day is
     * closed and counted once (§5.16.8, UI-71), so such a voucher may only move
     * within the session still open.
     */
    drawerSessionDate: BUSINESS_DATE.nullable(),
  })
  .strict();
export type TransactionDateContext = z.infer<typeof transactionDateContextSchema>;

export const changeTransactionDateResponseSchema = z
  .object({
    documentType: redatableDocumentSchema,
    documentId: ULID,
    number: z.string(),
    fromBusinessDate: BUSINESS_DATE,
    toBusinessDate: BUSINESS_DATE,
    entryMode: z.string(),
    version: z.number().int(),
    /** True when a closed month was involved and the Owner stepped up. */
    closedPeriodOverride: z.boolean(),
    /**
     * How many completed reconciliations now read `REVIEW_REQUIRED` because of
     * this move. Nothing was written into them — their stored posting count
     * simply no longer agrees with the journal (§5.17).
     */
    reconciliationsUnderReview: z.number().int(),
  })
  .strict();
export type ChangeTransactionDateResponse = z.infer<typeof changeTransactionDateResponseSchema>;
