import { z } from 'zod';

/**
 * An unfinished purchasing screen, NOT an actual purchase.
 * The server stores the editor snapshot without inferring a journal, stock,
 * document number, payment or inventory cost from the preview amounts.
 * Images must be staged as future asset IDs; inline data URLs are not accepted.
 */
const draftPayload = z.object({
  label: z.string().trim().min(1).max(80),
  supplierName: z.string().trim().max(120).nullable(),
  itemCount: z.number().int().min(0).max(500),
  grandTotalMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  cart: z.record(z.unknown()),
}).strict();

function boundedCart(value: z.infer<typeof draftPayload>): boolean {
  const raw = JSON.stringify(value.cart);
  return raw.length <= 120_000 && !/data:(?:image|application)\//i.test(raw);
}

const draftLimitMessage = 'Draft is too large or contains inline attachments. Stage attachments separately.';

export const createPurchaseDraftRequestSchema =
  draftPayload.refine(boundedCart, draftLimitMessage);
export const updatePurchaseDraftRequestSchema =
  draftPayload.extend({ expectedVersion: z.number().int().positive() })
    .refine(boundedCart, draftLimitMessage);
export const purchaseDraftVersionRequestSchema =
  z.object({ expectedVersion: z.number().int().positive() }).strict();
export const purchaseDraftListQuerySchema =
  z.object({ state: z.enum(['active', 'deleted']).default('active') }).strict();

export const purchaseDraftResponseSchema = draftPayload.extend({
  id: z.string().length(26),
  businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  savedAt: z.string(),
  createdAt: z.string(),
  version: z.number().int().positive(),
  deletedAt: z.string().nullable(),
  recoverableUntil: z.string().nullable(),
}).strict();

export type CreatePurchaseDraftRequest = z.infer<typeof createPurchaseDraftRequestSchema>;
export type UpdatePurchaseDraftRequest = z.infer<typeof updatePurchaseDraftRequestSchema>;
export type PurchaseDraftResponse = z.infer<typeof purchaseDraftResponseSchema>;
