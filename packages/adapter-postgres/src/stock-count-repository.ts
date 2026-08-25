import type {
  NewStockCount,
  StockCountRepository,
  StockCountRow,
  TenantContext,
  Tx,
} from '@sher/core-application';
import type { Clock } from '@sher/shared-utils';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';

import { products, stockCountLines, stockCounts, units } from './schema';
import { txOf } from './unit-of-work';

/**
 * Count sheets over PostgreSQL. No business rule lives here (R-B6), and no
 * stock either: the differences were posted as stock adjustments by the use
 * case that owns stock movement, and each line points at the one it made.
 */
export class PostgresStockCountRepository implements StockCountRepository {
  constructor(private readonly clock: Clock) {}

  async insertCount(tx: Tx, ctx: TenantContext, count: NewStockCount): Promise<void> {
    const db = txOf(tx);
    const now = this.clock.now();

    await db.insert(stockCounts).values({
      id: count.id,
      tenantId: ctx.tenantId,
      countNumber: count.number,
      locationId: count.locationId,
      scopeLabel: count.scopeLabel,
      note: count.note,
      lineCount: count.lineCount,
      differenceCount: count.differenceCount,
      shortageValueMinor: count.shortageValueMinor,
      surplusValueMinor: count.surplusValueMinor,
      businessDate: count.businessDate,
      entryMode: count.entryMode,
      backdateReason: count.backdateReason,
      status: 'POSTED',
      operationId: count.operationId,
      createdAt: now,
      updatedAt: now,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
      version: 1,
    });

    for (const line of count.lines) {
      await db.insert(stockCountLines).values({
        id: line.id,
        tenantId: ctx.tenantId,
        countId: count.id,
        lineNo: line.lineNo,
        productId: line.productId,
        countedQty: line.countedQty,
        systemQty: line.systemQty,
        postedSystemQty: line.postedSystemQty,
        qtyDelta: line.qtyDelta,
        valueMinor: line.valueMinor,
        adjustmentId: line.adjustmentId,
        createdAt: now,
        createdBy: ctx.userId,
      });
    }
  }

  async findCountById(
    tx: Tx,
    ctx: TenantContext,
    countId: string,
  ): Promise<StockCountRow | null> {
    const rows = await this.read(tx, ctx, [eq(stockCounts.id, countId)], 1);
    return rows[0] ?? null;
  }

  async findCountIdByOperationId(
    tx: Tx,
    ctx: TenantContext,
    operationId: string,
  ): Promise<string | null> {
    const rows = await txOf(tx)
      .select({ id: stockCounts.id })
      .from(stockCounts)
      .where(and(eq(stockCounts.tenantId, ctx.tenantId), eq(stockCounts.operationId, operationId)))
      .limit(1);
    return rows[0]?.id.trim() ?? null;
  }

  async listCounts(tx: Tx, ctx: TenantContext, limit: number): Promise<readonly StockCountRow[]> {
    return this.read(tx, ctx, [], limit);
  }

  private async read(
    tx: Tx,
    ctx: TenantContext,
    conditions: readonly SQL[],
    limit: number,
  ): Promise<readonly StockCountRow[]> {
    const db = txOf(tx);

    const heads = await db
      .select({
        id: stockCounts.id,
        number: stockCounts.countNumber,
        scopeLabel: stockCounts.scopeLabel,
        note: stockCounts.note,
        businessDate: stockCounts.businessDate,
        lineCount: stockCounts.lineCount,
        differenceCount: stockCounts.differenceCount,
        shortageValueMinor: stockCounts.shortageValueMinor,
        surplusValueMinor: stockCounts.surplusValueMinor,
        createdAt: stockCounts.createdAt,
      })
      .from(stockCounts)
      .where(and(eq(stockCounts.tenantId, ctx.tenantId), isNull(stockCounts.deletedAt), ...conditions))
      .orderBy(desc(stockCounts.businessDate), desc(stockCounts.id))
      .limit(limit);

    if (heads.length === 0) return [];

    const ids = heads.map((head) => head.id.trim());
    const lines = await db
      .select({
        id: stockCountLines.id,
        countId: stockCountLines.countId,
        productId: stockCountLines.productId,
        productName: products.name,
        unitName: units.name,
        countedQty: stockCountLines.countedQty,
        systemQty: stockCountLines.systemQty,
        postedSystemQty: stockCountLines.postedSystemQty,
        qtyDelta: stockCountLines.qtyDelta,
        valueMinor: stockCountLines.valueMinor,
      })
      .from(stockCountLines)
      .innerJoin(products, eq(products.id, stockCountLines.productId))
      .innerJoin(units, eq(units.id, products.baseUnitId))
      .where(and(eq(stockCountLines.tenantId, ctx.tenantId), inArray(stockCountLines.countId, ids)))
      .orderBy(asc(stockCountLines.lineNo));

    return heads.map((head) => ({
      id: head.id.trim(),
      number: head.number,
      scopeLabel: head.scopeLabel,
      note: head.note,
      businessDate: head.businessDate,
      lineCount: head.lineCount,
      differenceCount: head.differenceCount,
      shortageValueMinor: Number(head.shortageValueMinor),
      surplusValueMinor: Number(head.surplusValueMinor),
      createdAt: head.createdAt,
      lines: lines
        .filter((line) => line.countId.trim() === head.id.trim())
        .map((line) => ({
          id: line.id.trim(),
          productId: line.productId.trim(),
          productName: line.productName,
          unitName: line.unitName,
          countedQty: Number(line.countedQty),
          systemQty: Number(line.systemQty),
          postedSystemQty: Number(line.postedSystemQty),
          qtyDelta: Number(line.qtyDelta),
          valueMinor: Number(line.valueMinor),
        })),
    }));
  }
}
