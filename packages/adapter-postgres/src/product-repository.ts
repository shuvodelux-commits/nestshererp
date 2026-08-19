import type {
  NewProduct,
  ProductCounts,
  ProductEdit,
  ProductFilter,
  ProductRepository,
  ProductRow,
  TenantContext,
  Tx,
} from '@sher/core-application';
import type { DiscountType, ProductStatus } from '@sher/core-domain';
import type { Clock } from '@sher/shared-utils';
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import { brands, categories, products, units } from './schema';
import { txOf } from './unit-of-work';

/**
 * Products (migration 0008). No business rule here (R-B6) — duplicate codes,
 * feature gating, cost visibility and the optimistic lock are all decided in
 * `ManageProductsService` before anything reaches this file.
 *
 * Every read joins the unit, brand and category names, because a list of
 * products showing only ids is unreadable and fetching the names row by row
 * would be a query per product.
 */
const parentCategories = alias(categories, 'parent_categories');
/** The conversion unit is a second row in `units`, so it needs its own alias. */
const conversionUnits = alias(units, 'conversion_units');

/** The columns every read returns, so no query drifts from another. */
const PRODUCT_COLUMNS = {
  id: products.id,
  name: products.name,
  brandId: products.brandId,
  brandName: brands.name,
  categoryId: products.categoryId,
  categoryName: categories.name,
  parentCategoryName: parentCategories.name,
  sku: products.sku,
  barcode: products.barcode,
  description: products.description,
  baseUnitId: products.baseUnitId,
  baseUnitName: units.name,
  purchasePriceMinor: products.purchasePriceMinor,
  sellingPriceMinor: products.sellingPriceMinor,
  minStockQty: products.minStockQty,
  status: products.status,
  defaultDiscountType: products.defaultDiscountType,
  defaultDiscountValue: products.defaultDiscountValue,
  offerEnabled: products.offerEnabled,
  offerPriceMinor: products.offerPriceMinor,
  offerStartAt: products.offerStartAt,
  offerEndAt: products.offerEndAt,
  tracksExpiry: products.tracksExpiry,
  tracksSerial: products.tracksSerial,
  conversionUnitId: products.conversionUnitId,
  conversionUnitName: conversionUnits.name,
  conversionFactorQty: products.conversionFactorQty,
  version: products.version,
};

interface RawProduct {
  readonly id: string;
  readonly name: string;
  readonly brandId: string | null;
  readonly brandName: string | null;
  readonly categoryId: string | null;
  readonly categoryName: string | null;
  readonly parentCategoryName: string | null;
  readonly sku: string | null;
  readonly barcode: string | null;
  readonly description: string | null;
  readonly baseUnitId: string;
  readonly baseUnitName: string | null;
  readonly purchasePriceMinor: number;
  readonly sellingPriceMinor: number;
  readonly minStockQty: number;
  readonly status: string;
  readonly defaultDiscountType: string | null;
  readonly defaultDiscountValue: number | null;
  readonly offerEnabled: boolean;
  readonly offerPriceMinor: number | null;
  readonly offerStartAt: Date | null;
  readonly offerEndAt: Date | null;
  readonly tracksExpiry: boolean;
  readonly tracksSerial: boolean;
  readonly conversionUnitId: string | null;
  readonly conversionUnitName: string | null;
  readonly conversionFactorQty: number | null;
  readonly version: number;
}

export class PostgresProductRepository implements ProductRepository {
  constructor(private readonly clock: Clock) {}

  async list(tx: Tx, ctx: TenantContext, filter: ProductFilter): Promise<readonly ProductRow[]> {
    const rows = await this.selectProducts(tx, ctx)
      .where(and(this.liveInTenant(ctx), ...this.filters(ctx, filter), ...this.after(ctx, filter)))
      // The fixed order the cursor walks: name, then id as the tiebreak for two
      // products with the same name (§3.9 — keyset only, `OFFSET` is banned).
      .orderBy(asc(products.name), asc(products.id))
      .limit(filter.limit);

    return rows.map(toRow);
  }

  /**
   * The tile figures, over the same filter as the rows but without paging, in one
   * round trip. `FILTER (WHERE …)` rather than four queries: four counts taken at
   * four moments could disagree with each other.
   */
  async count(tx: Tx, ctx: TenantContext, filter: ProductFilter): Promise<ProductCounts> {
    const rows = await txOf(tx)
      .select({
        total: sql<number>`count(*)::int`,
        active: sql<number>`count(*) FILTER (WHERE ${products.status} = 'ACTIVE')::int`,
        inactive: sql<number>`count(*) FILTER (WHERE ${products.status} = 'INACTIVE')::int`,
        withoutBarcode: sql<number>`count(*) FILTER (WHERE ${products.barcode} IS NULL)::int`,
      })
      .from(products)
      .leftJoin(brands, eq(brands.id, products.brandId))
      .where(and(this.liveInTenant(ctx), ...this.filters(ctx, filter)));

    const counts = rows[0];
    return {
      total: counts?.total ?? 0,
      active: counts?.active ?? 0,
      inactive: counts?.inactive ?? 0,
      withoutBarcode: counts?.withoutBarcode ?? 0,
    };
  }

  async findById(tx: Tx, ctx: TenantContext, id: string): Promise<ProductRow | null> {
    const rows = await this.selectProducts(tx, ctx)
      .where(and(this.liveInTenant(ctx), eq(products.id, id)))
      .limit(1);

    const row = rows[0];
    return row === undefined ? null : toRow(row);
  }

  async findIdByBarcode(tx: Tx, ctx: TenantContext, barcode: string): Promise<string | null> {
    const rows = await txOf(tx)
      .select({ id: products.id })
      .from(products)
      .where(and(this.liveInTenant(ctx), eq(products.barcode, barcode)))
      .limit(1);
    return rows[0]?.id ?? null;
  }

  /** Case-insensitive, matching the `lower(sku)` unique index in migration 0008. */
  async findIdBySku(tx: Tx, ctx: TenantContext, sku: string): Promise<string | null> {
    const rows = await txOf(tx)
      .select({ id: products.id })
      .from(products)
      .where(and(this.liveInTenant(ctx), sql`lower(${products.sku}) = lower(${sku})`))
      .limit(1);
    return rows[0]?.id ?? null;
  }

  async insert(tx: Tx, ctx: TenantContext, product: NewProduct): Promise<void> {
    const now = this.clock.now();
    await txOf(tx)
      .insert(products)
      .values({
        ...product,
        status: 'ACTIVE',
        tenantId: ctx.tenantId,
        createdAt: now,
        updatedAt: now,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
        version: 1,
      });
  }

  /**
   * D-32's optimistic lock lives in the `WHERE` clause: the update matches only
   * while the row is still at the version the editor read. `false` means someone
   * else saved first, and the use case turns that into `CONFLICT_STALE_VERSION`
   * rather than overwriting them.
   */
  async update(
    tx: Tx,
    ctx: TenantContext,
    id: string,
    expectedVersion: number,
    product: ProductEdit,
  ): Promise<boolean> {
    const updated = await txOf(tx)
      .update(products)
      .set({
        ...product,
        updatedAt: this.clock.now(),
        updatedBy: ctx.userId,
        version: sql`${products.version} + 1`,
      })
      .where(
        and(this.liveInTenant(ctx), eq(products.id, id), eq(products.version, expectedVersion)),
      )
      .returning({ id: products.id });

    return updated.length > 0;
  }

  async setStatus(
    tx: Tx,
    ctx: TenantContext,
    id: string,
    status: ProductStatus,
  ): Promise<void> {
    await txOf(tx)
      .update(products)
      .set({
        status,
        updatedAt: this.clock.now(),
        updatedBy: ctx.userId,
        version: sql`${products.version} + 1`,
      })
      .where(and(this.liveInTenant(ctx), eq(products.id, id)));
  }

  async setBarcode(tx: Tx, ctx: TenantContext, id: string, barcode: string): Promise<void> {
    await txOf(tx)
      .update(products)
      .set({
        barcode,
        updatedAt: this.clock.now(),
        updatedBy: ctx.userId,
        version: sql`${products.version} + 1`,
      })
      .where(and(this.liveInTenant(ctx), eq(products.id, id)));
  }

  async deleteUnused(tx: Tx, ctx: TenantContext, id: string): Promise<void> {
    await txOf(tx)
      .delete(products)
      .where(and(eq(products.tenantId, ctx.tenantId), eq(products.id, id)));
  }

  /**
   * Both places a unit can be used: as a product's base unit, and as its
   * conversion unit. Missing the second would archive the "Pipe" a product still
   * converts to, leaving a rule pointing at a unit nobody can see (§3.6).
   */
  async countUsingUnit(tx: Tx, ctx: TenantContext, unitId: string): Promise<number> {
    const rows = await txOf(tx)
      .select({ total: sql<number>`count(*)::int` })
      .from(products)
      .where(
        and(
          this.liveInTenant(ctx),
          or(eq(products.baseUnitId, unitId), eq(products.conversionUnitId, unitId)),
        ),
      );

    return rows[0]?.total ?? 0;
  }

  async countUsingBrand(tx: Tx, ctx: TenantContext, brandId: string): Promise<number> {
    const rows = await txOf(tx)
      .select({ total: sql<number>`count(*)::int` })
      .from(products)
      .where(and(this.liveInTenant(ctx), eq(products.brandId, brandId)));
    return rows[0]?.total ?? 0;
  }

  /** A category counts as used by products filed under it or under its children. */
  async countUsingCategory(tx: Tx, ctx: TenantContext, categoryId: string): Promise<number> {
    const rows = await txOf(tx)
      .select({ total: sql<number>`count(*)::int` })
      .from(products)
      .where(and(this.liveInTenant(ctx), this.inCategoryTree(ctx, categoryId)));
    return rows[0]?.total ?? 0;
  }

  /* ------------------------------------------------------------- mechanics */

  private selectProducts(tx: Tx, ctx: TenantContext) {
    void ctx;
    return txOf(tx)
      .select(PRODUCT_COLUMNS)
      .from(products)
      .innerJoin(units, eq(units.id, products.baseUnitId))
      .leftJoin(brands, eq(brands.id, products.brandId))
      .leftJoin(categories, eq(categories.id, products.categoryId))
      .leftJoin(parentCategories, eq(parentCategories.id, categories.parentId))
      .leftJoin(conversionUnits, eq(conversionUnits.id, products.conversionUnitId));
  }

  private liveInTenant(ctx: TenantContext) {
    return and(eq(products.tenantId, ctx.tenantId), isNull(products.deletedAt));
  }

  private filters(ctx: TenantContext, filter: ProductFilter) {
    const conditions = [];

    if (filter.search !== null && filter.search !== '') {
      // The four things a shopkeeper types: the product, its code, its barcode,
      // or the brand. `products_name_trgm_idx` is what keeps this off a full scan.
      const pattern = `%${filter.search}%`;
      conditions.push(
        or(
          sql`${products.name} ILIKE ${pattern}`,
          sql`${products.sku} ILIKE ${pattern}`,
          sql`${products.barcode} ILIKE ${pattern}`,
          sql`${brands.name} ILIKE ${pattern}`,
        ),
      );
    }

    if (filter.brandId !== null) conditions.push(eq(products.brandId, filter.brandId));
    if (filter.categoryId !== null) {
      conditions.push(this.inCategoryTree(ctx, filter.categoryId));
    }
    if (filter.status !== null) conditions.push(eq(products.status, filter.status));

    return conditions;
  }

  /**
   * The category itself, or anything filed under it — "show me Drinks" means the
   * juices too.
   */
  private inCategoryTree(ctx: TenantContext, categoryId: string) {
    return or(
      eq(products.categoryId, categoryId),
      sql`${products.categoryId} IN (
        SELECT child.id FROM categories child
         WHERE child.tenant_id = ${ctx.tenantId}
           AND child.parent_id = ${categoryId}
           AND child.deleted_at IS NULL
      )`,
    );
  }

  /**
   * The keyset cursor (§3.9): everything ordered after the last row of the
   * previous page.
   *
   * The cursor is that row's id and the query looks its sort key up, rather than
   * the client carrying an encoded `(name, id)` pair it could tamper with or
   * mis-encode. The subquery is tenant-scoped, so a cursor from another shop
   * matches nothing instead of paging through this one.
   */
  private after(ctx: TenantContext, filter: ProductFilter) {
    if (filter.cursor === null) return [];

    return [
      sql`(${products.name}, ${products.id}) > (
        SELECT anchor.name, anchor.id FROM products anchor
         WHERE anchor.id = ${filter.cursor} AND anchor.tenant_id = ${ctx.tenantId}
      )`,
    ];
  }
}

function toRow(raw: RawProduct): ProductRow {
  return {
    ...raw,
    // CHAR(26) columns come back blank-padded; the join names never are.
    baseUnitName: raw.baseUnitName ?? '',
    status: raw.status as ProductStatus,
    defaultDiscountType: raw.defaultDiscountType as DiscountType | null,
  };
}
