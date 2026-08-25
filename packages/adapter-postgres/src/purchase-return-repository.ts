import type {
  NewPurchaseReturn,
  PurchaseReturnFilter,
  PurchaseReturnRepository,
  PurchaseReturnRow,
  ReturnableBillRow,
  TenantContext,
  Tx,
} from '@sher/core-application';
import type { Clock } from '@sher/shared-utils';
import { and, asc, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';

import {
  accounts,
  inventoryLots,
  journalEntries,
  journalLines,
  parties,
  productCostState,
  products,
  purchaseLines,
  purchaseReturnLines,
  purchaseReturns,
  purchases,
  stockMovements,
  units,
} from './schema';
import { txOf } from './unit-of-work';

/**
 * Purchase returns over PostgreSQL. No business rule lives here (R-B6).
 *
 * Two computed caps, neither stored: what a bill line still has un-returned
 * (`Σ purchase_return_lines.qty`) and what its lot still holds. The second is
 * read straight off `inventory_lots.qty_remaining` — the same number every stock
 * screen reads, so "already sold" means the same thing everywhere.
 */
function returnedQty(purchaseLineId: SQL): SQL<number> {
  return sql<number>`COALESCE((
    SELECT SUM(prl.qty)
      FROM purchase_return_lines prl
      JOIN purchase_returns pr ON pr.id = prl.return_id
     WHERE prl.purchase_line_id = ${purchaseLineId}
       AND pr.status = 'POSTED'
       AND pr.deleted_at IS NULL
  ), 0)::bigint`;
}

/**
 * What a bill still owes, with returns taken off — the same expression
 * `purchase-repository` uses, plus the credit a return put against it.
 */
const BILL_OUTSTANDING_MINOR = sql<number>`(
  ${purchases.grandTotalMinor} - ${purchases.paidMinor}
  - COALESCE((SELECT SUM(pa.amount_minor) FROM payment_allocations pa WHERE pa.purchase_id = ${purchases.id}), 0)
  - COALESCE((
      SELECT SUM(pr.settled_minor) FROM purchase_returns pr
       WHERE pr.purchase_id = ${purchases.id} AND pr.status = 'POSTED' AND pr.deleted_at IS NULL
    ), 0)
)::bigint`;

export class PostgresPurchaseReturnRepository implements PurchaseReturnRepository {
  constructor(private readonly clock: Clock) {}

  async findReturnableBill(
    tx: Tx,
    ctx: TenantContext,
    purchaseId: string,
  ): Promise<ReturnableBillRow | null> {
    const db = txOf(tx);

    const heads = await db
      .select({
        id: purchases.id,
        number: purchases.purchaseNumber,
        businessDate: purchases.businessDate,
        status: purchases.status,
        supplierPartyId: purchases.supplierPartyId,
        supplierName: parties.name,
        locationId: purchases.locationId,
        grandTotalMinor: purchases.grandTotalMinor,
        outstandingMinor: BILL_OUTSTANDING_MINOR,
      })
      .from(purchases)
      .innerJoin(parties, eq(parties.id, purchases.supplierPartyId))
      .where(
        and(
          eq(purchases.tenantId, ctx.tenantId),
          eq(purchases.id, purchaseId),
          isNull(purchases.deletedAt),
        ),
      )
      .limit(1);

    const head = heads[0];
    if (head === undefined) return null;

    const lines = await db
      .select({
        purchaseLineId: purchaseLines.id,
        productId: purchaseLines.productId,
        productName: products.name,
        unitName: units.name,
        lotId: purchaseLines.lotId,
        locationId: purchases.locationId,
        qtyReceived: purchaseLines.qty,
        qtyReturned: returnedQty(sql`${purchaseLines.id}`),
        qtyRemainingInLot: inventoryLots.qtyRemaining,
        lineTotalMinor: purchaseLines.lineTotalMinor,
        discountShareMinor: purchaseLines.discountShareMinor,
        actualUnitCost: purchaseLines.actualUnitCost,
      })
      .from(purchaseLines)
      .innerJoin(purchases, eq(purchases.id, purchaseLines.purchaseId))
      .innerJoin(products, eq(products.id, purchaseLines.productId))
      .innerJoin(units, eq(units.id, products.baseUnitId))
      .innerJoin(inventoryLots, eq(inventoryLots.id, purchaseLines.lotId))
      .where(
        and(eq(purchaseLines.tenantId, ctx.tenantId), eq(purchaseLines.purchaseId, purchaseId)),
      )
      .orderBy(asc(purchaseLines.lineNo));

    return {
      purchaseId: head.id.trim(),
      number: head.number,
      businessDate: head.businessDate,
      status: head.status,
      supplierPartyId: head.supplierPartyId.trim(),
      supplierName: head.supplierName,
      locationId: head.locationId.trim(),
      grandTotalMinor: Number(head.grandTotalMinor),
      outstandingMinor: Number(head.outstandingMinor),
      lines: lines.map((line) => ({
        purchaseLineId: line.purchaseLineId.trim(),
        productId: line.productId.trim(),
        productName: line.productName,
        unitName: line.unitName,
        lotId: line.lotId.trim(),
        locationId: line.locationId.trim(),
        qtyReceived: Number(line.qtyReceived),
        qtyReturned: Number(line.qtyReturned),
        qtyRemainingInLot: Number(line.qtyRemainingInLot),
        /*
         * What the supplier actually charged for the line: its total less the
         * bill discount spread onto it. The extra cost is deliberately not
         * here — the shop paid the van, not the supplier, and asking for it
         * back would be asking for money nobody received.
         */
        billedNetMinor: Number(line.lineTotalMinor) - Number(line.discountShareMinor),
        actualUnitCost: Number(line.actualUnitCost),
      })),
    };
  }

  async postPurchaseReturn(tx: Tx, ctx: TenantContext, draft: NewPurchaseReturn): Promise<void> {
    const db = txOf(tx);
    const now = this.clock.now();

    await db.insert(purchaseReturns).values({
      id: draft.id,
      tenantId: ctx.tenantId,
      returnNumber: draft.number,
      purchaseId: draft.purchaseId,
      supplierPartyId: draft.supplierPartyId,
      supplierNameSnapshot: draft.supplierName,
      locationId: draft.locationId,
      reason: draft.reason,
      note: draft.note,
      returnValueMinor: draft.returnValueMinor,
      inventoryMinor: draft.inventoryMinor,
      receivedMinor: draft.receivedMinor,
      creditMinor: draft.creditMinor,
      settledMinor: draft.settledMinor,
      receiptAccountCode: draft.receiptAccountCode,
      businessDate: draft.businessDate,
      entryMode: draft.entryMode,
      backdateReason: draft.backdateReason,
      status: 'POSTED',
      operationId: draft.operationId,
      createdAt: now,
      updatedAt: now,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
      version: 1,
    });

    for (const line of draft.lines) {
      await db.insert(stockMovements).values({
        id: line.movementId,
        tenantId: ctx.tenantId,
        createdAt: now,
        createdBy: ctx.userId,
        productId: line.productId,
        locationId: line.locationId,
        // The lot is named on the movement: goods go back out of the one they
        // came in on, which is what makes this reversible line by line.
        lotId: line.lotId,
        qty: line.qty,
        direction: 'OUT',
        businessDate: draft.businessDate,
        sourceDocumentType: 'PURCHASE_RETURN',
        sourceDocumentId: draft.id,
        sourceNumber: draft.number,
        // Taka at scale 4, matching what the purchase wrote onto this lot.
        unitCost: line.qty === 0 ? 0 : Math.round((line.costMinor * 100_000) / line.qty),
      });

      await db
        .update(inventoryLots)
        .set({
          qtyRemaining: sql`${inventoryLots.qtyRemaining} - ${line.qty}`,
          // A lot emptied by the return closes; the service has already refused
          // any quantity larger than what it holds, so this cannot go negative.
          status: sql`CASE WHEN ${inventoryLots.qtyRemaining} - ${line.qty} <= 0 THEN 'CLOSED' ELSE 'OPEN' END`,
          updatedAt: now,
          updatedBy: ctx.userId,
          version: sql`${inventoryLots.version} + 1`,
        })
        .where(and(eq(inventoryLots.tenantId, ctx.tenantId), eq(inventoryLots.id, line.lotId)));

      await db.insert(purchaseReturnLines).values({
        id: line.id,
        tenantId: ctx.tenantId,
        returnId: draft.id,
        lineNo: line.lineNo,
        purchaseLineId: line.purchaseLineId,
        productId: line.productId,
        lotId: line.lotId,
        qty: line.qty,
        valueMinor: line.valueMinor,
        costMinor: line.costMinor,
        movementId: line.movementId,
        createdAt: now,
        createdBy: ctx.userId,
      });
    }

    for (const state of draft.costStates) {
      if (state.exists) {
        await db
          .update(productCostState)
          .set({
            qtyOnHand: state.qtyOnHand,
            avgUnitCost: state.avgUnitCost,
            lastRecomputedAt: now,
            updatedAt: now,
            updatedBy: ctx.userId,
            version: sql`${productCostState.version} + 1`,
          })
          .where(and(eq(productCostState.tenantId, ctx.tenantId), eq(productCostState.id, state.id)));
      } else {
        await db.insert(productCostState).values({
          id: state.id,
          tenantId: ctx.tenantId,
          productId: state.productId,
          locationId: state.locationId,
          avgUnitCost: state.avgUnitCost,
          qtyOnHand: state.qtyOnHand,
          lastRecomputedAt: now,
          createdAt: now,
          updatedAt: now,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
          version: 1,
        });
      }
    }

    await db.insert(journalEntries).values({
      id: draft.journalEntryId,
      tenantId: ctx.tenantId,
      createdAt: now,
      createdBy: ctx.userId,
      businessDate: draft.businessDate,
      sourceDocumentType: 'PURCHASE_RETURN',
      sourceDocumentId: draft.id,
      sourceNumber: draft.number,
      entryMode: draft.entryMode,
    });

    for (const line of draft.journalLines) {
      await db.insert(journalLines).values({
        id: line.id,
        tenantId: ctx.tenantId,
        createdAt: now,
        createdBy: ctx.userId,
        journalEntryId: draft.journalEntryId,
        accountCode: line.account,
        amountMinor: line.amountMinor,
        partyId: line.partyId,
      });
    }
  }

  async findReturnById(
    tx: Tx,
    ctx: TenantContext,
    returnId: string,
  ): Promise<PurchaseReturnRow | null> {
    const page = await this.readReturns(tx, ctx, [eq(purchaseReturns.id, returnId)], 1);
    return page[0] ?? null;
  }

  async findReturnIdByOperationId(
    tx: Tx,
    ctx: TenantContext,
    operationId: string,
  ): Promise<string | null> {
    const rows = await txOf(tx)
      .select({ id: purchaseReturns.id })
      .from(purchaseReturns)
      .where(
        and(
          eq(purchaseReturns.tenantId, ctx.tenantId),
          eq(purchaseReturns.operationId, operationId),
        ),
      )
      .limit(1);
    return rows[0]?.id.trim() ?? null;
  }

  async listReturns(
    tx: Tx,
    ctx: TenantContext,
    filter: PurchaseReturnFilter,
  ): Promise<{
    readonly returns: readonly PurchaseReturnRow[];
    readonly nextCursor: string | null;
    readonly totalValueMinor: number;
    readonly totalReceivedMinor: number;
  }> {
    const conditions: SQL[] = [];
    if (filter.supplierPartyId !== null) {
      conditions.push(eq(purchaseReturns.supplierPartyId, filter.supplierPartyId));
    }
    if (filter.fromDate !== null) {
      conditions.push(sql`${purchaseReturns.businessDate} >= ${filter.fromDate}`);
    }
    if (filter.toDate !== null) {
      conditions.push(sql`${purchaseReturns.businessDate} <= ${filter.toDate}`);
    }
    if (filter.search !== null && filter.search.trim() !== '') {
      const term = `%${filter.search.trim().toLowerCase()}%`;
      conditions.push(
        sql`(LOWER(${purchaseReturns.returnNumber}) LIKE ${term}
          OR LOWER(${purchaseReturns.supplierNameSnapshot}) LIKE ${term})`,
      );
    }
    if (filter.cursor !== null) conditions.push(lt(purchaseReturns.id, filter.cursor));

    const totals = await txOf(tx)
      .select({
        value: sql<number>`COALESCE(SUM(${purchaseReturns.returnValueMinor}), 0)::bigint`,
        received: sql<number>`COALESCE(SUM(${purchaseReturns.receivedMinor}), 0)::bigint`,
      })
      .from(purchaseReturns)
      .where(
        and(
          eq(purchaseReturns.tenantId, ctx.tenantId),
          eq(purchaseReturns.status, 'POSTED'),
          isNull(purchaseReturns.deletedAt),
          ...conditions,
        ),
      );

    const rows = await this.readReturns(tx, ctx, conditions, filter.limit + 1);
    const hasMore = rows.length > filter.limit;
    const page = hasMore ? rows.slice(0, filter.limit) : rows;

    return {
      returns: page,
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
      totalValueMinor: Number(totals[0]?.value ?? 0),
      totalReceivedMinor: Number(totals[0]?.received ?? 0),
    };
  }

  /** One reader for the detail and the list, so both say the same thing. */
  private async readReturns(
    tx: Tx,
    ctx: TenantContext,
    conditions: readonly SQL[],
    limit: number,
  ): Promise<readonly PurchaseReturnRow[]> {
    const db = txOf(tx);

    const heads = await db
      .select({
        id: purchaseReturns.id,
        number: purchaseReturns.returnNumber,
        purchaseId: purchaseReturns.purchaseId,
        purchaseNumber: purchases.purchaseNumber,
        supplierPartyId: purchaseReturns.supplierPartyId,
        supplierName: purchaseReturns.supplierNameSnapshot,
        businessDate: purchaseReturns.businessDate,
        reason: purchaseReturns.reason,
        note: purchaseReturns.note,
        returnValueMinor: purchaseReturns.returnValueMinor,
        receivedMinor: purchaseReturns.receivedMinor,
        creditMinor: purchaseReturns.creditMinor,
        receiptAccountCode: purchaseReturns.receiptAccountCode,
        receiptAccountName: accounts.name,
        createdAt: purchaseReturns.createdAt,
      })
      .from(purchaseReturns)
      .innerJoin(purchases, eq(purchases.id, purchaseReturns.purchaseId))
      .leftJoin(
        accounts,
        sql`${accounts.id} = SUBSTRING(${purchaseReturns.receiptAccountCode} FROM POSITION(':' IN ${purchaseReturns.receiptAccountCode}) + 1)`,
      )
      .where(
        and(
          eq(purchaseReturns.tenantId, ctx.tenantId),
          isNull(purchaseReturns.deletedAt),
          ...conditions,
        ),
      )
      .orderBy(desc(purchaseReturns.businessDate), desc(purchaseReturns.id))
      .limit(limit);

    if (heads.length === 0) return [];

    const ids = heads.map((head) => head.id.trim());
    const lines = await db
      .select({
        id: purchaseReturnLines.id,
        returnId: purchaseReturnLines.returnId,
        purchaseLineId: purchaseReturnLines.purchaseLineId,
        productId: purchaseReturnLines.productId,
        productName: products.name,
        unitName: units.name,
        qty: purchaseReturnLines.qty,
        valueMinor: purchaseReturnLines.valueMinor,
      })
      .from(purchaseReturnLines)
      .innerJoin(products, eq(products.id, purchaseReturnLines.productId))
      .innerJoin(units, eq(units.id, products.baseUnitId))
      .where(
        and(
          eq(purchaseReturnLines.tenantId, ctx.tenantId),
          inArray(purchaseReturnLines.returnId, ids),
        ),
      )
      .orderBy(asc(purchaseReturnLines.lineNo));

    return heads.map((head) => ({
      id: head.id.trim(),
      number: head.number,
      purchaseId: head.purchaseId.trim(),
      purchaseNumber: head.purchaseNumber,
      supplierPartyId: head.supplierPartyId.trim(),
      supplierName: head.supplierName,
      businessDate: head.businessDate,
      reason: head.reason,
      note: head.note,
      returnValueMinor: Number(head.returnValueMinor),
      receivedMinor: Number(head.receivedMinor),
      creditMinor: Number(head.creditMinor),
      receiptAccountCode: head.receiptAccountCode,
      receiptAccountName: head.receiptAccountName,
      createdAt: head.createdAt,
      lines: lines
        .filter((line) => line.returnId.trim() === head.id.trim())
        .map((line) => ({
          id: line.id.trim(),
          purchaseLineId: line.purchaseLineId.trim(),
          productId: line.productId.trim(),
          productName: line.productName,
          unitName: line.unitName,
          qty: Number(line.qty),
          valueMinor: Number(line.valueMinor),
        })),
    }));
  }
}
