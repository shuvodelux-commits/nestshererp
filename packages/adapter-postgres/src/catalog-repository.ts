import type {
  CatalogEntry,
  CatalogRepository,
  CategoryEntry,
  TenantContext,
  Tx,
} from '@sher/core-application';
import type { Clock } from '@sher/shared-utils';
import { and, asc, count, eq, isNull, sql } from 'drizzle-orm';

import { brands, categories, units } from './schema';
import { txOf } from './unit-of-work';

/**
 * Units, brands and categories (migration 0007). No business rule here (R-B6) —
 * duplicate names, category depth and delete-versus-archive are all decided in
 * `ManageCatalogService` before anything reaches this file.
 *
 * Every query filters `deleted_at IS NULL` and `tenant_id`. The tenant filter is
 * belt as well as braces: RLS is FORCEd on all three tables, so a missing
 * predicate would return nothing rather than another shop's brands — but the
 * predicate is what makes the index usable.
 */
export class PostgresCatalogRepository implements CatalogRepository {
  constructor(private readonly clock: Clock) {}

  async listUnits(tx: Tx, ctx: TenantContext): Promise<readonly CatalogEntry[]> {
    return txOf(tx)
      .select({ id: units.id, name: units.name })
      .from(units)
      .where(and(eq(units.tenantId, ctx.tenantId), isNull(units.deletedAt)))
      .orderBy(asc(units.name));
  }

  async listBrands(tx: Tx, ctx: TenantContext): Promise<readonly CatalogEntry[]> {
    return txOf(tx)
      .select({ id: brands.id, name: brands.name })
      .from(brands)
      .where(and(eq(brands.tenantId, ctx.tenantId), isNull(brands.deletedAt)))
      .orderBy(asc(brands.name));
  }

  async listCategories(tx: Tx, ctx: TenantContext): Promise<readonly CategoryEntry[]> {
    return txOf(tx)
      .select({ id: categories.id, name: categories.name, parentId: categories.parentId })
      .from(categories)
      .where(and(eq(categories.tenantId, ctx.tenantId), isNull(categories.deletedAt)))
      .orderBy(asc(categories.name));
  }

  async findUnit(tx: Tx, ctx: TenantContext, id: string): Promise<CatalogEntry | null> {
    const rows = await txOf(tx)
      .select({ id: units.id, name: units.name })
      .from(units)
      .where(and(eq(units.tenantId, ctx.tenantId), eq(units.id, id), isNull(units.deletedAt)))
      .limit(1);
    return rows[0] ?? null;
  }

  async findBrand(tx: Tx, ctx: TenantContext, id: string): Promise<CatalogEntry | null> {
    const rows = await txOf(tx)
      .select({ id: brands.id, name: brands.name })
      .from(brands)
      .where(and(eq(brands.tenantId, ctx.tenantId), eq(brands.id, id), isNull(brands.deletedAt)))
      .limit(1);
    return rows[0] ?? null;
  }

  async findCategory(tx: Tx, ctx: TenantContext, id: string): Promise<CategoryEntry | null> {
    const rows = await txOf(tx)
      .select({ id: categories.id, name: categories.name, parentId: categories.parentId })
      .from(categories)
      .where(
        and(
          eq(categories.tenantId, ctx.tenantId),
          eq(categories.id, id),
          isNull(categories.deletedAt),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async insertUnit(tx: Tx, ctx: TenantContext, entry: CatalogEntry): Promise<void> {
    await txOf(tx).insert(units).values({ ...this.stamp(ctx), id: entry.id, name: entry.name });
  }

  async insertBrand(tx: Tx, ctx: TenantContext, entry: CatalogEntry): Promise<void> {
    await txOf(tx).insert(brands).values({ ...this.stamp(ctx), id: entry.id, name: entry.name });
  }

  async insertCategory(tx: Tx, ctx: TenantContext, entry: CategoryEntry): Promise<void> {
    await txOf(tx)
      .insert(categories)
      .values({ ...this.stamp(ctx), id: entry.id, name: entry.name, parentId: entry.parentId });
  }

  async renameUnit(tx: Tx, ctx: TenantContext, id: string, name: string): Promise<void> {
    await txOf(tx)
      .update(units)
      .set({ name, ...this.touch(ctx), version: sql`${units.version} + 1` })
      .where(and(eq(units.tenantId, ctx.tenantId), eq(units.id, id), isNull(units.deletedAt)));
  }

  async renameBrand(tx: Tx, ctx: TenantContext, id: string, name: string): Promise<void> {
    await txOf(tx)
      .update(brands)
      .set({ name, ...this.touch(ctx), version: sql`${brands.version} + 1` })
      .where(and(eq(brands.tenantId, ctx.tenantId), eq(brands.id, id), isNull(brands.deletedAt)));
  }

  async renameCategory(tx: Tx, ctx: TenantContext, id: string, name: string): Promise<void> {
    await txOf(tx)
      .update(categories)
      .set({ name, ...this.touch(ctx), version: sql`${categories.version} + 1` })
      .where(
        and(
          eq(categories.tenantId, ctx.tenantId),
          eq(categories.id, id),
          isNull(categories.deletedAt),
        ),
      );
  }

  async deleteUnit(tx: Tx, ctx: TenantContext, id: string): Promise<void> {
    await txOf(tx)
      .delete(units)
      .where(and(eq(units.tenantId, ctx.tenantId), eq(units.id, id)));
  }

  async deleteBrand(tx: Tx, ctx: TenantContext, id: string): Promise<void> {
    await txOf(tx)
      .delete(brands)
      .where(and(eq(brands.tenantId, ctx.tenantId), eq(brands.id, id)));
  }

  async deleteCategory(tx: Tx, ctx: TenantContext, id: string): Promise<void> {
    await txOf(tx)
      .delete(categories)
      .where(and(eq(categories.tenantId, ctx.tenantId), eq(categories.id, id)));
  }

  async archiveUnit(tx: Tx, ctx: TenantContext, id: string): Promise<void> {
    await txOf(tx)
      .update(units)
      .set({ ...this.bury(ctx), version: sql`${units.version} + 1` })
      .where(and(eq(units.tenantId, ctx.tenantId), eq(units.id, id), isNull(units.deletedAt)));
  }

  async archiveBrand(tx: Tx, ctx: TenantContext, id: string): Promise<void> {
    await txOf(tx)
      .update(brands)
      .set({ ...this.bury(ctx), version: sql`${brands.version} + 1` })
      .where(and(eq(brands.tenantId, ctx.tenantId), eq(brands.id, id), isNull(brands.deletedAt)));
  }

  async archiveCategory(tx: Tx, ctx: TenantContext, id: string): Promise<void> {
    await txOf(tx)
      .update(categories)
      .set({ ...this.bury(ctx), version: sql`${categories.version} + 1` })
      .where(
        and(
          eq(categories.tenantId, ctx.tenantId),
          eq(categories.id, id),
          isNull(categories.deletedAt),
        ),
      );
  }

  async countSubcategories(tx: Tx, ctx: TenantContext, categoryId: string): Promise<number> {
    const rows = await txOf(tx)
      .select({ total: count() })
      .from(categories)
      .where(
        and(
          eq(categories.tenantId, ctx.tenantId),
          eq(categories.parentId, categoryId),
          isNull(categories.deletedAt),
        ),
      );
    return rows[0]?.total ?? 0;
  }

  /** The Class A creation columns (§3.4), identical on all three tables. */
  private stamp(ctx: TenantContext) {
    const now = this.clock.now();
    return {
      tenantId: ctx.tenantId,
      createdAt: now,
      updatedAt: now,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
      version: 1,
    };
  }

  private touch(ctx: TenantContext) {
    return { updatedAt: this.clock.now(), updatedBy: ctx.userId };
  }

  private bury(ctx: TenantContext) {
    const now = this.clock.now();
    return { updatedAt: now, updatedBy: ctx.userId, deletedAt: now, deletedBy: ctx.userId };
  }
}
