import { z } from 'zod';

/**
 * The catalog vocabulary: units of measure, brands, categories (Phase 2, §5.5).
 *
 * One GET returns all three, because they are one screen and one decision — a
 * product form cannot be drawn without every list, and three round trips to
 * populate three dropdowns is three chances for a half-loaded form.
 */
const ULID = z.string().length(26);

/**
 * The units of measure every new business starts with — exactly the seven D-10
 * names: "Carton, Box, Piece, Pipe, Feet, Kg, Litre".
 *
 * Seeded rather than fixed, because D-10 makes conversion rules "defined by the
 * user" and no closed enum can know that a rope shop sells by the Gaz. They are
 * ordinary rows from the moment they exist: renameable, removable, and joined by
 * whatever else the shop actually uses.
 *
 * A product cannot be created without a base unit (§5.5), so a tenant with an
 * empty unit list would be a tenant that cannot add its first product.
 */
export const SEED_UNITS: readonly string[] = [
  'Piece',
  'Box',
  'Carton',
  'Kg',
  'Litre',
  'Feet',
  'Pipe',
];

export const catalogNameSchema = z.string().trim().min(1).max(120);

export const brandResponseSchema = z
  .object({ id: ULID, name: z.string() })
  .strict();

export type BrandResponse = z.infer<typeof brandResponseSchema>;

export const unitResponseSchema = z
  .object({ id: ULID, name: z.string() })
  .strict();

export type UnitResponse = z.infer<typeof unitResponseSchema>;

/**
 * A category or a subcategory — the same row shape, told apart by `parentId`
 * (§5.5 "category/group/subcategory"). Exactly two levels exist, so a category
 * with a parent can never itself be a parent.
 */
export const categoryResponseSchema = z
  .object({ id: ULID, name: z.string(), parentId: ULID.nullable() })
  .strict();

export type CategoryResponse = z.infer<typeof categoryResponseSchema>;

/**
 * The feature settings the product form has to know about (§5.21).
 *
 * They travel with the catalog rather than being read from `/settings`, because
 * a storekeeper who may file goods under a category has no business holding
 * `settings.setting.view` — and a form that 403s while loading is not a form.
 * The server refuses these fields on a write regardless; this is what stops the
 * screen offering them (UI-09).
 */
export const catalogFeaturesSchema = z
  .object({
    productOffers: z.boolean(),
    expiryTracking: z.boolean(),
    serialTracking: z.boolean(),
    warranty: z.boolean(),
    customerGroups: z.boolean(),
    vendors: z.boolean(),
  })
  .strict();

export type CatalogFeatures = z.infer<typeof catalogFeaturesSchema>;

export const catalogResponseSchema = z
  .object({
    units: z.array(unitResponseSchema),
    brands: z.array(brandResponseSchema),
    categories: z.array(categoryResponseSchema),
    features: catalogFeaturesSchema,
  })
  .strict();

export type CatalogResponse = z.infer<typeof catalogResponseSchema>;

export const saveBrandRequestSchema = z.object({ name: catalogNameSchema }).strict();
export type SaveBrandRequest = z.infer<typeof saveBrandRequestSchema>;

export const saveUnitRequestSchema = z.object({ name: catalogNameSchema }).strict();
export type SaveUnitRequest = z.infer<typeof saveUnitRequestSchema>;

/**
 * `parentId` is accepted on create and **not** on edit: moving a subcategory to
 * another parent would silently re-file every product under it, and nothing in
 * §5.5 asks for that. Renaming is what editing a category means.
 */
export const createCategoryRequestSchema = z
  .object({ name: catalogNameSchema, parentId: ULID.nullable() })
  .strict();

export type CreateCategoryRequest = z.infer<typeof createCategoryRequestSchema>;

export const renameCategoryRequestSchema = z.object({ name: catalogNameSchema }).strict();
export type RenameCategoryRequest = z.infer<typeof renameCategoryRequestSchema>;

/**
 * What happened when a catalog entry was removed (§3.6: master data is
 * hard-deleted only if never used, soft-deleted once something refers to it).
 *
 * The caller is told which of the two occurred, because they are different
 * promises: `DELETED` means the row is gone, `ARCHIVED` means existing products
 * keep showing it and it is merely no longer offered for new ones.
 */
export const removeCatalogEntryResponseSchema = z
  .object({ outcome: z.union([z.literal('DELETED'), z.literal('ARCHIVED')]) })
  .strict();

export type RemoveCatalogEntryResponse = z.infer<typeof removeCatalogEntryResponseSchema>;
