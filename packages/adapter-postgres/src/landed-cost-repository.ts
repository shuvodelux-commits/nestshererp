import type {
  CostStateRow,
  LandedCostPurchaseRow,
  LandedCostRepository,
  NewLandedCost,
  TenantContext,
  Tx,
} from '@sher/core-application';
import type { AccountCode } from '@sher/core-domain';
import type { Clock } from '@sher/shared-utils';
import { and, eq, sql } from 'drizzle-orm';

import {
  inventoryLots,
  journalEntries,
  journalLines,
  productCostState,
  purchaseLandedCosts,
  purchaseLandedCostAllocations,
  purchaseLines,
} from './schema';
import { txOf } from './unit-of-work';

/**
 * Landed costs over PostgreSQL (§5.12, Phase 8). No business rule here (R-B6):
 * how a cost is spread, and how much of it can still be capitalised, are
 * decided in `core-domain` and by the use case.
 */
export class PostgresLandedCostRepository implements LandedCostRepository {
  constructor(private readonly clock: Clock) {}

  async findPurchaseForLandedCost(
    tx: Tx,
    ctx: TenantContext,
    purchaseId: string,
  ): Promise<LandedCostPurchaseRow | null> {
    const db = txOf(tx);

    const header = await db.execute<{
      id: string;
      number: string;
      supplier_party_id: string;
      business_date: string;
      status: string;
      extra_cost_minor: string;
    }>(sql`
      SELECT p.id, p.purchase_number AS number, p.supplier_party_id, p.business_date::text, p.status,
             p.extra_cost_minor::text
        FROM purchases p
       WHERE p.tenant_id = ${ctx.tenantId} AND p.id = ${purchaseId} AND p.deleted_at IS NULL
       LIMIT 1
    `);
    const purchase = header.rows[0];
    if (purchase === undefined) return null;

    const lines = await db.execute<{
      purchase_line_id: string;
      product_id: string;
      location_id: string;
      qty: string;
      line_total_minor: string;
      extra_cost_share_minor: string;
      lot_id: string;
      lot_qty_received: string;
      lot_qty_remaining: string;
      lot_landed_cost_total: string;
      lot_actual_unit_cost: string;
    }>(sql`
      SELECT pl.id AS purchase_line_id, pl.product_id, il.location_id,
             pl.qty::text, pl.line_total_minor::text, pl.extra_cost_share_minor::text,
             pl.lot_id,
             il.qty_received::text AS lot_qty_received,
             il.qty_remaining::text AS lot_qty_remaining,
             il.landed_cost_total::text AS lot_landed_cost_total,
             il.actual_unit_cost::text AS lot_actual_unit_cost
        FROM purchase_lines pl
        JOIN inventory_lots il ON il.id = pl.lot_id AND il.tenant_id = pl.tenant_id
       WHERE pl.tenant_id = ${ctx.tenantId} AND pl.purchase_id = ${purchaseId}
       ORDER BY pl.line_no ASC
    `);

    return {
      id: purchase.id,
      number: purchase.number,
      supplierPartyId: purchase.supplier_party_id,
      businessDate: purchase.business_date,
      status: purchase.status,
      extraCostMinor: Number(purchase.extra_cost_minor),
      lineCount: lines.rows.length,
      lines: lines.rows.map((row) => ({
        purchaseLineId: row.purchase_line_id,
        productId: row.product_id,
        locationId: row.location_id,
        qty: Number(row.qty),
        lineTotalMinor: Number(row.line_total_minor),
        extraCostShareMinor: Number(row.extra_cost_share_minor),
        lotId: row.lot_id,
        lotQtyReceived: Number(row.lot_qty_received),
        lotQtyRemaining: Number(row.lot_qty_remaining),
        lotLandedCostTotal: Number(row.lot_landed_cost_total),
        lotActualUnitCost: Number(row.lot_actual_unit_cost),
      })),
    };
  }

  async listLandedCosts(
    tx: Tx,
    ctx: TenantContext,
    purchaseId: string,
  ): Promise<readonly NewLandedCost[]> {
    const rows = await txOf(tx)
      .select()
      .from(purchaseLandedCosts)
      .where(
        and(
          eq(purchaseLandedCosts.tenantId, ctx.tenantId),
          eq(purchaseLandedCosts.purchaseId, purchaseId),
        ),
      )
      .orderBy(purchaseLandedCosts.lineNo);

    return rows.map((row) => ({
      id: row.id,
      purchaseId: row.purchaseId,
      lineNo: row.lineNo,
      category: row.category,
      method: row.method,
      amountMinor: row.amountMinor,
      inventoryShareMinor: row.inventoryShareMinor,
      cogsShareMinor: row.cogsShareMinor,
      businessDate: row.businessDate,
      operationId: row.operationId,
      journalEntryId: row.journalEntryId,
      description: row.description,
      paidAccountCode: row.paidAccountCode,
      sessionId: row.sessionId,
      allocations: [],
    }));
  }

  async findCostStates(
    tx: Tx,
    ctx: TenantContext,
    keys: readonly { readonly productId: string; readonly locationId: string }[],
  ): Promise<readonly CostStateRow[]> {
    if (keys.length === 0) return [];

    const pairs = sql.join(
      keys.map((key) => sql`(${key.productId}, ${key.locationId})`),
      sql`, `,
    );
    const rows = await txOf(tx).execute<{
      id: string;
      product_id: string;
      location_id: string;
      qty_on_hand: string;
      avg_unit_cost: string;
    }>(sql`
      SELECT id, product_id, location_id, qty_on_hand::text, avg_unit_cost::text
        FROM product_cost_state
       WHERE tenant_id = ${ctx.tenantId}
         AND (product_id, location_id) IN (${pairs})
    `);

    return rows.rows.map((row) => ({
      id: row.id,
      productId: row.product_id,
      locationId: row.location_id,
      qtyOnHand: Number(row.qty_on_hand),
      avgUnitCost: Number(row.avg_unit_cost),
    }));
  }

  async recordLandedCost(
    tx: Tx,
    ctx: TenantContext,
    input: {
      readonly cost: NewLandedCost;
      readonly purchaseNumber: string;
      readonly entryMode: string;
      readonly lots: readonly { readonly lotId: string; readonly landedCostTotal: number; readonly actualUnitCost: number }[];
      readonly lineShares: readonly { readonly purchaseLineId: string; readonly extraCostShareMinor: number }[];
      readonly costStates: readonly { readonly id: string; readonly avgUnitCost: number }[];
      readonly journalLines: readonly {
        readonly id: string;
        readonly account: AccountCode;
        readonly amountMinor: number;
        readonly partyId: string | null;
      }[];
    },
  ): Promise<void> {
    const db = txOf(tx);
    const now = this.clock.now();

    await db.insert(purchaseLandedCosts).values({
      id: input.cost.id,
      tenantId: ctx.tenantId,
      purchaseId: input.cost.purchaseId,
      lineNo: input.cost.lineNo,
      category: input.cost.category,
      method: input.cost.method,
      amountMinor: input.cost.amountMinor,
      inventoryShareMinor: input.cost.inventoryShareMinor,
      cogsShareMinor: input.cost.cogsShareMinor,
      journalEntryId: input.cost.journalEntryId,
      businessDate: input.cost.businessDate,
      operationId: input.cost.operationId,
      description: input.cost.description,
      paidAccountCode: input.cost.paidAccountCode,
      sessionId: input.cost.sessionId,
      createdAt: now,
      updatedAt: now,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
      version: 1,
    });

    if (input.cost.allocations.length > 0) {
      await db.insert(purchaseLandedCostAllocations).values(
        input.cost.allocations.map((allocation) => ({
          id: allocation.id,
          tenantId: ctx.tenantId,
          landedCostId: input.cost.id,
          purchaseLineId: allocation.purchaseLineId,
          amountMinor: allocation.amountMinor,
          createdAt: now,
          createdBy: ctx.userId,
        })),
      );
    }

    for (const lot of input.lots) {
      await db
        .update(inventoryLots)
        .set({
          landedCostTotal: lot.landedCostTotal,
          actualUnitCost: lot.actualUnitCost,
          updatedAt: now,
          updatedBy: ctx.userId,
          version: sql`${inventoryLots.version} + 1`,
        })
        .where(and(eq(inventoryLots.tenantId, ctx.tenantId), eq(inventoryLots.id, lot.lotId)));
    }

    for (const line of input.lineShares) {
      await db
        .update(purchaseLines)
        .set({ extraCostShareMinor: line.extraCostShareMinor })
        .where(
          and(eq(purchaseLines.tenantId, ctx.tenantId), eq(purchaseLines.id, line.purchaseLineId)),
        );
    }

    for (const state of input.costStates) {
      await db
        .update(productCostState)
        .set({
          avgUnitCost: state.avgUnitCost,
          lastRecomputedAt: now,
          updatedAt: now,
          updatedBy: ctx.userId,
          version: sql`${productCostState.version} + 1`,
        })
        .where(and(eq(productCostState.tenantId, ctx.tenantId), eq(productCostState.id, state.id)));
    }

    if (input.cost.journalEntryId !== null) {
      await db.insert(journalEntries).values({
        id: input.cost.journalEntryId,
        tenantId: ctx.tenantId,
        createdAt: now,
        createdBy: ctx.userId,
        businessDate: input.cost.businessDate,
        sourceDocumentType: 'PURCHASE_LANDED_COST',
        sourceDocumentId: input.cost.id,
        sourceNumber: input.purchaseNumber,
        entryMode: input.entryMode,
      });
      await db.insert(journalLines).values(
        input.journalLines.map((line) => ({
          id: line.id,
          tenantId: ctx.tenantId,
          createdAt: now,
          createdBy: ctx.userId,
          journalEntryId: input.cost.journalEntryId ?? '',
          accountCode: line.account,
          amountMinor: line.amountMinor,
          partyId: line.partyId,
        })),
      );
    }
  }
}
