/**
 * MOD-002 P7a: pure reference-count semantics for the future Product Settings
 * usage read model. NOT an API, a DB query, a permission or a rollout gate.
 *
 * Counting "used by N products" means distinct, non-deleted products, even
 * if the product's own status is INACTIVE. It is NOT number of conversion
 * entries, stock quantity or current sales. A unit may appear through a
 * product's base unit, legacy single conversion, or multi-unit conversion
 * records; one product contributes at most one count per unit.
 *
 * Master soft-deletion is archive, NOT reversible Active/Inactive. Archived
 * master references must remain countable. The eventual PostgreSQL adapter
 * must fetch source data in a tenant-scoped consistent snapshot under RLS and
 * must not claim these in-memory inputs are authoritative DB counts.
 */
export interface UsageMasterRef {
  readonly id: string;
  readonly tenantId: string;
  readonly deletedAt?: string | null;
}

export interface UsageCategoryRef extends UsageMasterRef {
  readonly parentId: string | null;
}

export interface UsageProductRef {
  readonly id: string;
  readonly tenantId: string;
  readonly deletedAt: string | null;
  readonly status: 'ACTIVE' | 'INACTIVE';
  readonly baseUnitId: string;
  readonly conversionUnitId: string | null;
  readonly brandId: string | null;
  readonly categoryId: string | null;
}

export interface UsageConversionRef {
  readonly tenantId: string;
  readonly productId: string;
  readonly unitId: string;
  readonly deletedAt: string | null;
}

export interface CatalogSettingsUsageInput {
  readonly tenantId: string;
  readonly units: readonly UsageMasterRef[];
  readonly brands: readonly UsageMasterRef[];
  readonly categories: readonly UsageCategoryRef[];
  readonly products: readonly UsageProductRef[];
  readonly conversions: readonly UsageConversionRef[];
}

export interface CatalogUsageItem {
  readonly id: string;
  readonly productCount: number;
}

export interface CatalogCategoryUsageItem {
  readonly id: string;
  readonly directProductCount: number;
  readonly subtreeProductCount: number;
  readonly parentState: 'root' | 'present' | 'unresolved';
}

export interface CatalogSettingsUsageV1 {
  readonly units: readonly CatalogUsageItem[];
  readonly brands: readonly CatalogUsageItem[];
  readonly categories: readonly CatalogCategoryUsageItem[];
  /**
   * Missing masters/parents make a census incomplete. Never silently
   * substitute zero for a master omitted from its scoped input.
   */
  readonly unresolved: {
    readonly unitIds: readonly string[];
    readonly brandIds: readonly string[];
    readonly categoryIds: readonly string[];
    readonly parentIds: readonly string[];
  };
}

function ownMasterMap<T extends UsageMasterRef>(
  entries: readonly T[], tenantId: string, kind: string,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const entry of entries) {
    if (entry.tenantId !== tenantId) continue;
    if (result.has(entry.id)) throw new Error('Duplicate ' + kind + ' master ID');
    result.set(entry.id, entry);
  }
  return result;
}

/**
 * Exact deterministic model for P7b PostgreSQL tests to reproduce.
 *
 * Contract is intentionally *not* exported from the package root yet:
 * wiring a read-only production route and permissions must be done in P7b.
 */
export function computeCatalogSettingsUsageV1(
  input: CatalogSettingsUsageInput,
): CatalogSettingsUsageV1 {
  const units = ownMasterMap(input.units, input.tenantId, 'unit');
  const brands = ownMasterMap(input.brands, input.tenantId, 'brand');
  const categories = ownMasterMap(input.categories, input.tenantId, 'category');
  const products = new Map<string, UsageProductRef>();
  for (const product of input.products) {
    if (product.tenantId !== input.tenantId || product.deletedAt !== null) continue;
    if (products.has(product.id)) throw new Error('Duplicate product ID');
    products.set(product.id, product);
  }

  const childrenParent = new Map<string, string>();
  const unknownParents = new Set<string>();
  for (const category of categories.values()) {
    if (category.parentId === null) continue;
    const parent = categories.get(category.parentId);
    if (parent === undefined) {
      unknownParents.add(category.parentId);
      continue;
    }
    // The existing catalog service supports only root and direct child.
    // A cycle or three-level tree must not silently undercount descendants.
    if (parent.id === category.id || parent.parentId !== null) {
      throw new Error('Unsupported catalog category hierarchy');
    }
    childrenParent.set(category.id, parent.id);
  }

  const unitProducts = new Map([...units.keys()].map(id => [id, new Set<string>()]));
  const brandProducts = new Map([...brands.keys()].map(id => [id, new Set<string>()]));
  const directCategoryProducts = new Map([...categories.keys()].map(id => [id, new Set<string>()]));
  const treeCategoryProducts = new Map([...categories.keys()].map(id => [id, new Set<string>()]));
  const unitReferences = new Map<string, Set<string>>();

  for (const product of products.values()) {
    unitReferences.set(product.id, new Set([
      product.baseUnitId,
      ...(product.conversionUnitId === null ? [] : [product.conversionUnitId]),
    ]));
  }

  for (const conversion of input.conversions) {
    if (conversion.tenantId !== input.tenantId || conversion.deletedAt !== null) continue;
    // A conversion linked to an archived, deleted or foreign product cannot
    // be evidence of a live product still using its unit.
    unitReferences.get(conversion.productId)?.add(conversion.unitId);
  }

  const missingUnitIds = new Set<string>();
  const missingBrandIds = new Set<string>();
  const missingCategoryIds = new Set<string>();

  for (const product of products.values()) {
    for (const unitId of unitReferences.get(product.id) ?? []) {
      const target = unitProducts.get(unitId);
      if (target === undefined) missingUnitIds.add(unitId);
      else target.add(product.id);
    }
    if (product.brandId !== null) {
      const target = brandProducts.get(product.brandId);
      if (target === undefined) missingBrandIds.add(product.brandId);
      else target.add(product.id);
    }
    if (product.categoryId !== null) {
      const direct = directCategoryProducts.get(product.categoryId);
      const subtree = treeCategoryProducts.get(product.categoryId);
      if (direct === undefined || subtree === undefined) {
        missingCategoryIds.add(product.categoryId);
      } else {
        direct.add(product.id);
        subtree.add(product.id);
        const parentId = childrenParent.get(product.categoryId);
        if (parentId !== undefined) treeCategoryProducts.get(parentId)?.add(product.id);
      }
    }
  }

  return {
    units: [...units.keys()].map(id => ({
      id, productCount: unitProducts.get(id)?.size ?? 0,
    })),
    brands: [...brands.keys()].map(id => ({
      id, productCount: brandProducts.get(id)?.size ?? 0,
    })),
    categories: [...categories.values()].map(category => ({
      id: category.id,
      directProductCount: directCategoryProducts.get(category.id)?.size ?? 0,
      subtreeProductCount: treeCategoryProducts.get(category.id)?.size ?? 0,
      parentState: category.parentId === null ? 'root' as const
        : childrenParent.has(category.id) ? 'present' as const : 'unresolved' as const,
    })),
    unresolved: {
      unitIds: [...missingUnitIds].sort(),
      brandIds: [...missingBrandIds].sort(),
      categoryIds: [...missingCategoryIds].sort(),
      parentIds: [...unknownParents].sort(),
    },
  };
}
