import type { TenantContext } from '../ports/tenant-context';
import type { Tx } from '../ports/unit-of-work';

/**
 * The count sheet as a document (§5.13).
 *
 * The stock itself is not written here — every difference is a stock adjustment
 * posted through the use case that owns stock movement, and `adjustmentId` on a
 * line points at it. This table records what was counted and what the sheet
 * concluded, which is the part a second count needs.
 */

export interface NewStockCountLine {
  readonly id: string;
  readonly lineNo: number;
  readonly productId: string;
  readonly countedQty: number;
  readonly systemQty: number;
  readonly postedSystemQty: number;
  readonly qtyDelta: number;
  readonly valueMinor: number;
  readonly adjustmentId: string | null;
}

export interface NewStockCount {
  readonly id: string;
  readonly number: string;
  readonly locationId: string;
  readonly scopeLabel: string;
  readonly note: string | null;
  readonly lineCount: number;
  readonly differenceCount: number;
  readonly shortageValueMinor: number;
  readonly surplusValueMinor: number;
  readonly businessDate: string;
  readonly entryMode: string;
  readonly backdateReason: string | null;
  readonly operationId: string;
  readonly lines: readonly NewStockCountLine[];
}

export interface StockCountLineRow {
  readonly id: string;
  readonly productId: string;
  readonly productName: string;
  readonly unitName: string;
  readonly countedQty: number;
  readonly systemQty: number;
  readonly postedSystemQty: number;
  readonly qtyDelta: number;
  readonly valueMinor: number;
}

export interface StockCountRow {
  readonly id: string;
  readonly number: string;
  readonly scopeLabel: string;
  readonly note: string | null;
  readonly businessDate: string;
  readonly lineCount: number;
  readonly differenceCount: number;
  readonly shortageValueMinor: number;
  readonly surplusValueMinor: number;
  readonly createdAt: Date;
  readonly lines: readonly StockCountLineRow[];
}

export interface StockCountRepository {
  insertCount(tx: Tx, ctx: TenantContext, count: NewStockCount): Promise<void>;
  findCountById(tx: Tx, ctx: TenantContext, countId: string): Promise<StockCountRow | null>;
  findCountIdByOperationId(
    tx: Tx,
    ctx: TenantContext,
    operationId: string,
  ): Promise<string | null>;
  listCounts(
    tx: Tx,
    ctx: TenantContext,
    limit: number,
  ): Promise<readonly StockCountRow[]>;
}
