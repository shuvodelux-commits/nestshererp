import type { TenantContext } from '../ports/tenant-context';
import type { Tx } from '../ports/unit-of-work';

/** A unit of measure or a brand — a name and nothing else (§5.5). */
export interface CatalogEntry {
  readonly id: string;
  readonly name: string;
}

/** A category (`parentId === null`) or one of its subcategories (§5.5). */
export interface CategoryEntry {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
}

/**
 * Units, brands and categories (Phase 2, migration 0007).
 *
 * **One interface for three tables, with explicitly named methods per table.**
 * Not a generic repository (R-B7) — nothing here is parameterised by entity, and
 * categories already differ from the other two by having parents and children.
 * They share an interface because they are one screen and one transaction's
 * worth of vocabulary, so a use case needs all three or none.
 *
 * No business rule lives here (R-B6): whether a name is a duplicate, whether a
 * category may be nested, and whether a removal must archive rather than delete
 * are all decided in the use case before anything reaches this file.
 */
export interface CatalogRepository {
  listUnits(tx: Tx, ctx: TenantContext): Promise<readonly CatalogEntry[]>;
  listBrands(tx: Tx, ctx: TenantContext): Promise<readonly CatalogEntry[]>;
  listCategories(tx: Tx, ctx: TenantContext): Promise<readonly CategoryEntry[]>;

  findUnit(tx: Tx, ctx: TenantContext, id: string): Promise<CatalogEntry | null>;
  findBrand(tx: Tx, ctx: TenantContext, id: string): Promise<CatalogEntry | null>;
  findCategory(tx: Tx, ctx: TenantContext, id: string): Promise<CategoryEntry | null>;

  insertUnit(tx: Tx, ctx: TenantContext, entry: CatalogEntry): Promise<void>;
  insertBrand(tx: Tx, ctx: TenantContext, entry: CatalogEntry): Promise<void>;
  insertCategory(tx: Tx, ctx: TenantContext, entry: CategoryEntry): Promise<void>;

  renameUnit(tx: Tx, ctx: TenantContext, id: string, name: string): Promise<void>;
  renameBrand(tx: Tx, ctx: TenantContext, id: string, name: string): Promise<void>;
  renameCategory(tx: Tx, ctx: TenantContext, id: string, name: string): Promise<void>;

  /**
   * Removes the row outright. Only called once the use case has established
   * nothing refers to it — §3.6 permits a hard delete of master data "only if
   * never used".
   */
  deleteUnit(tx: Tx, ctx: TenantContext, id: string): Promise<void>;
  deleteBrand(tx: Tx, ctx: TenantContext, id: string): Promise<void>;
  deleteCategory(tx: Tx, ctx: TenantContext, id: string): Promise<void>;

  /** Soft delete, for a name products already carry (§3.6). */
  archiveUnit(tx: Tx, ctx: TenantContext, id: string): Promise<void>;
  archiveBrand(tx: Tx, ctx: TenantContext, id: string): Promise<void>;
  archiveCategory(tx: Tx, ctx: TenantContext, id: string): Promise<void>;

  /** How many live subcategories a category has, so a used parent is not removed. */
  countSubcategories(tx: Tx, ctx: TenantContext, categoryId: string): Promise<number>;
}
