import { z } from 'zod';

const ULID = z.string().length(26);
const BUSINESS_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * What the shop spends (§5.12, Phase 7).
 *
 * An expense is one payment out with a reason attached: a category, optionally
 * a payee, and the account it came from. It posts `DR EXPENSE:{cat}` against
 * `CR CASH:{id}` or `CR BANK:{id}` — the category is part of the account code
 * (§2.4), so "how much salary this month" is a balance rather than a filter.
 */

export const expenseCategorySchema = z
  .object({
    id: ULID,
    /** The account segment: `EXPENSE:SALARY`. Fixed once it holds history. */
    code: z.string(),
    name: z.string(),
    isSystem: z.boolean(),
    status: z.enum(['ACTIVE', 'ARCHIVED']),
    /** How much has gone through it, in the range the list is showing. */
    spentMinor: z.number().int(),
  })
  .strict();

export type ExpenseCategoryResponse = z.infer<typeof expenseCategorySchema>;

export const saveExpenseCategoryRequestSchema = z
  .object({
    name: z.string().trim().min(2).max(60),
  })
  .strict();

export type SaveExpenseCategoryRequest = z.infer<typeof saveExpenseCategoryRequestSchema>;

export const recordExpenseRequestSchema = z
  .object({
    categoryId: ULID,
    /** Poisha. A zero expense is refused: nothing happened. */
    amountMinor: z.number().int().positive(),
    /** `CASH:{id}` or `BANK:{id}` — where the money actually left from. */
    accountCode: z.string().max(60),
    payeePartyId: ULID.nullable().default(null),
    note: z.string().trim().max(500).nullable().default(null),
    businessDate: BUSINESS_DATE.optional(),
    backdateReason: z.string().trim().max(300).nullable().default(null),
  })
  .strict();

export type RecordExpenseRequest = z.infer<typeof recordExpenseRequestSchema>;

/**
 * Cancelling and correcting a posted expense (Phase 9.2, §2.5).
 *
 * **A reason is mandatory to cancel** (owner rule 2026-08-30) — the ledger's
 * own before/after values explain a correction, and nothing explains a
 * cancellation except the person who made it. `version` is D-32's optimistic
 * lock: whoever saves second is told rather than overwriting the first.
 */
export const voidDocumentRequestSchema = z
  .object({
    version: z.number().int().nonnegative(),
    reason: z.string().trim().min(3).max(300),
  })
  .strict();

export type VoidDocumentRequest = z.infer<typeof voidDocumentRequestSchema>;

/**
 * A correction carries the whole document again, not a patch: the server
 * reverses what was posted and re-posts these figures under the same number,
 * so what is sent is what the expense **becomes**.
 *
 * `reason` is optional for a same-day fix and required when the correction
 * cannot post on its own date — a backdated one, or one whose month has closed
 * and which therefore posts today as a prior-period adjustment.
 */
export const correctExpenseRequestSchema = recordExpenseRequestSchema
  .extend({
    version: z.number().int().nonnegative(),
    reason: z.string().trim().max(300).nullable().default(null),
  })
  .strict();

export type CorrectExpenseRequest = z.infer<typeof correctExpenseRequestSchema>;

export const expenseSchema = z
  .object({
    id: ULID,
    number: z.string(),
    categoryId: ULID,
    categoryName: z.string(),
    payeePartyId: ULID.nullable(),
    payeeName: z.string().nullable(),
    amountMinor: z.number().int(),
    accountCode: z.string(),
    accountName: z.string().nullable(),
    note: z.string().nullable(),
    businessDate: BUSINESS_DATE,
    status: z.enum(['POSTED', 'VOIDED']),
    /** `CORRECTED` and `PRIOR_PERIOD` say this figure is not the first one posted. */
    entryMode: z.string(),
    voidReason: z.string().nullable(),
    correctionReason: z.string().nullable(),
    /** Set when a correction could not post on the day it belongs to. */
    originalBusinessDate: BUSINESS_DATE.nullable(),
    version: z.number().int(),
    createdAt: z.string(),
  })
  .strict();

export type ExpenseResponse = z.infer<typeof expenseSchema>;

export const expenseListResponseSchema = z
  .object({
    expenses: z.array(expenseSchema),
    nextCursor: z.string().nullable(),
    totalMinor: z.number().int(),
    /** What each category came to in this view — the tiles and the manager. */
    categories: z.array(expenseCategorySchema),
  })
  .strict();

export type ExpenseListResponse = z.infer<typeof expenseListResponseSchema>;
