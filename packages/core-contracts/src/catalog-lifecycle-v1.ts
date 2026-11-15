import { z } from 'zod';

/**
 * MOD-002 P8b1: opt-in, NOT mounted. Catalog lifecycle is independent
 * of product status and legacy archive/remove. These contracts confer no
 * tenant permission or deletion eligibility.
 */
const id = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u);
const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

export const catalogLifecycleV1StatusRequestSchema = z.object({
  expectedVersion: version,
  desiredState: z.enum(['ACTIVE', 'INACTIVE']),
}).strict();

export const catalogLifecycleV1StateSchema = z.enum(['ACTIVE', 'INACTIVE', 'ARCHIVED']);

/** Inactive occupies the nonarchived name namespace. Archive is NOT inactive. */
const common = z.object({
  id,
  name: z.string().min(1),
  nameBn: z.string().nullable(),
  version,
  state: catalogLifecycleV1StateSchema,
  archivedAt: z.string().datetime({ offset: true }).nullable(),
}).strict();

function archiveCoherent<T extends { state: string; archivedAt: string | null }>(
  row: T,
): boolean {
  return (row.state === 'ARCHIVED') === (row.archivedAt !== null);
}

export const catalogLifecycleV1UnitSchema = common.extend({
  symbol: z.string().nullable(),
}).strict().refine(archiveCoherent, 'Archived state and timestamp must agree');

export const catalogLifecycleV1BrandSchema = common
  .refine(archiveCoherent, 'Archived state and timestamp must agree');

export const catalogLifecycleV1CategorySchema = common.extend({
  parentId: id.nullable(),
}).strict().refine(archiveCoherent, 'Archived state and timestamp must agree');

function roster<K extends 'unit' | 'brand' | 'category', R extends z.ZodTypeAny>(
  kind: K, rowSchema: R,
) {
  return z.object({
    data: z.object({ kind: z.literal(kind), entries: z.array(rowSchema) }).strict(),
  }).strict();
}

export const catalogLifecycleV1UnitRosterEnvelopeSchema =
  roster('unit', catalogLifecycleV1UnitSchema);
export const catalogLifecycleV1BrandRosterEnvelopeSchema =
  roster('brand', catalogLifecycleV1BrandSchema);
export const catalogLifecycleV1CategoryRosterEnvelopeSchema =
  roster('category', catalogLifecycleV1CategorySchema);

export type CatalogLifecycleV1StatusRequest =
  z.infer<typeof catalogLifecycleV1StatusRequestSchema>;
export type CatalogLifecycleV1State = z.infer<typeof catalogLifecycleV1StateSchema>;
export type CatalogLifecycleV1Unit = z.infer<typeof catalogLifecycleV1UnitSchema>;
export type CatalogLifecycleV1Brand = z.infer<typeof catalogLifecycleV1BrandSchema>;
export type CatalogLifecycleV1Category = z.infer<typeof catalogLifecycleV1CategorySchema>;
