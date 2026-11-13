import { z } from 'zod';

import { catalogFeaturesSchema, catalogNameSchema } from './catalog';

/**
 * HisabIQ MOD-002 T02A: an opt-in bilingual master-data CONTRACT only.
 *
 * Do not attach these schemas to legacy GET /api/v1/catalog or the existing
 * name-only POST/PATCH routes: those responses and inputs are strict, and
 * adding fields would break existing connected clients. This file registers
 * no API route and makes no claim that the database can store metadata yet.
 *
 * IDs, rather than English/Bangla labels or unit symbols, retain identity.
 */
const catalogId = z.string().length(26);
const entryVersion = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

/**
 * NFC-normalised display metadata, with whitespace collapsed exactly as the
 * existing catalog name normalizer does. The bound counts Unicode code points
 * after normalization, not UTF-16 code units or rendering grapheme clusters.
 * Script selection is not restricted; shops may mix Bangla and Latin text.
 */
export const catalogMetadataNameBnSchema = z
  .string()
  .transform((text) => text.normalize('NFC').trim().replace(/\s+/gu, ' '))
  .refine((text) => Array.from(text).length >= 1 && Array.from(text).length <= 120, {
    message: 'Bengali display name must contain 1 to 120 Unicode code points',
  });

/** A unit symbol is display-only, 1–4 non-whitespace Unicode code points. */
export const catalogMetadataUnitSymbolSchema = z
  .string()
  .transform((text) => text.normalize('NFC').trim())
  .refine((text) => {
    const length = Array.from(text).length;
    return length >= 1 && length <= 4 && !/\s/u.test(text);
  }, { message: 'Unit symbol must contain 1 to 4 non-whitespace Unicode code points' });

const optionalNameBn = catalogMetadataNameBnSchema.nullable().optional();

/**
 * Versioned responses always have explicit null metadata and an optimistic
 * row version; omission in these DTOs is a protocol error, not an empty value.
 * This is a separate response shape from the legacy strict catalog contract.
 */
export const catalogMetadataV1UnitSchema = z.object({
  id: catalogId,
  name: z.string(),
  nameBn: z.string().nullable(),
  symbol: z.string().nullable(),
  version: entryVersion,
}).strict();

export const catalogMetadataV1BrandSchema = z.object({
  id: catalogId,
  name: z.string(),
  nameBn: z.string().nullable(),
  version: entryVersion,
}).strict();

export const catalogMetadataV1CategorySchema = z.object({
  id: catalogId,
  name: z.string(),
  nameBn: z.string().nullable(),
  parentId: catalogId.nullable(),
  version: entryVersion,
}).strict();

export const catalogMetadataV1ResponseSchema = z.object({
  units: z.array(catalogMetadataV1UnitSchema),
  brands: z.array(catalogMetadataV1BrandSchema),
  categories: z.array(catalogMetadataV1CategorySchema),
  features: catalogFeaturesSchema,
}).strict();

export const catalogMetadataV1EnvelopeSchema = z.object({
  data: catalogMetadataV1ResponseSchema,
}).strict();

/**
 * Separate versioned creation contracts preserve legacy {name} commands.
 * On create, omitted nameBn/symbol means initial NULL, never a generated
 * translation. Category parentId is required and never inferred.
 */
export const createCatalogMetadataV1UnitRequestSchema = z.object({
  name: catalogNameSchema,
  nameBn: optionalNameBn,
  symbol: catalogMetadataUnitSymbolSchema.nullable().optional(),
}).strict();

export const createCatalogMetadataV1BrandRequestSchema = z.object({
  name: catalogNameSchema,
  nameBn: optionalNameBn,
}).strict();

export const createCatalogMetadataV1CategoryRequestSchema = z.object({
  name: catalogNameSchema,
  nameBn: optionalNameBn,
  parentId: catalogId.nullable(),
}).strict();

/**
 * Versioned metadata-only edits do not rename English names. Existing legacy
 * name-only rename routes remain authoritative and do not erase metadata.
 *
 * Omitted fields are unchanged, explicit null clears, a nonblank string sets.
 * Stale expectedVersion must be rejected by the owning service with HTTP 409
 * before any write, audit, or outbox append; Zod alone cannot enforce that.
 */
export const patchCatalogMetadataV1UnitRequestSchema = z.object({
  expectedVersion: entryVersion,
  nameBn: optionalNameBn,
  symbol: catalogMetadataUnitSymbolSchema.nullable().optional(),
}).strict().refine(
  (command) => command.nameBn !== undefined || command.symbol !== undefined,
  { message: 'At least one metadata field must be supplied' },
);

export const patchCatalogMetadataV1BrandRequestSchema = z.object({
  expectedVersion: entryVersion,
  nameBn: catalogMetadataNameBnSchema.nullable(),
}).strict();

export const patchCatalogMetadataV1CategoryRequestSchema = z.object({
  expectedVersion: entryVersion,
  nameBn: catalogMetadataNameBnSchema.nullable(),
}).strict();

export type CatalogMetadataV1Unit = z.infer<typeof catalogMetadataV1UnitSchema>;
export type CatalogMetadataV1Brand = z.infer<typeof catalogMetadataV1BrandSchema>;
export type CatalogMetadataV1Category = z.infer<typeof catalogMetadataV1CategorySchema>;
export type CatalogMetadataV1Response = z.infer<typeof catalogMetadataV1ResponseSchema>;
export type CatalogMetadataV1Envelope = z.infer<typeof catalogMetadataV1EnvelopeSchema>;
export type CreateCatalogMetadataV1UnitRequest = z.infer<typeof createCatalogMetadataV1UnitRequestSchema>;
export type CreateCatalogMetadataV1BrandRequest = z.infer<typeof createCatalogMetadataV1BrandRequestSchema>;
export type CreateCatalogMetadataV1CategoryRequest = z.infer<typeof createCatalogMetadataV1CategoryRequestSchema>;
export type PatchCatalogMetadataV1UnitRequest = z.infer<typeof patchCatalogMetadataV1UnitRequestSchema>;
export type PatchCatalogMetadataV1BrandRequest = z.infer<typeof patchCatalogMetadataV1BrandRequestSchema>;
export type PatchCatalogMetadataV1CategoryRequest = z.infer<typeof patchCatalogMetadataV1CategoryRequestSchema>;
