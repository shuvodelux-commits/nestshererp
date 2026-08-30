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
import type { ProductSort } from '@sher/core-contracts';
import { buildProductSearchText, searchTokens } from '@sher/core-domain';
import type { DiscountType, ProductStatus } from '@sher/core-domain';
import type { Clock } from '@sher/shared-utils';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import { afterCursor, joinedName, orderBy, ownColumn, type SortableColumn } from './keyset-sort';
import { brands, categories, parties, productCostState, products, units } from './schema';
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
/** The party named as the product's usual supplier (Phase 8), joined for its name. */
const usualSuppliers = alias(parties, 'usual_suppliers');

/**
 * What each tappable header on the Products list orders by (UI-46).
 *
 * This map **is** the allow-list at the database boundary: `ProductSort` is a
 * closed enum in `core-contracts`, and a value that reached here without passing
 * that enum could not index into this object. No column name is ever
 * concatenated from a request.
 *
 * The two joined names are scalar subqueries rather than the left-joined columns
 * a few lines below, because the cursor's anchor lookup selects from `products`
 * alone and has no joins — expressing them the same way on both sides is what
 * keeps the ordering and the cursor in agreement. Every nullable column is
 * coalesced, or the row-value comparison would go NULL and the row would vanish
 * from every page after the first.
 */
const PRODUCT_SORTS: Record<ProductSort, SortableColumn> = {
  name: ownColumn(sql`${products.name}`, sql`anchor.name`),
  barcode: ownColumn(sql`${products.barcode}`, sql`anchor.barcode`, sql`''`),
  categoryName: joinedName(
    'categories',
    'name',
    sql`${products.categoryId}`,
    sql`anchor.category_id`,
  ),
  unitName: joinedName('units', 'name', sql`${products.baseUnitId}`, sql`anchor.base_unit_id`),
  sellingPrice: ownColumn(sql`${products.sellingPriceMinor}`, sql`anchor.selling_price_minor`),
  purchasePrice: ownColumn(sql`${products.purchasePriceMinor}`, sql`anchor.purchase_price_minor`),
  minStockQty: ownColumn(sql`${products.minStockQty}`, sql`anchor.min_stock_qty`),
  status: ownColumn(sql`${products.status}`, sql`anchor.status`),
};

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
  hasImage: sql<boolean>`(${products.imageMime} IS NOT NULL)`,
  aliases: products.aliases,
  searchText: products.searchText,
  tracksExpiry: products.tracksExpiry,
  tracksSerial: products.tracksSerial,
  conversionUnitId: products.conversionUnitId,
  conversionUnitName: conversionUnits.name,
  conversionFactorQty: products.conversionFactorQty,
  usualSupplierId: products.usualSupplierId,
  usualSupplierName: usualSuppliers.name,
  minOrderQty: products.minOrderQty,
  warrantyMonths: products.warrantyMonths,
  supplierWarrantyMonths: products.supplierWarrantyMonths,
  version: products.version,
  /**
   * Stock, for the §5.5 list columns — read here rather than summed in Vue.
   *
   * `stockQty` and `avgUnitCost` come from the cost-state cache; `lotValueMinor`
   * is the FIFO basis, summed **per lot with each lot rounded once**, which is
   * exactly what `GetValuationService` does. Rounding the sum instead of summing
   * the roundings differs by a poisha at the boundary, and INV-05 is precisely
   * the invariant that would then fail against the `INVENTORY` account.
   *
   * The arithmetic is integer throughout: quantity is scale 3, unit cost scale
   * 4, money scale 2, so the product is divided by 10^5 with `+ 50000` making
   * the truncation a half-up round (both operands are non-negative). No
   * floating point, in SQL or anywhere else (R-C3).
   */
  stockQty: sql<number | null>`${productCostState.qtyOnHand}`,
  avgUnitCost: sql<number | null>`${productCostState.avgUnitCost}`,
  /**
   * Typed as a string because it is: `SUM` over `BIGINT` is `int8`, and
   * node-postgres hands `int8` back as text rather than risk losing precision
   * above 2^53. `toRow` converts it once, with the range checked — pretending
   * here that it arrives as a number is how a money figure silently becomes
   * `"100000"` in a JSON body and then `NaN` in the next arithmetic.
   */
  lotValueMinor: sql<string | null>`(
    SELECT COALESCE(SUM((lot.qty_remaining * lot.actual_unit_cost + 50000) / 100000), 0)
      FROM inventory_lots lot
     WHERE lot.tenant_id = ${products.tenantId}
       AND lot.product_id = ${products.id}
       AND lot.owner_type = 'OWNED'
       AND lot.deleted_at IS NULL
  )`,
  /**
   * Whether stock has ever moved. `EXISTS` rather than a count — the question
   * is "any", and the answer is one index seek either way.
   */
  hasStockHistory: sql<boolean>`EXISTS (
    SELECT 1 FROM stock_movements movement
     WHERE movement.tenant_id = ${products.tenantId}
       AND movement.product_id = ${products.id}
  )`,
};

interface RawProduct {
  readonly id: string;
  readonly hasImage?: boolean;
  readonly aliases?: string | null;
  readonly searchText?: string;
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
  readonly usualSupplierId: string | null;
  readonly usualSupplierName: string | null;
  readonly minOrderQty: number | null;
  readonly warrantyMonths: number | null;
  readonly supplierWarrantyMonths: number | null;
  readonly version: number;
  readonly stockQty: number | null;
  readonly avgUnitCost: number | null;
  readonly lotValueMinor: string | null;
  readonly hasStockHistory: boolean;
}

/**
 * An `int8` the driver returned as text, back to the integer it is.
 *
 * This is **not** R-C3's forbidden float parsing: the value is a whole number
 * of poisha that PostgreSQL computed with integer arithmetic, and the only
 * question is whether JavaScript can hold it exactly. If it cannot, that is a
 * stock valuation past ৳90,000,000,000,000 and a loud failure beats a silently
 * rounded one.
 */
function bigintMinor(value: string | null): number {
  if (value === null) return 0;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new RangeError(`Stock value ${value} is outside the safe integer range`);
  }
  return parsed;
}

export class PostgresProductRepository implements ProductRepository {
  constructor(private readonly clock: Clock) {}

  async list(tx: Tx, ctx: TenantContext, filter: ProductFilter): Promise<readonly ProductRow[]> {
    const column = PRODUCT_SORTS[filter.sort];

    const rows = await this.selectProducts(tx, ctx)
      .where(and(this.liveInTenant(ctx), ...this.filters(ctx, filter), ...this.after(ctx, filter)))
      // Whichever header was tapped, then id in the same direction as the
      // tiebreak (§3.9, UI-46 — keyset only, `OFFSET` is banned).
      .orderBy(orderBy(column, filter.direction, sql`${products.id}`))
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

  async findIdsByName(tx: Tx, ctx: TenantContext, name: string): Promise<readonly string[]> {
    const rows = await txOf(tx)
      .select({ id: products.id })
      .from(products)
      .where(and(this.liveInTenant(ctx), sql`lower(${products.name}) = lower(${name})`));
    return rows.map((row) => row.id);
  }

  async insert(tx: Tx, ctx: TenantContext, product: NewProduct): Promise<void> {
    const now = this.clock.now();
    await txOf(tx)
      .insert(products)
      .values({
        ...product,
        status: 'ACTIVE',
        searchText: '',
        tenantId: ctx.tenantId,
        createdAt: now,
        updatedAt: now,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
        version: 1,
      });

    await this.refreshSearchText(tx, ctx, product.id);
  }

  /**
   * Rebuilds the product's searchable line (migration 0026).
   *
   * Done here, after every write, rather than asked of each caller: an importer,
   * a barcode generator and the product form all change what a product can be
   * found by, and one of them forgetting would leave a product invisible to the
   * counter with nothing on screen to explain it. The text itself comes from
   * `buildProductSearchText` — the same normaliser the search ranks with, so a
   * row can never be stored in a form the query cannot match.
   */
  private async refreshSearchText(tx: Tx, ctx: TenantContext, id: string): Promise<void> {
    const db = txOf(tx);
    const rows = await db
      .select({
        name: products.name,
        sku: products.sku,
        barcode: products.barcode,
        aliases: products.aliases,
        brandName: brands.name,
        categoryName: categories.name,
        unitName: units.name,
      })
      .from(products)
      .leftJoin(brands, and(eq(brands.tenantId, ctx.tenantId), eq(brands.id, products.brandId)))
      .leftJoin(
        categories,
        and(eq(categories.tenantId, ctx.tenantId), eq(categories.id, products.categoryId)),
      )
      .leftJoin(units, and(eq(units.tenantId, ctx.tenantId), eq(units.id, products.baseUnitId)))
      .where(and(eq(products.tenantId, ctx.tenantId), eq(products.id, id)))
      .limit(1);

    const row = rows[0];
    if (row === undefined) return;

    await db
      .update(products)
      .set({ searchText: buildProductSearchText(row) })
      .where(and(eq(products.tenantId, ctx.tenantId), eq(products.id, id)));
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

    if (updated.length > 0) await this.refreshSearchText(tx, ctx, id);
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

    // A generated barcode is one more thing the counter can scan for.
    await this.refreshSearchText(tx, ctx, id);
  }

  async setPurchasePrice(
    tx: Tx,
    ctx: TenantContext,
    id: string,
    purchasePriceMinor: number,
  ): Promise<void> {
    await txOf(tx)
      .update(products)
      .set({
        purchasePriceMinor,
        updatedAt: this.clock.now(),
        updatedBy: ctx.userId,
        version: sql`${products.version} + 1`,
      })
      .where(and(this.liveInTenant(ctx), eq(products.id, id)));
  }

  async setImage(
    tx: Tx,
    ctx: TenantContext,
    id: string,
    image: { readonly mime: string; readonly bytes: Uint8Array } | null,
  ): Promise<void> {
    await txOf(tx)
      .update(products)
      .set({
        imageMime: image?.mime ?? null,
        imageBytes: image === null ? null : Buffer.from(image.bytes),
        updatedAt: this.clock.now(),
        updatedBy: ctx.userId,
      })
      .where(and(eq(products.tenantId, ctx.tenantId), eq(products.id, id)));
  }

  async findImage(
    tx: Tx,
    ctx: TenantContext,
    id: string,
  ): Promise<{ readonly mime: string; readonly bytes: Uint8Array } | null> {
    const rows = await txOf(tx)
      .select({ mime: products.imageMime, bytes: products.imageBytes })
      .from(products)
      .where(and(eq(products.tenantId, ctx.tenantId), eq(products.id, id)))
      .limit(1);

    const row = rows[0];
    if (row === undefined || row.mime === null || row.bytes === null) return null;
    return { mime: row.mime, bytes: row.bytes };
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
    return txOf(tx)
      .select(PRODUCT_COLUMNS)
      .from(products)
      .innerJoin(units, eq(units.id, products.baseUnitId))
      .leftJoin(brands, eq(brands.id, products.brandId))
      .leftJoin(categories, eq(categories.id, products.categoryId))
      .leftJoin(parentCategories, eq(parentCategories.id, categories.parentId))
      .leftJoin(conversionUnits, eq(conversionUnits.id, products.conversionUnitId))
      .leftJoin(
        usualSuppliers,
        and(
          eq(usualSuppliers.tenantId, ctx.tenantId),
          eq(usualSuppliers.id, products.usualSupplierId),
        ),
      )
      // Left, not inner: a product with no stock yet still belongs in the list,
      // reading zero rather than vanishing from it.
      .leftJoin(
        productCostState,
        and(
          eq(productCostState.tenantId, ctx.tenantId),
          eq(productCostState.productId, products.id),
          isNull(productCostState.deletedAt),
        ),
      );
  }

  private liveInTenant(ctx: TenantContext) {
    return and(eq(products.tenantId, ctx.tenantId), isNull(products.deletedAt));
  }

  private filters(ctx: TenantContext, filter: ProductFilter) {
    const conditions = [];

    if (filter.search !== null && filter.search !== '') {
      /*
       * Every fragment, anywhere in the product's one searchable line, in any
       * order — `salt aci` and `aci salt` are the same question (migration
       * 0026). Each token is its own `LIKE`, ANDed, which is what lets the
       * order stop mattering; `products_search_text_trgm_idx` keeps it off a
       * full scan. Ranking is not attempted here: SQL would need a second copy
       * of a rule that already exists in the domain, so the use case orders
       * what comes back.
       */
      for (const token of searchTokens(filter.search)) {
        conditions.push(sql`${products.searchText} LIKE ${`%${token}%`}`);
      }
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
      afterCursor(
        PRODUCT_SORTS[filter.sort],
        filter.direction,
        sql`${products.id}`,
        sql`anchor.id`,
        sql`products anchor`,
        sql`anchor.id = ${filter.cursor} AND anchor.tenant_id = ${ctx.tenantId}`,
      ),
    ];
  }
}

function toRow(raw: RawProduct): ProductRow {
  return {
    ...raw,
    // CHAR(26) columns come back blank-padded; the join names never are.
    baseUnitName: raw.baseUnitName ?? '',
    hasImage: raw.hasImage === true,
    aliases: raw.aliases ?? null,
    searchText: raw.searchText ?? '',
    status: raw.status as ProductStatus,
    defaultDiscountType: raw.defaultDiscountType as DiscountType | null,
    // A product with no cost-state row has never been stocked, which is zero —
    // not unknown, and not a reason to leave the column blank.
    stockQty: raw.stockQty ?? 0,
    avgUnitCost: raw.avgUnitCost ?? 0,
    usualSupplierName: raw.usualSupplierName ?? null,
    lotValueMinor: bigintMinor(raw.lotValueMinor),
  };
}
