import type {
  NewPurchasePlan,
  NewSupplierOrder,
  PlanListRow,
  PlannerProductRow,
  PlannerReadOptions,
  PlanRow,
  PurchasePlanRepository,
  SupplierOrderListRow,
  SupplierOrderRow,
  TenantContext,
  Tx,
} from '@sher/core-application';
import type { PlanPriority } from '@sher/core-domain';
import { addDays } from '@sher/shared-utils';
import type { Clock } from '@sher/shared-utils';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';

import {
  purchasePlanLines,
  purchasePlans,
  supplierPurchaseOrderLines,
  supplierPurchaseOrders,
} from './schema';
import { txOf } from './unit-of-work';

/**
 * Purchase plans over PostgreSQL (§5.9, Phase 8). No business rule here
 * (R-B6): the suggestion, the priority and the budget run are pure functions in
 * `core-domain`, and this only fetches the numbers they need.
 *
 * **Two things are deliberately derived rather than stored.** How much of a
 * plan line has been bought is a SUM over posted purchase lines pointing at it,
 * and whether a plan has finished follows from that SUM. A cached counter would
 * have to be unwound every time a bill is voided or corrected; a SUM is simply
 * right afterwards.
 */

/**
 * How far back "recently" reaches when guessing a product's supplier from
 * history. Six months is long enough to survive a slow-moving product's gap
 * between deliveries and short enough that a supplier the shop stopped using
 * last year stops being suggested.
 */
const SUPPLIER_HISTORY_DAYS = 180;

interface PlannerRawRow extends Record<string, unknown> {
  product_id: string;
  display_name: string;
  unit_name: string;
  stock_qty: string;
  min_stock_qty: string;
  sold_qty: string;
  selling_days: string;
  pending_qty: string;
  pack_qty: string | null;
  min_order_qty: string | null;
  unit_cost_minor: string;
  selling_price_minor: string;
  usual_supplier_id: string | null;
  usual_supplier_name: string | null;
  history_supplier_id: string | null;
  history_supplier_name: string | null;
}

export class PostgresPurchasePlanRepository implements PurchasePlanRepository {
  constructor(private readonly clock: Clock) {}

  /**
   * Everything the planner computes from, in one pass.
   *
   * Written as one statement rather than a read per product because a shop's
   * catalogue is the unit of work here: five subqueries over four hundred
   * products is one round trip, and four hundred round trips is a screen that
   * never finishes loading.
   *
   * **Sellable stock excludes expired batches and vendor-owned lots.** Buying
   * against stock the shop may not sell is how a shelf ends up double-stocked,
   * and vendor goods were never the shop's to count.
   */
  async readPlannerProducts(
    tx: Tx,
    ctx: TenantContext,
    options: PlannerReadOptions,
  ): Promise<readonly PlannerProductRow[]> {
    const db = txOf(tx);
    const today = this.clock.businessDate(ctx.timezone);
    const since = addDays(today, -options.lookBackDays);
    const supplierSince = addDays(today, -SUPPLIER_HISTORY_DAYS);

    const productFilter =
      options.productIds !== undefined && options.productIds.length > 0
        ? sql`AND p.id IN (${sql.join(
            options.productIds.map((id) => sql`${id}`),
            sql`, `,
          )})`
        : sql``;
    const searchFilter =
      options.search !== undefined && options.search.trim() !== ''
        ? sql`AND p.search_text LIKE ${`%${options.search.trim().toLowerCase()}%`}`
        : sql``;
    const supplierFilter =
      options.supplierPartyId !== undefined
        ? sql`AND COALESCE(p.usual_supplier_id, hist.supplier_party_id) = ${options.supplierPartyId}`
        : sql``;

    const rows = await db.execute<PlannerRawRow>(sql`
      WITH sellable AS (
        SELECT il.product_id,
               COALESCE(SUM(il.qty_remaining), 0) AS qty
          FROM inventory_lots il
         WHERE il.tenant_id = ${ctx.tenantId}
           AND il.deleted_at IS NULL
           AND il.qty_remaining > 0
           AND il.owner_type = 'OWNED'
           AND (il.expiry_date IS NULL OR il.expiry_date >= ${today})
         GROUP BY il.product_id
      ),
      sold AS (
        SELECT sl.product_id,
               COALESCE(SUM(sl.qty), 0) AS qty,
               COUNT(DISTINCT s.business_date) AS selling_days
          FROM sale_lines sl
          JOIN sales s ON s.id = sl.sale_id AND s.tenant_id = sl.tenant_id
         WHERE sl.tenant_id = ${ctx.tenantId}
           AND s.status = 'POSTED'
           AND s.business_date >= ${since}
           AND s.business_date <= ${today}
         GROUP BY sl.product_id
      ),
      pending AS (
        SELECT ppl.product_id,
               COALESCE(SUM(GREATEST(ppl.planned_qty - COALESCE(bought.qty, 0), 0)), 0) AS qty
          FROM purchase_plan_lines ppl
          JOIN purchase_plans pp
            ON pp.id = ppl.plan_id AND pp.tenant_id = ppl.tenant_id
           AND pp.closed_at IS NULL AND pp.deleted_at IS NULL
          LEFT JOIN LATERAL (
            SELECT COALESCE(SUM(pl.qty), 0) AS qty
              FROM purchase_lines pl
              JOIN purchases pu ON pu.id = pl.purchase_id AND pu.tenant_id = pl.tenant_id
             WHERE pl.tenant_id = ppl.tenant_id
               AND pl.plan_line_id = ppl.id
               AND pu.status = 'POSTED'
          ) bought ON TRUE
         WHERE ppl.tenant_id = ${ctx.tenantId}
         GROUP BY ppl.product_id
      ),
      last_cost AS (
        SELECT DISTINCT ON (pl.product_id)
               pl.product_id, pl.unit_price_minor
          FROM purchase_lines pl
          JOIN purchases pu ON pu.id = pl.purchase_id AND pu.tenant_id = pl.tenant_id
         WHERE pl.tenant_id = ${ctx.tenantId}
           AND pu.status = 'POSTED'
         ORDER BY pl.product_id, pu.business_date DESC, pu.id DESC
      ),
      hist AS (
        SELECT DISTINCT ON (pl.product_id)
               pl.product_id, pu.supplier_party_id, COUNT(*) OVER (
                 PARTITION BY pl.product_id, pu.supplier_party_id
               ) AS times
          FROM purchase_lines pl
          JOIN purchases pu ON pu.id = pl.purchase_id AND pu.tenant_id = pl.tenant_id
         WHERE pl.tenant_id = ${ctx.tenantId}
           AND pu.status = 'POSTED'
           AND pu.business_date >= ${supplierSince}
         ORDER BY pl.product_id, times DESC, pu.business_date DESC
      )
      SELECT p.id AS product_id,
             CASE WHEN b.name IS NULL OR b.name = '' THEN p.name
                  ELSE b.name || ' ' || p.name END AS display_name,
             u.name AS unit_name,
             COALESCE(sellable.qty, 0)::text AS stock_qty,
             p.min_stock_qty::text AS min_stock_qty,
             COALESCE(sold.qty, 0)::text AS sold_qty,
             COALESCE(sold.selling_days, 0)::text AS selling_days,
             COALESCE(pending.qty, 0)::text AS pending_qty,
             p.conversion_factor_qty::text AS pack_qty,
             p.min_order_qty::text AS min_order_qty,
             COALESCE(last_cost.unit_price_minor, p.purchase_price_minor)::text AS unit_cost_minor,
             p.selling_price_minor::text AS selling_price_minor,
             p.usual_supplier_id,
             usual.name AS usual_supplier_name,
             hist.supplier_party_id AS history_supplier_id,
             histp.name AS history_supplier_name
        FROM products p
        JOIN units u ON u.id = p.base_unit_id AND u.tenant_id = p.tenant_id
        LEFT JOIN brands b ON b.id = p.brand_id AND b.tenant_id = p.tenant_id
        LEFT JOIN sellable ON sellable.product_id = p.id
        LEFT JOIN sold ON sold.product_id = p.id
        LEFT JOIN pending ON pending.product_id = p.id
        LEFT JOIN last_cost ON last_cost.product_id = p.id
        LEFT JOIN hist ON hist.product_id = p.id
        LEFT JOIN parties usual ON usual.id = p.usual_supplier_id AND usual.tenant_id = p.tenant_id
        LEFT JOIN parties histp ON histp.id = hist.supplier_party_id AND histp.tenant_id = p.tenant_id
       WHERE p.tenant_id = ${ctx.tenantId}
         AND p.deleted_at IS NULL
         AND p.status = 'ACTIVE'
         ${productFilter}
         ${searchFilter}
         ${supplierFilter}
       ORDER BY p.name ASC
       LIMIT ${options.limit}
    `);

    return rows.rows.map((row) => ({
      productId: row.product_id,
      displayName: row.display_name,
      unitName: row.unit_name,
      stockQty: Number(row.stock_qty),
      minStockQty: Number(row.min_stock_qty),
      soldQty: Number(row.sold_qty),
      sellingDays: Number(row.selling_days),
      pendingQty: Number(row.pending_qty),
      packQty: row.pack_qty === null ? null : Number(row.pack_qty),
      minOrderQty: row.min_order_qty === null ? null : Number(row.min_order_qty),
      unitCostMinor: Number(row.unit_cost_minor),
      sellingPriceMinor: Number(row.selling_price_minor),
      usualSupplierId: row.usual_supplier_id,
      usualSupplierName: row.usual_supplier_name,
      historySupplierId: row.history_supplier_id,
      historySupplierName: row.history_supplier_name,
    }));
  }

  async insertPlan(tx: Tx, ctx: TenantContext, plan: NewPurchasePlan): Promise<void> {
    const db = txOf(tx);
    const now = this.clock.now();

    await db.insert(purchasePlans).values({
      id: plan.id,
      tenantId: ctx.tenantId,
      planNumber: plan.planNumber,
      notes: plan.notes,
      status: 'DRAFT',
      lookBackDays: plan.lookBackDays,
      coverDays: plan.coverDays,
      budgetMinor: plan.budgetMinor,
      businessDate: plan.businessDate,
      closedAt: null,
      closedBy: null,
      createdAt: now,
      updatedAt: now,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
      version: 1,
    });

    if (plan.lines.length > 0) {
      await db.insert(purchasePlanLines).values(
        plan.lines.map((line) => ({
          id: line.id,
          tenantId: ctx.tenantId,
          planId: plan.id,
          lineNo: line.lineNo,
          productId: line.productId,
          supplierPartyId: line.supplierPartyId,
          suggestedQty: line.suggestedQty,
          plannedQty: line.plannedQty,
          priority: line.priority,
          stockQty: line.stockQty,
          dailySalesQty: line.dailySalesQty,
          coverDays: line.coverDays,
          unitCostMinor: line.unitCostMinor,
          sellingPriceMinor: line.sellingPriceMinor,
          createdAt: now,
          updatedAt: now,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        })),
      );
    }
  }

  /**
   * Rewrite a plan's lines.
   *
   * Safe to delete and re-insert precisely because a plan posts nothing: there
   * is no stock or ledger effect to unwind, only a list. Lines already pointed
   * at by a posted purchase keep their identity, because deleting one would
   * orphan that purchase's link — so those are updated rather than replaced.
   */
  async replacePlanLines(
    tx: Tx,
    ctx: TenantContext,
    input: {
      readonly planId: string;
      readonly expectedVersion: number;
      readonly notes: string | null;
      readonly budgetMinor: number | null;
      readonly lines: readonly {
        readonly id: string;
        readonly lineNo: number;
        readonly productId: string;
        readonly supplierPartyId: string | null;
        readonly suggestedQty: number;
        readonly plannedQty: number;
        readonly priority: PlanPriority;
        readonly stockQty: number;
        readonly dailySalesQty: number;
        readonly coverDays: number | null;
        readonly unitCostMinor: number;
        readonly sellingPriceMinor: number;
      }[];
    },
  ): Promise<boolean> {
    const db = txOf(tx);
    const now = this.clock.now();

    const updated = await db
      .update(purchasePlans)
      .set({
        notes: input.notes,
        budgetMinor: input.budgetMinor,
        updatedAt: now,
        updatedBy: ctx.userId,
        version: sql`${purchasePlans.version} + 1`,
      })
      .where(
        and(
          eq(purchasePlans.tenantId, ctx.tenantId),
          eq(purchasePlans.id, input.planId),
          eq(purchasePlans.version, input.expectedVersion),
          isNull(purchasePlans.deletedAt),
        ),
      )
      .returning({ id: purchasePlans.id });
    if (updated.length === 0) return false;

    /*
     * A line a posted purchase already points at is kept and updated in place;
     * the rest are replaced. Otherwise re-saving a plan after one delivery
     * would break the link that tells the shop what it is still waiting for.
     */
    const kept = await db.execute<{ product_id: string; id: string }>(sql`
      SELECT ppl.id, ppl.product_id
        FROM purchase_plan_lines ppl
       WHERE ppl.tenant_id = ${ctx.tenantId}
         AND ppl.plan_id = ${input.planId}
         AND EXISTS (
           SELECT 1 FROM purchase_lines pl
            WHERE pl.tenant_id = ppl.tenant_id AND pl.plan_line_id = ppl.id
         )
    `);
    const keptByProduct = new Map(kept.rows.map((row) => [row.product_id, row.id]));

    await db.execute(sql`
      DELETE FROM purchase_plan_lines
       WHERE tenant_id = ${ctx.tenantId}
         AND plan_id = ${input.planId}
         AND NOT EXISTS (
           SELECT 1 FROM purchase_lines pl
            WHERE pl.tenant_id = ${ctx.tenantId} AND pl.plan_line_id = purchase_plan_lines.id
         )
    `);

    for (const line of input.lines) {
      const keptId = keptByProduct.get(line.productId);
      if (keptId !== undefined) {
        await db
          .update(purchasePlanLines)
          .set({
            lineNo: line.lineNo,
            supplierPartyId: line.supplierPartyId,
            suggestedQty: line.suggestedQty,
            plannedQty: line.plannedQty,
            priority: line.priority,
            updatedAt: now,
            updatedBy: ctx.userId,
          })
          .where(
            and(eq(purchasePlanLines.tenantId, ctx.tenantId), eq(purchasePlanLines.id, keptId)),
          );
        continue;
      }

      await db.insert(purchasePlanLines).values({
        id: line.id,
        tenantId: ctx.tenantId,
        planId: input.planId,
        lineNo: line.lineNo,
        productId: line.productId,
        supplierPartyId: line.supplierPartyId,
        suggestedQty: line.suggestedQty,
        plannedQty: line.plannedQty,
        priority: line.priority,
        stockQty: line.stockQty,
        dailySalesQty: line.dailySalesQty,
        coverDays: line.coverDays,
        unitCostMinor: line.unitCostMinor,
        sellingPriceMinor: line.sellingPriceMinor,
        createdAt: now,
        updatedAt: now,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      });
    }
    return true;
  }

  async findPlan(tx: Tx, ctx: TenantContext, planId: string): Promise<PlanRow | null> {
    const db = txOf(tx);

    const header = await db
      .select()
      .from(purchasePlans)
      .where(
        and(
          eq(purchasePlans.tenantId, ctx.tenantId),
          eq(purchasePlans.id, planId),
          isNull(purchasePlans.deletedAt),
        ),
      )
      .limit(1);
    const plan = header[0];
    if (plan === undefined) return null;

    const lines = await db.execute<{
      id: string;
      line_no: number;
      product_id: string;
      display_name: string;
      unit_name: string;
      supplier_party_id: string | null;
      supplier_name: string | null;
      priority: string;
      suggested_qty: string;
      planned_qty: string;
      received_qty: string;
      stock_qty: string;
      cover_days: number | null;
      unit_cost_minor: string;
      selling_price_minor: string;
    }>(sql`
      SELECT ppl.id, ppl.line_no, ppl.product_id,
             CASE WHEN b.name IS NULL OR b.name = '' THEN p.name
                  ELSE b.name || ' ' || p.name END AS display_name,
             u.name AS unit_name,
             ppl.supplier_party_id, sup.name AS supplier_name,
             ppl.priority, ppl.suggested_qty::text, ppl.planned_qty::text,
             COALESCE(bought.qty, 0)::text AS received_qty,
             ppl.stock_qty::text, ppl.cover_days,
             ppl.unit_cost_minor::text, ppl.selling_price_minor::text
        FROM purchase_plan_lines ppl
        JOIN products p ON p.id = ppl.product_id AND p.tenant_id = ppl.tenant_id
        JOIN units u ON u.id = p.base_unit_id AND u.tenant_id = p.tenant_id
        LEFT JOIN brands b ON b.id = p.brand_id AND b.tenant_id = p.tenant_id
        LEFT JOIN parties sup ON sup.id = ppl.supplier_party_id AND sup.tenant_id = ppl.tenant_id
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(pl.qty), 0) AS qty
            FROM purchase_lines pl
            JOIN purchases pu ON pu.id = pl.purchase_id AND pu.tenant_id = pl.tenant_id
           WHERE pl.tenant_id = ppl.tenant_id
             AND pl.plan_line_id = ppl.id
             AND pu.status = 'POSTED'
        ) bought ON TRUE
       WHERE ppl.tenant_id = ${ctx.tenantId}
         AND ppl.plan_id = ${planId}
       ORDER BY ppl.line_no ASC
    `);

    const orders = await db.execute<{
      id: string;
      order_number: string;
      supplier_party_id: string;
      supplier_name: string;
      business_date: string;
      line_count: string;
    }>(sql`
      SELECT spo.id, spo.order_number, spo.supplier_party_id,
             COALESCE(sup.name, '') AS supplier_name,
             spo.business_date::text,
             (SELECT COUNT(*) FROM supplier_purchase_order_lines l
               WHERE l.tenant_id = spo.tenant_id AND l.order_id = spo.id)::text AS line_count
        FROM supplier_purchase_orders spo
        LEFT JOIN parties sup ON sup.id = spo.supplier_party_id AND sup.tenant_id = spo.tenant_id
       WHERE spo.tenant_id = ${ctx.tenantId}
         AND spo.plan_id = ${planId}
         AND spo.deleted_at IS NULL
       ORDER BY spo.created_at ASC
    `);

    return {
      id: plan.id,
      planNumber: plan.planNumber,
      notes: plan.notes,
      status: plan.status,
      lookBackDays: plan.lookBackDays,
      coverDays: plan.coverDays,
      budgetMinor: plan.budgetMinor,
      businessDate: plan.businessDate,
      closed: plan.closedAt !== null,
      version: plan.version,
      lines: lines.rows.map((row) => ({
        id: row.id,
        lineNo: row.line_no,
        productId: row.product_id,
        displayName: row.display_name,
        unitName: row.unit_name,
        supplierPartyId: row.supplier_party_id,
        supplierName: row.supplier_name,
        priority: row.priority as PlanPriority,
        suggestedQty: Number(row.suggested_qty),
        plannedQty: Number(row.planned_qty),
        receivedQty: Number(row.received_qty),
        stockQty: Number(row.stock_qty),
        coverDays: row.cover_days,
        unitCostMinor: Number(row.unit_cost_minor),
        sellingPriceMinor: Number(row.selling_price_minor),
      })),
      orders: orders.rows.map((row) => ({
        id: row.id,
        orderNumber: row.order_number,
        supplierPartyId: row.supplier_party_id,
        supplierName: row.supplier_name,
        businessDate: row.business_date,
        lineCount: Number(row.line_count),
      })),
    };
  }

  async listPlans(
    tx: Tx,
    ctx: TenantContext,
    options: { readonly status?: string | undefined; readonly limit: number },
  ): Promise<readonly PlanListRow[]> {
    const db = txOf(tx);

    const rows = await db.execute<{
      id: string;
      plan_number: string;
      notes: string | null;
      status: string;
      business_date: string;
      closed: boolean;
      line_count: string;
      supplier_count: string;
      remaining_qty: string;
      investment_minor: string;
      expected_profit_minor: string;
      version: number;
    }>(sql`
      SELECT pp.id, pp.plan_number, pp.notes, pp.status, pp.business_date::text,
             pp.version,
             (pp.closed_at IS NOT NULL) AS closed,
             COUNT(ppl.id)::text AS line_count,
             COUNT(DISTINCT ppl.supplier_party_id)::text AS supplier_count,
             COALESCE(SUM(GREATEST(ppl.planned_qty - COALESCE(bought.qty, 0), 0)), 0)::text AS remaining_qty,
             COALESCE(SUM(ROUND(ppl.planned_qty::numeric * ppl.unit_cost_minor::numeric / 1000)), 0)::text AS investment_minor,
             COALESCE(SUM(
               ROUND(ppl.planned_qty::numeric * ppl.selling_price_minor::numeric / 1000)
               - ROUND(ppl.planned_qty::numeric * ppl.unit_cost_minor::numeric / 1000)
             ), 0)::text AS expected_profit_minor
        FROM purchase_plans pp
        LEFT JOIN purchase_plan_lines ppl
          ON ppl.plan_id = pp.id AND ppl.tenant_id = pp.tenant_id
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(pl.qty), 0) AS qty
            FROM purchase_lines pl
            JOIN purchases pu ON pu.id = pl.purchase_id AND pu.tenant_id = pl.tenant_id
           WHERE pl.tenant_id = pp.tenant_id
             AND pl.plan_line_id = ppl.id
             AND pu.status = 'POSTED'
        ) bought ON TRUE
       WHERE pp.tenant_id = ${ctx.tenantId}
         AND pp.deleted_at IS NULL
       GROUP BY pp.id
       ORDER BY pp.business_date DESC, pp.id DESC
       LIMIT ${options.limit}
    `);

    const all = rows.rows.map((row) => ({
      id: row.id,
      planNumber: row.plan_number,
      notes: row.notes,
      status: row.status,
      businessDate: row.business_date,
      closed: row.closed,
      lineCount: Number(row.line_count),
      supplierCount: Number(row.supplier_count),
      plannedQtyRemaining: Number(row.remaining_qty),
      investmentMinor: Number(row.investment_minor),
      expectedProfitMinor: Number(row.expected_profit_minor),
      version: row.version,
    }));

    return options.status === undefined
      ? all
      : all.filter((row) => row.status === options.status);
  }

  /** `status = 'DRAFT'` in the WHERE is what makes a plan decidable once. */
  async decidePlan(
    tx: Tx,
    ctx: TenantContext,
    input: {
      readonly planId: string;
      readonly expectedVersion: number;
      readonly status: string;
      readonly at: Date;
    },
  ): Promise<boolean> {
    const updated = await txOf(tx)
      .update(purchasePlans)
      .set({
        status: input.status,
        decidedAt: input.at,
        decidedBy: ctx.userId,
        updatedAt: this.clock.now(),
        updatedBy: ctx.userId,
        version: sql`${purchasePlans.version} + 1`,
      })
      .where(
        and(
          eq(purchasePlans.tenantId, ctx.tenantId),
          eq(purchasePlans.id, input.planId),
          eq(purchasePlans.version, input.expectedVersion),
          eq(purchasePlans.status, 'DRAFT'),
          isNull(purchasePlans.deletedAt),
        ),
      )
      .returning({ id: purchasePlans.id });
    return updated.length > 0;
  }

  async deletePlan(
    tx: Tx,
    ctx: TenantContext,
    input: { readonly planId: string; readonly expectedVersion: number },
  ): Promise<boolean> {
    const now = this.clock.now();
    const updated = await txOf(tx)
      .update(purchasePlans)
      .set({
        deletedAt: now,
        deletedBy: ctx.userId,
        updatedAt: now,
        updatedBy: ctx.userId,
        version: sql`${purchasePlans.version} + 1`,
      })
      .where(
        and(
          eq(purchasePlans.tenantId, ctx.tenantId),
          eq(purchasePlans.id, input.planId),
          eq(purchasePlans.version, input.expectedVersion),
          // A plan with orders against it is history, not a draft.
          eq(purchasePlans.status, 'DRAFT'),
          isNull(purchasePlans.deletedAt),
        ),
      )
      .returning({ id: purchasePlans.id });
    return updated.length > 0;
  }

  async listSupplierOrders(
    tx: Tx,
    ctx: TenantContext,
    options: { readonly status?: string | undefined; readonly limit: number },
  ): Promise<readonly SupplierOrderListRow[]> {
    const statusFilter =
      options.status === undefined ? sql`` : sql`AND spo.status = ${options.status}`;

    const rows = await txOf(tx).execute<{
      id: string;
      order_number: string;
      business_date: string;
      supplier_party_id: string;
      supplier_name: string;
      plan_id: string;
      plan_number: string;
      item_count: string;
      total_qty: string;
      status: string;
      purchase_id: string | null;
      purchase_number: string | null;
    }>(sql`
      SELECT spo.id, spo.order_number, spo.business_date::text,
             spo.supplier_party_id, COALESCE(sup.name, '') AS supplier_name,
             spo.plan_id, pp.plan_number,
             COUNT(l.id)::text AS item_count,
             COALESCE(SUM(l.qty), 0)::text AS total_qty,
             spo.status, spo.purchase_id, pu.purchase_number AS purchase_number
        FROM supplier_purchase_orders spo
        JOIN purchase_plans pp ON pp.id = spo.plan_id AND pp.tenant_id = spo.tenant_id
        LEFT JOIN parties sup ON sup.id = spo.supplier_party_id AND sup.tenant_id = spo.tenant_id
        LEFT JOIN supplier_purchase_order_lines l
          ON l.order_id = spo.id AND l.tenant_id = spo.tenant_id
        LEFT JOIN purchases pu ON pu.id = spo.purchase_id AND pu.tenant_id = spo.tenant_id
       WHERE spo.tenant_id = ${ctx.tenantId}
         AND spo.deleted_at IS NULL
         ${statusFilter}
       GROUP BY spo.id, sup.name, pp.plan_number, pu.purchase_number
       ORDER BY spo.business_date DESC, spo.id DESC
       LIMIT ${options.limit}
    `);

    return rows.rows.map((row) => ({
      id: row.id,
      orderNumber: row.order_number,
      businessDate: row.business_date,
      supplierPartyId: row.supplier_party_id,
      supplierName: row.supplier_name,
      planId: row.plan_id,
      planNumber: row.plan_number,
      itemCount: Number(row.item_count),
      totalQty: Number(row.total_qty),
      status: row.status,
      purchaseId: row.purchase_id,
      purchaseNumber: row.purchase_number,
    }));
  }

  async insertSupplierOrder(
    tx: Tx,
    ctx: TenantContext,
    order: NewSupplierOrder,
  ): Promise<void> {
    const db = txOf(tx);
    const now = this.clock.now();

    await db.insert(supplierPurchaseOrders).values({
      id: order.id,
      tenantId: ctx.tenantId,
      planId: order.planId,
      supplierPartyId: order.supplierPartyId,
      orderNumber: order.orderNumber,
      businessDate: order.businessDate,
      note: order.note,
      status: 'OPEN',
      purchaseId: null,
      createdAt: now,
      updatedAt: now,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
      version: 1,
    });

    await db.insert(supplierPurchaseOrderLines).values(
      order.lines.map((line) => ({
        id: line.id,
        tenantId: ctx.tenantId,
        orderId: order.id,
        lineNo: line.lineNo,
        productId: line.productId,
        productName: line.productName,
        unitName: line.unitName,
        qty: line.qty,
        createdAt: now,
        createdBy: ctx.userId,
      })),
    );
  }

  async findSupplierOrder(
    tx: Tx,
    ctx: TenantContext,
    orderId: string,
  ): Promise<SupplierOrderRow | null> {
    const db = txOf(tx);

    const header = await db.execute<{
      id: string;
      order_number: string;
      business_date: string;
      note: string | null;
      status: string;
      supplier_party_id: string;
      supplier_name: string;
      supplier_phone: string | null;
      supplier_address: string | null;
      purchase_id: string | null;
      purchase_number: string | null;
    }>(sql`
      SELECT spo.id, spo.order_number, spo.business_date::text, spo.note,
             spo.status, spo.supplier_party_id,
             COALESCE(sup.name, '') AS supplier_name,
             sup.phone AS supplier_phone,
             sup.address AS supplier_address,
             spo.purchase_id, pu.purchase_number AS purchase_number
        FROM supplier_purchase_orders spo
        LEFT JOIN parties sup ON sup.id = spo.supplier_party_id AND sup.tenant_id = spo.tenant_id
        LEFT JOIN purchases pu ON pu.id = spo.purchase_id AND pu.tenant_id = spo.tenant_id
       WHERE spo.tenant_id = ${ctx.tenantId}
         AND spo.id = ${orderId}
         AND spo.deleted_at IS NULL
       LIMIT 1
    `);
    const order = header.rows[0];
    if (order === undefined) return null;

    const lines = await db
      .select({
        lineNo: supplierPurchaseOrderLines.lineNo,
        productId: supplierPurchaseOrderLines.productId,
        productName: supplierPurchaseOrderLines.productName,
        unitName: supplierPurchaseOrderLines.unitName,
        qty: supplierPurchaseOrderLines.qty,
      })
      .from(supplierPurchaseOrderLines)
      .where(
        and(
          eq(supplierPurchaseOrderLines.tenantId, ctx.tenantId),
          eq(supplierPurchaseOrderLines.orderId, orderId),
        ),
      )
      .orderBy(asc(supplierPurchaseOrderLines.lineNo));

    return {
      id: order.id,
      orderNumber: order.order_number,
      businessDate: order.business_date,
      note: order.note,
      status: order.status,
      supplierPartyId: order.supplier_party_id,
      supplierName: order.supplier_name,
      supplierPhone: order.supplier_phone,
      supplierAddress: order.supplier_address,
      purchaseId: order.purchase_id,
      purchaseNumber: order.purchase_number,
      lines: lines.map((line) => ({
        lineNo: line.lineNo,
        productId: line.productId,
        productName: line.productName,
        unitName: line.unitName,
        qty: line.qty,
      })),
    };
  }
}

