import type {
  CostAdjustmentListRow, InventoryCostStateRow, InventoryLotFilter, InventoryLotRow, InventoryMovementRow,
  InventoryRepository, InventoryStockRow, InventoryValuationLotRow, LocationRow,
  OpeningStockRecord, ProductStockPosition, StockAdjustmentFilter, StockAdjustmentListRow,
  StockAdjustmentRecord, StockCostLayerRow, TenantContext, Tx,
} from '@sher/core-application';
import type { InventoryLotSort } from '@sher/core-contracts';
import type { AccountCode, StockAdjustmentReason } from '@sher/core-domain';
import type { Clock } from '@sher/shared-utils';
import { and, asc, desc, eq, gte, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

import {
  costAdjustments, inventoryLocations, inventoryLots, journalEntries, journalLines, lotConsumptions,
  productCostState, products, stockAdjustments, stockMovements, stockOpenings, units, users,
} from './schema';
import { afterCursor, orderBy, ownColumn, type SortableColumn } from './keyset-sort';
import { txOf } from './unit-of-work';

/**
 * A tenant-local day range over a `business_date` column.
 *
 * `business_date` is already a tenant-local `DATE`, so comparing it to the
 * `YYYY-MM-DD` strings the client sent is exact — no instant conversion, and no
 * chance of a Dhaka afternoon landing in the previous day (§3.5).
 */
function dateRange(column: PgColumn, filter: StockAdjustmentFilter) {
  return [
    ...(filter.fromDate === null ? [] : [gte(column, filter.fromDate)]),
    ...(filter.toDate === null ? [] : [lte(column, filter.toDate)]),
  ];
}

const LOT_SORTS: Record<InventoryLotSort, SortableColumn> = {
  businessDate: ownColumn(sql`${inventoryLots.businessDate}`, sql`anchor.business_date`),
  expiryDate: ownColumn(sql`${inventoryLots.expiryDate}`, sql`anchor.expiry_date`, sql`DATE '9999-12-31'`),
  qtyReceived: ownColumn(sql`${inventoryLots.qtyReceived}`, sql`anchor.qty_received`),
  qtyRemaining: ownColumn(sql`${inventoryLots.qtyRemaining}`, sql`anchor.qty_remaining`),
  status: ownColumn(sql`${inventoryLots.status}`, sql`anchor.status`),
};

export class PostgresInventoryRepository implements InventoryRepository {
  constructor(private readonly clock: Clock) {}

  async findDefaultLocation(tx: Tx, ctx: TenantContext): Promise<LocationRow | null> {
    const rows = await txOf(tx).select({ id: inventoryLocations.id, name: inventoryLocations.name }).from(inventoryLocations)
      .where(and(eq(inventoryLocations.tenantId, ctx.tenantId), eq(inventoryLocations.isDefault, true), isNull(inventoryLocations.deletedAt))).limit(1);
    const row = rows[0]; return row === undefined ? null : { id: row.id.trim(), name: row.name };
  }

  async createDefaultLocation(tx: Tx, ctx: TenantContext, id: string): Promise<LocationRow> {
    const now = this.clock.now(); const name = 'Main Shop';
    await txOf(tx).insert(inventoryLocations).values({ id, tenantId: ctx.tenantId, name, isDefault: true, createdAt: now, updatedAt: now, createdBy: ctx.userId, updatedBy: ctx.userId, version: 1 });
    return { id, name };
  }

  findOpeningByOperationId(tx: Tx, ctx: TenantContext, operationId: string): Promise<OpeningStockRecord | null> {
    return this.findOpening(tx, ctx, eq(stockOpenings.operationId, operationId));
  }
  findOpeningById(tx: Tx, ctx: TenantContext, id: string): Promise<OpeningStockRecord | null> {
    return this.findOpening(tx, ctx, eq(stockOpenings.id, id));
  }
  findOpeningByProduct(tx: Tx, ctx: TenantContext, productId: string): Promise<OpeningStockRecord | null> {
    return this.findOpening(tx, ctx, eq(stockOpenings.productId, productId));
  }

  private async findOpening(tx: Tx, ctx: TenantContext, criterion: ReturnType<typeof eq>): Promise<OpeningStockRecord | null> {
    const db = txOf(tx);
    const rows = await db.select({
      id: stockOpenings.id, number: stockOpenings.openingNumber, operationId: stockOpenings.operationId,
      productId: stockOpenings.productId, productName: products.name, locationId: stockOpenings.locationId,
      locationName: inventoryLocations.name, qty: stockOpenings.qty, unitCost: stockOpenings.unitCost,
      valueMinor: stockOpenings.valueMinor, businessDate: stockOpenings.businessDate, entryMode: stockOpenings.entryMode,
    }).from(stockOpenings).innerJoin(products, and(eq(products.tenantId, ctx.tenantId), eq(products.id, stockOpenings.productId)))
      .innerJoin(inventoryLocations, and(eq(inventoryLocations.tenantId, ctx.tenantId), eq(inventoryLocations.id, stockOpenings.locationId)))
      .where(and(eq(stockOpenings.tenantId, ctx.tenantId), criterion, isNull(stockOpenings.deletedAt))).limit(1);
    const row = rows[0]; if (row === undefined) return null;
    const [lots, movements, entries] = await Promise.all([
      db.select({ id: inventoryLots.id, expiryDate: inventoryLots.expiryDate }).from(inventoryLots).where(and(eq(inventoryLots.tenantId, ctx.tenantId), eq(inventoryLots.sourceDocumentId, row.id))).limit(1),
      db.select({ id: stockMovements.id }).from(stockMovements).where(and(eq(stockMovements.tenantId, ctx.tenantId), eq(stockMovements.sourceDocumentId, row.id))).limit(1),
      db.select({ id: journalEntries.id }).from(journalEntries).where(and(eq(journalEntries.tenantId, ctx.tenantId), eq(journalEntries.sourceDocumentId, row.id))).limit(1),
    ]);
    const entryId = entries[0]?.id.trim() ?? '';
    const lines = entryId === '' ? [] : await db.select({ id: journalLines.id, account: journalLines.accountCode, amountMinor: journalLines.amountMinor, partyId: journalLines.partyId }).from(journalLines).where(and(eq(journalLines.tenantId, ctx.tenantId), eq(journalLines.journalEntryId, entryId)));
    return {
      id: row.id.trim(), number: row.number, operationId: row.operationId.trim(), productId: row.productId.trim(), productName: row.productName,
      locationId: row.locationId.trim(), locationName: row.locationName, qty: row.qty, unitCost: row.unitCost, valueMinor: row.valueMinor,
      businessDate: row.businessDate, expiryDate: lots[0]?.expiryDate ?? null,
      entryMode: row.entryMode as OpeningStockRecord['entryMode'], lotId: lots[0]?.id.trim() ?? '',
      movementId: movements[0]?.id.trim() ?? '', journalEntryId: entryId, costStateId: '',
      journalLines: lines.map((line) => ({ id: line.id.trim(), account: line.account as AccountCode, amountMinor: line.amountMinor, partyId: line.partyId?.trim() ?? null })),
    };
  }

  async insertOpening(tx: Tx, ctx: TenantContext, opening: OpeningStockRecord): Promise<void> {
    const db = txOf(tx); const now = this.clock.now();
    await db.insert(stockOpenings).values({ id: opening.id, tenantId: ctx.tenantId, openingNumber: opening.number, productId: opening.productId, locationId: opening.locationId, qty: opening.qty, unitCost: opening.unitCost, valueMinor: opening.valueMinor, businessDate: opening.businessDate, entryMode: opening.entryMode, status: 'POSTED', operationId: opening.operationId, createdAt: now, updatedAt: now, createdBy: ctx.userId, updatedBy: ctx.userId, version: 1 });
    await db.insert(inventoryLots).values({ id: opening.lotId, tenantId: ctx.tenantId, productId: opening.productId, locationId: opening.locationId, ownerType: 'OWNED', vendorPartyId: null, supplierPartyId: null, sourceDocumentType: 'OPENING_STOCK', sourceDocumentId: opening.id, sourceNumber: opening.number, qtyReceived: opening.qty, qtyRemaining: opening.qty, purchaseUnitCost: opening.unitCost, landedCostTotal: 0, actualUnitCost: opening.unitCost, businessDate: opening.businessDate, expiryDate: opening.expiryDate, status: 'OPEN', createdAt: now, updatedAt: now, createdBy: ctx.userId, updatedBy: ctx.userId, version: 1 });
    await db.insert(stockMovements).values({ id: opening.movementId, tenantId: ctx.tenantId, createdAt: now, createdBy: ctx.userId, productId: opening.productId, locationId: opening.locationId, lotId: opening.lotId, qty: opening.qty, direction: 'IN', businessDate: opening.businessDate, sourceDocumentType: 'OPENING_STOCK', sourceDocumentId: opening.id, sourceNumber: opening.number, unitCost: opening.unitCost });
    await db.insert(productCostState).values({ id: opening.costStateId, tenantId: ctx.tenantId, productId: opening.productId, locationId: opening.locationId, avgUnitCost: opening.unitCost, qtyOnHand: opening.qty, lastRecomputedAt: now, createdAt: now, updatedAt: now, createdBy: ctx.userId, updatedBy: ctx.userId, version: 1 });
    await db.insert(journalEntries).values({ id: opening.journalEntryId, tenantId: ctx.tenantId, createdAt: now, createdBy: ctx.userId, businessDate: opening.businessDate, sourceDocumentType: 'OPENING_STOCK', sourceDocumentId: opening.id, sourceNumber: opening.number, entryMode: opening.entryMode });
    await db.insert(journalLines).values(opening.journalLines.map((line) => ({ id: line.id, tenantId: ctx.tenantId, createdAt: now, createdBy: ctx.userId, journalEntryId: opening.journalEntryId, accountCode: line.account, amountMinor: line.amountMinor, partyId: line.partyId })));
  }

  async findAdjustmentByOperationId(tx: Tx, ctx: TenantContext, operationId: string): Promise<StockAdjustmentRecord | null> {
    const db = txOf(tx);
    const rows = await db.select({
      id: stockAdjustments.id, number: stockAdjustments.adjustmentNumber, operationId: stockAdjustments.operationId,
      productId: stockAdjustments.productId, productName: products.name, locationId: stockAdjustments.locationId,
      locationName: inventoryLocations.name, qtyDelta: stockAdjustments.qtyDelta, direction: stockAdjustments.direction,
      qty: stockAdjustments.qty, valueMinor: stockAdjustments.valueMinor, reason: stockAdjustments.reason,
      note: stockAdjustments.note, businessDate: stockAdjustments.businessDate, entryMode: stockAdjustments.entryMode,
    }).from(stockAdjustments)
      .innerJoin(products, and(eq(products.tenantId, ctx.tenantId), eq(products.id, stockAdjustments.productId)))
      .innerJoin(inventoryLocations, and(eq(inventoryLocations.tenantId, ctx.tenantId), eq(inventoryLocations.id, stockAdjustments.locationId)))
      .where(and(eq(stockAdjustments.tenantId, ctx.tenantId), eq(stockAdjustments.operationId, operationId), isNull(stockAdjustments.deletedAt)))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return null;

    // A replay only has to reproduce the response, so the ids of what was
    // written are read back rather than the whole posting being rebuilt.
    const [movements, state] = await Promise.all([
      db.select({ id: stockMovements.id }).from(stockMovements)
        .where(and(eq(stockMovements.tenantId, ctx.tenantId), eq(stockMovements.sourceDocumentId, row.id))).limit(1),
      db.select({ id: productCostState.id, qtyOnHand: productCostState.qtyOnHand, avgUnitCost: productCostState.avgUnitCost })
        .from(productCostState)
        .where(and(eq(productCostState.tenantId, ctx.tenantId), eq(productCostState.productId, row.productId), eq(productCostState.locationId, row.locationId), isNull(productCostState.deletedAt)))
        .limit(1),
    ]);

    return {
      id: row.id.trim(), number: row.number, operationId: row.operationId.trim(),
      productId: row.productId.trim(), productName: row.productName,
      locationId: row.locationId.trim(), locationName: row.locationName,
      qtyDelta: row.qtyDelta, direction: row.direction as 'IN' | 'OUT', qty: row.qty,
      valueMinor: row.valueMinor, reason: row.reason as StockAdjustmentReason, note: row.note,
      businessDate: row.businessDate, entryMode: row.entryMode as StockAdjustmentRecord['entryMode'],
      movementId: movements[0]?.id.trim() ?? '', journalEntryId: '', journalLines: [],
      newLot: null, consumptions: [],
      costState: {
        id: state[0]?.id.trim() ?? '', exists: state[0] !== undefined,
        avgUnitCost: state[0]?.avgUnitCost ?? 0, qtyOnHand: state[0]?.qtyOnHand ?? 0,
      },
    };
  }

  async insertAdjustment(tx: Tx, ctx: TenantContext, adjustment: StockAdjustmentRecord): Promise<void> {
    const db = txOf(tx);
    const now = this.clock.now();
    const owner = { tenantId: ctx.tenantId, createdAt: now, createdBy: ctx.userId };

    await db.insert(stockAdjustments).values({
      id: adjustment.id, tenantId: ctx.tenantId, adjustmentNumber: adjustment.number,
      productId: adjustment.productId, locationId: adjustment.locationId,
      qtyDelta: adjustment.qtyDelta, direction: adjustment.direction, qty: adjustment.qty,
      valueMinor: adjustment.valueMinor, reason: adjustment.reason, note: adjustment.note,
      businessDate: adjustment.businessDate, entryMode: adjustment.entryMode, status: 'POSTED',
      operationId: adjustment.operationId, createdAt: now, updatedAt: now,
      createdBy: ctx.userId, updatedBy: ctx.userId, version: 1,
    });

    if (adjustment.newLot !== null) {
      await db.insert(inventoryLots).values({
        id: adjustment.newLot.id, tenantId: ctx.tenantId, productId: adjustment.productId,
        locationId: adjustment.locationId, ownerType: 'OWNED', vendorPartyId: null, supplierPartyId: null,
        sourceDocumentType: 'STOCK_ADJUSTMENT', sourceDocumentId: adjustment.id, sourceNumber: adjustment.number,
        qtyReceived: adjustment.qty, qtyRemaining: adjustment.qty,
        purchaseUnitCost: adjustment.newLot.unitCost, landedCostTotal: 0, actualUnitCost: adjustment.newLot.unitCost,
        businessDate: adjustment.businessDate, expiryDate: null, status: 'OPEN',
        createdAt: now, updatedAt: now, createdBy: ctx.userId, updatedBy: ctx.userId, version: 1,
      });
    }

    await db.insert(stockMovements).values({
      id: adjustment.movementId, ...owner,
      productId: adjustment.productId, locationId: adjustment.locationId,
      // A multi-lot issue has no single lot; `lot_consumptions` carries the
      // split, which is what DR13.1 computes a lot's remaining quantity from.
      lotId: adjustment.newLot?.id ?? null,
      qty: adjustment.qty, direction: adjustment.direction, businessDate: adjustment.businessDate,
      sourceDocumentType: 'STOCK_ADJUSTMENT', sourceDocumentId: adjustment.id, sourceNumber: adjustment.number,
      unitCost: adjustment.newLot?.unitCost ?? null,
    });

    for (const consumption of adjustment.consumptions) {
      await db.insert(lotConsumptions).values({
        id: consumption.id, ...owner, movementId: adjustment.movementId, lotId: consumption.lotId,
        qty: consumption.qty, unitCostUsed: consumption.unitCostUsed,
        documentType: 'STOCK_ADJUSTMENT', documentId: adjustment.id,
        businessDate: adjustment.businessDate, supersededBy: null,
      });
      // DR13.11: a lot reaching zero is CLOSED and kept forever. The guard on
      // `qty_remaining` is what stops two concurrent issues from driving one lot
      // below zero — the loser updates no rows and the caller sees the shortage.
      await db.update(inventoryLots)
        .set({
          qtyRemaining: sql`${inventoryLots.qtyRemaining} - ${consumption.qty}`,
          status: consumption.closesLot ? 'CLOSED' : 'OPEN',
          updatedAt: now, updatedBy: ctx.userId, version: sql`${inventoryLots.version} + 1`,
        })
        .where(and(
          eq(inventoryLots.tenantId, ctx.tenantId),
          eq(inventoryLots.id, consumption.lotId),
          gte(inventoryLots.qtyRemaining, consumption.qty),
        ));
    }

    if (adjustment.costState.exists) {
      await db.update(productCostState)
        .set({
          avgUnitCost: adjustment.costState.avgUnitCost, qtyOnHand: adjustment.costState.qtyOnHand,
          lastRecomputedAt: now, updatedAt: now, updatedBy: ctx.userId,
          version: sql`${productCostState.version} + 1`,
        })
        .where(and(eq(productCostState.tenantId, ctx.tenantId), eq(productCostState.id, adjustment.costState.id)));
    } else {
      await db.insert(productCostState).values({
        id: adjustment.costState.id, tenantId: ctx.tenantId, productId: adjustment.productId,
        locationId: adjustment.locationId, avgUnitCost: adjustment.costState.avgUnitCost,
        qtyOnHand: adjustment.costState.qtyOnHand, lastRecomputedAt: now,
        createdAt: now, updatedAt: now, createdBy: ctx.userId, updatedBy: ctx.userId, version: 1,
      });
    }

    await db.insert(journalEntries).values({
      id: adjustment.journalEntryId, ...owner, businessDate: adjustment.businessDate,
      sourceDocumentType: 'STOCK_ADJUSTMENT', sourceDocumentId: adjustment.id,
      sourceNumber: adjustment.number, entryMode: adjustment.entryMode,
    });
    await db.insert(journalLines).values(adjustment.journalLines.map((line: StockAdjustmentRecord['journalLines'][number]) => ({
      id: line.id, ...owner, journalEntryId: adjustment.journalEntryId,
      accountCode: line.account as string, amountMinor: line.amountMinor, partyId: line.partyId,
    })));
  }

  async listAdjustments(tx: Tx, ctx: TenantContext, filter: StockAdjustmentFilter): Promise<readonly StockAdjustmentListRow[]> {
    const rows = await txOf(tx).select({
      id: stockAdjustments.id, number: stockAdjustments.adjustmentNumber,
      productId: stockAdjustments.productId, productName: products.name,
      locationName: inventoryLocations.name, qtyDelta: stockAdjustments.qtyDelta,
      direction: stockAdjustments.direction, qty: stockAdjustments.qty,
      valueMinor: stockAdjustments.valueMinor, reason: stockAdjustments.reason, note: stockAdjustments.note,
      businessDate: stockAdjustments.businessDate, createdAt: stockAdjustments.createdAt,
      createdByName: users.displayName,
    }).from(stockAdjustments)
      .innerJoin(products, and(eq(products.tenantId, ctx.tenantId), eq(products.id, stockAdjustments.productId)))
      .innerJoin(inventoryLocations, and(eq(inventoryLocations.tenantId, ctx.tenantId), eq(inventoryLocations.id, stockAdjustments.locationId)))
      .innerJoin(users, and(eq(users.tenantId, ctx.tenantId), eq(users.id, stockAdjustments.createdBy)))
      .where(and(
        eq(stockAdjustments.tenantId, ctx.tenantId),
        isNull(stockAdjustments.deletedAt),
        ...dateRange(stockAdjustments.businessDate, filter),
        ...(filter.productId === null ? [] : [eq(stockAdjustments.productId, filter.productId)]),
      ))
      .orderBy(desc(stockAdjustments.businessDate), desc(stockAdjustments.createdAt), desc(stockAdjustments.id))
      .limit(filter.limit);
    return rows.map((row) => ({
      ...row, id: row.id.trim(), productId: row.productId.trim(),
      direction: row.direction as 'IN' | 'OUT', reason: row.reason as StockAdjustmentReason,
    }));
  }

  async listCostAdjustments(tx: Tx, ctx: TenantContext, filter: StockAdjustmentFilter): Promise<readonly CostAdjustmentListRow[]> {
    const rows = await txOf(tx).select({
      id: costAdjustments.id, productId: costAdjustments.productId, productName: products.name,
      reason: costAdjustments.reason, documentRef: costAdjustments.documentRef,
      amountMinor: costAdjustments.amountMinor, businessDate: costAdjustments.businessDate,
    }).from(costAdjustments)
      .innerJoin(products, and(eq(products.tenantId, ctx.tenantId), eq(products.id, costAdjustments.productId)))
      .where(and(
        eq(costAdjustments.tenantId, ctx.tenantId),
        ...dateRange(costAdjustments.businessDate, filter),
        ...(filter.productId === null ? [] : [eq(costAdjustments.productId, filter.productId)]),
      ))
      .orderBy(desc(costAdjustments.businessDate), desc(costAdjustments.createdAt), desc(costAdjustments.id))
      .limit(filter.limit);
    return rows.map((row) => ({
      ...row, id: row.id.trim(), productId: row.productId.trim(),
      reason: row.reason as CostAdjustmentListRow['reason'],
    }));
  }

  async findStockPosition(tx: Tx, ctx: TenantContext, productId: string): Promise<ProductStockPosition | null> {
    const rows = await txOf(tx).select({
      costStateId: productCostState.id, locationId: productCostState.locationId,
      locationName: inventoryLocations.name, qtyOnHand: productCostState.qtyOnHand,
      avgUnitCost: productCostState.avgUnitCost,
    }).from(productCostState)
      .innerJoin(inventoryLocations, and(eq(inventoryLocations.tenantId, ctx.tenantId), eq(inventoryLocations.id, productCostState.locationId), isNull(inventoryLocations.deletedAt)))
      .where(and(eq(productCostState.tenantId, ctx.tenantId), eq(productCostState.productId, productId), isNull(productCostState.deletedAt)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : {
      costStateId: row.costStateId.trim(), locationId: row.locationId.trim(),
      locationName: row.locationName, qtyOnHand: row.qtyOnHand, avgUnitCost: row.avgUnitCost,
    };
  }

  async listCostLayers(tx: Tx, ctx: TenantContext, productId: string, locationId: string): Promise<readonly StockCostLayerRow[]> {
    const rows = await txOf(tx).select({
      id: inventoryLots.id, qtyRemaining: inventoryLots.qtyRemaining,
      unitCost: inventoryLots.actualUnitCost, businessDate: inventoryLots.businessDate,
      createdAt: inventoryLots.createdAt, expiryDate: inventoryLots.expiryDate,
    }).from(inventoryLots)
      .where(and(
        eq(inventoryLots.tenantId, ctx.tenantId),
        eq(inventoryLots.productId, productId),
        eq(inventoryLots.locationId, locationId),
        // DR13.10: vendor-owned stock is not the shop's to write off.
        eq(inventoryLots.ownerType, 'OWNED'),
        eq(inventoryLots.status, 'OPEN'),
        isNull(inventoryLots.deletedAt),
      ))
      .orderBy(asc(inventoryLots.businessDate), asc(inventoryLots.createdAt), asc(inventoryLots.id));
    return rows.map((row) => ({
      ...row, id: row.id.trim(), createdAt: row.createdAt.toISOString(),
    }));
  }

  async productHasStockHistory(tx: Tx, ctx: TenantContext, productId: string): Promise<boolean> {
    const db = txOf(tx);
    // Movements are the whole answer: every lot, opening, adjustment, purchase
    // and sale writes one, so a product with none has never been stocked.
    const rows = await db.select({ id: stockMovements.id }).from(stockMovements)
      .where(and(eq(stockMovements.tenantId, ctx.tenantId), eq(stockMovements.productId, productId)))
      .limit(1);
    return rows.length > 0;
  }

  async listStock(tx: Tx, ctx: TenantContext): Promise<readonly InventoryStockRow[]> {
    const rows = await txOf(tx).select({ productId: products.id, productName: products.name, productStatus: products.status, baseUnitName: units.name, tracksExpiry: products.tracksExpiry, locationId: inventoryLocations.id, locationName: inventoryLocations.name, qtyOnHand: productCostState.qtyOnHand, minStockQty: products.minStockQty, avgUnitCost: productCostState.avgUnitCost })
      .from(products)
      .innerJoin(units, and(eq(units.tenantId, ctx.tenantId), eq(units.id, products.baseUnitId)))
      .leftJoin(productCostState, and(eq(productCostState.tenantId, ctx.tenantId), eq(productCostState.productId, products.id), isNull(productCostState.deletedAt)))
      .leftJoin(inventoryLocations, and(eq(inventoryLocations.tenantId, ctx.tenantId), eq(inventoryLocations.id, productCostState.locationId), isNull(inventoryLocations.deletedAt)))
      .where(and(eq(products.tenantId, ctx.tenantId), isNull(products.deletedAt))).orderBy(products.name, products.id);
    return rows.map((row) => ({
      ...row,
      productId: row.productId.trim(),
      locationId: row.locationId?.trim() ?? null,
      locationName: row.locationName ?? null,
      qtyOnHand: row.qtyOnHand ?? 0,
      avgUnitCost: row.avgUnitCost ?? 0,
      productStatus: row.productStatus as 'ACTIVE' | 'INACTIVE',
    }));
  }

  async listMovements(tx: Tx, ctx: TenantContext, filter: StockAdjustmentFilter): Promise<readonly InventoryMovementRow[]> {
    const rows = await txOf(tx).select({ id: stockMovements.id, productId: stockMovements.productId, productName: products.name, locationName: inventoryLocations.name, lotId: stockMovements.lotId, qty: stockMovements.qty, direction: stockMovements.direction, sourceType: stockMovements.sourceDocumentType, sourceId: stockMovements.sourceDocumentId, sourceNumber: stockMovements.sourceNumber, businessDate: stockMovements.businessDate, createdAt: stockMovements.createdAt, unitCost: stockMovements.unitCost })
      .from(stockMovements).innerJoin(products, and(eq(products.tenantId, ctx.tenantId), eq(products.id, stockMovements.productId)))
      .innerJoin(inventoryLocations, and(eq(inventoryLocations.tenantId, ctx.tenantId), eq(inventoryLocations.id, stockMovements.locationId)))
      .where(and(
        eq(stockMovements.tenantId, ctx.tenantId),
        ...dateRange(stockMovements.businessDate, filter),
        ...(filter.productId === null ? [] : [eq(stockMovements.productId, filter.productId)]),
      ))
      .orderBy(desc(stockMovements.businessDate), desc(stockMovements.createdAt), desc(stockMovements.id)).limit(filter.limit);
    return rows.map((row) => ({ ...row, id: row.id.trim(), productId: row.productId.trim(), lotId: row.lotId?.trim() ?? null, sourceId: row.sourceId.trim(), direction: row.direction as 'IN' | 'OUT', unitCost: row.unitCost ?? 0 }));
  }

  async listLots(tx: Tx, ctx: TenantContext, filter: InventoryLotFilter): Promise<readonly InventoryLotRow[]> {
    const column = LOT_SORTS[filter.sort];
    const conditions = [
      eq(inventoryLots.tenantId, ctx.tenantId),
      ...(filter.productId === null ? [] : [eq(inventoryLots.productId, filter.productId)]),
      ...(filter.expiringOnly ? [isNotNull(inventoryLots.expiryDate)] : []),
      isNull(inventoryLots.deletedAt),
      ...(filter.status === null ? [] : [eq(inventoryLots.status, filter.status)]),
      ...(filter.cursor === null ? [] : [afterCursor(
        column,
        filter.direction,
        sql`${inventoryLots.id}`,
        sql`anchor.id`,
        sql`inventory_lots anchor`,
        sql`anchor.tenant_id = ${ctx.tenantId} AND anchor.id = ${filter.cursor} AND anchor.deleted_at IS NULL`,
      )]),
    ];
    const rows = await txOf(tx).select({
      id: inventoryLots.id,
      productId: inventoryLots.productId,
      productName: products.name,
      locationId: inventoryLots.locationId,
      locationName: inventoryLocations.name,
      ownerType: inventoryLots.ownerType,
      sourceType: inventoryLots.sourceDocumentType,
      sourceId: inventoryLots.sourceDocumentId,
      sourceNumber: inventoryLots.sourceNumber,
      qtyReceived: inventoryLots.qtyReceived,
      qtyRemaining: inventoryLots.qtyRemaining,
      purchaseUnitCost: inventoryLots.purchaseUnitCost,
      landedCostTotal: inventoryLots.landedCostTotal,
      actualUnitCost: inventoryLots.actualUnitCost,
      businessDate: inventoryLots.businessDate,
      expiryDate: inventoryLots.expiryDate,
      status: inventoryLots.status,
    }).from(inventoryLots)
      .innerJoin(products, and(eq(products.tenantId, ctx.tenantId), eq(products.id, inventoryLots.productId)))
      .innerJoin(inventoryLocations, and(eq(inventoryLocations.tenantId, ctx.tenantId), eq(inventoryLocations.id, inventoryLots.locationId)))
      .where(and(...conditions))
      .orderBy(orderBy(column, filter.direction, sql`${inventoryLots.id}`))
      .limit(filter.limit);

    return rows.map((row) => ({
      ...row,
      id: row.id.trim(),
      productId: row.productId.trim(),
      locationId: row.locationId.trim(),
      sourceId: row.sourceId.trim(),
      ownerType: row.ownerType as 'OWNED' | 'VENDOR',
      status: row.status as 'OPEN' | 'CLOSED',
    }));
  }

  async listValuationLots(tx: Tx, ctx: TenantContext): Promise<readonly InventoryValuationLotRow[]> {
    const rows = await txOf(tx).select({
      productId: inventoryLots.productId,
      locationId: inventoryLots.locationId,
      qtyRemaining: inventoryLots.qtyRemaining,
      actualUnitCost: inventoryLots.actualUnitCost,
    }).from(inventoryLots).where(and(
      eq(inventoryLots.tenantId, ctx.tenantId),
      eq(inventoryLots.ownerType, 'OWNED'),
      isNull(inventoryLots.deletedAt),
    ));
    return rows.map((row) => ({
      ...row,
      productId: row.productId.trim(),
      locationId: row.locationId.trim(),
    }));
  }

  async listCostStates(tx: Tx, ctx: TenantContext): Promise<readonly InventoryCostStateRow[]> {
    const rows = await txOf(tx).select({
      productId: productCostState.productId,
      productName: products.name,
      locationId: productCostState.locationId,
      locationName: inventoryLocations.name,
      qtyOnHand: productCostState.qtyOnHand,
      avgUnitCost: productCostState.avgUnitCost,
    }).from(productCostState)
      .innerJoin(products, and(eq(products.tenantId, ctx.tenantId), eq(products.id, productCostState.productId), isNull(products.deletedAt)))
      .innerJoin(inventoryLocations, and(eq(inventoryLocations.tenantId, ctx.tenantId), eq(inventoryLocations.id, productCostState.locationId), isNull(inventoryLocations.deletedAt)))
      .where(and(eq(productCostState.tenantId, ctx.tenantId), isNull(productCostState.deletedAt)))
      .orderBy(products.name, productCostState.productId, productCostState.locationId);
    return rows.map((row) => ({
      ...row,
      productId: row.productId.trim(),
      locationId: row.locationId.trim(),
    }));
  }

  async listInventoryJournalAmounts(tx: Tx, ctx: TenantContext): Promise<readonly number[]> {
    const rows = await txOf(tx).select({ amountMinor: journalLines.amountMinor })
      .from(journalLines)
      .where(and(eq(journalLines.tenantId, ctx.tenantId), eq(journalLines.accountCode, 'INVENTORY')));
    return rows.map((row) => row.amountMinor);
  }
}
