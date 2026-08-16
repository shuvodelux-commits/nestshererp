import { z } from 'zod';

/**
 * Contract for the reference use case. Money crosses the wire as integer minor
 * units with a `Minor` suffix — never a float, never a formatted string (§5.26).
 *
 * `tenant_id` appears nowhere in this contract, by design: it comes from the
 * token via TenantContext and must never be accepted from a payload (R-C4).
 */
export const createNoteRequestSchema = z
  .object({
    title: z.string().min(1).max(200),
    amountMinor: z.number().int(),
    businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'businessDate must be YYYY-MM-DD'),
  })
  .strict();

export type CreateNoteRequest = z.infer<typeof createNoteRequestSchema>;

export const noteResponseSchema = z
  .object({
    id: z.string().length(26),
    noteNumber: z.string(),
    title: z.string(),
    amountMinor: z.number().int(),
    businessDate: z.string(),
    entryMode: z.enum(['ON_TIME', 'LATE_ENTRY', 'BACKDATED', 'CORRECTED']),
    status: z.enum(['DRAFT', 'POSTED', 'VOIDED']),
  })
  .strict();

export type NoteResponse = z.infer<typeof noteResponseSchema>;
