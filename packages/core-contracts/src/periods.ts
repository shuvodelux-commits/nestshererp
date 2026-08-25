import { z } from 'zod';

/**
 * Closing an accounting month (§5.19, D-25, owner decision 2026-08-26).
 *
 * **A closed month is final.** There is no unlock: a correction posts in the
 * month that is open, the way accountants everywhere handle a closed book. The
 * owner chose this over a controlled unlock, and it is what makes a closed
 * period a guarantee rather than a speed bump.
 */
export const periodSchema = z
  .object({
    /** `YYYY-MM` — the month a business date falls in. */
    period: z.string().regex(/^\d{4}-\d{2}$/),
    year: z.number().int(),
    month: z.number().int(),
    status: z.enum(['OPEN', 'CLOSED']),
    /** How many journal entries the month holds — what closing would freeze. */
    entryCount: z.number().int(),
    closedAt: z.string().nullable(),
    closedByName: z.string().nullable(),
    /** The month a business date is in today: it cannot be closed yet. */
    isCurrent: z.boolean(),
  })
  .strict();

export type PeriodResponse = z.infer<typeof periodSchema>;

export const periodListResponseSchema = z
  .object({ periods: z.array(periodSchema) })
  .strict();

export type PeriodListResponse = z.infer<typeof periodListResponseSchema>;

export const closePeriodRequestSchema = z
  .object({
    year: z.number().int().min(2000).max(2999),
    month: z.number().int().min(1).max(12),
    note: z.string().trim().max(300).nullable().default(null),
  })
  .strict();

export type ClosePeriodRequest = z.infer<typeof closePeriodRequestSchema>;
