import type { AccountCode, StockAdjustmentReason } from '@sher/core-domain';
import type { InventoryLotSort, SortDirection } from '@sher/core-contracts';

import type { TenantContext } from '../ports/tenant-context';
import type { Tx } from '../ports/unit-of-work';

export interface LocationRow { readonly id: string; readonly name: string }

export interface OpeningStockRecord {
  readonly id: string;
  readonly number: string;
  readonly operationId: string;
  readonly productId: string;
  readonly productName: string;
  readonly locationId: string;
  readonly locationName: string;
  readonly qty: number;
  readonly unitCost: number;
  readonly valueMinor: number;
  readonly businessDate: string;
  readonly expiryDate: string | null;
  readonly entryMode: 'ON_TIME' | 'LATE_ENTRY' | 'BACKDATED' | 'CORRECTED';
  readonly lotId: string;
  readonly movementId: string;
  readonly costStateId: string;
  readonly journalEntryId: string;
  readonly journalLines: readonly {
    readonly id: string;
    readonly account: AccountCode;
    readonly amountMinor: number;
    readonly partyId: string | null;
  }[];
}

/**
 * One posted stock correction and everything it writes (§5.10).
 *
 * Every id is generated in the application layer (C1) and handed down, so the
 * repository inserts rows and computes nothing about business meaning (B6).
 * The two directions carry different halves: an increase brings `newLot`, a
 * decrease brings `consumptions`.
 */
export interface StockAdjustmentRecord {
  readonly id: string;
  readonly number: string;
  readonly operationId: string;
  readonly productId: string;
  readonly productName: string;
  readonly locationId: string;
  readonly locationName: string;
  readonly qtyDelta: number;
  readonly direction: 'IN' | 'OUT';
  readonly qty: number;
  readonly valueMinor: number;
  readonly reason: StockAdjustmentReason;
  readonly note: string | null;
  readonly businessDate: string;
  readonly entryMode: 'ON_TIME' | 'LATE_ENTRY' | 'BACKDATED' | 'CORRECTED';
  readonly movementId: string;
  readonly journalEntryId: string;
  readonly journalLines: readonly {
    readonly id: string;
    readonly account: AccountCode;
    readonly amountMinor: number;
    readonly partyId: string | null;
  }[];
  /** An increase creates one owned lot at the resolved cost basis. */
  readonly newLot: { readonly id: string; readonly unitCost: number } | null;
  /** A decrease consumes existing lots in the order the domain chose. */
  readonly consumptions: readonly {
    readonly id: string;
    readonly lotId: string;
    readonly qty: number;
    readonly unitCostUsed: number;
    /** DR13.11: a lot reaching zero is CLOSED and kept forever, never deleted. */
    readonly closesLot: boolean;
  }[];
  /** The moving-average cache after this movement (DR13.5). */
  readonly costState: {
    readonly id: string;
    readonly exists: boolean;
    readonly avgUnitCost: number;
    readonly qtyOnHand: number;
  };
}

export interface StockAdjustmentFilter {
  readonly fromDate: string | null;
  readonly toDate: string | null;
  readonly productId: string | null;
  readonly limit: number;
}

export interface StockAdjustmentListRow {
  readonly id: string;
  readonly number: string;
  readonly productId: string;
  readonly productName: string;
  readonly locationName: string;
  readonly qtyDelta: number;
  readonly direction: 'IN' | 'OUT';
  readonly qty: number;
  readonly valueMinor: number;
  readonly reason: StockAdjustmentReason;
  readonly note: string | null;
  readonly businessDate: string;
  readonly createdAt: Date;
  readonly createdByName: string;
}

export interface CostAdjustmentListRow {
  readonly id: string;
  readonly productId: string;
  readonly productName: string;
  readonly reason: 'BACKDATE' | 'EDIT' | 'LANDED_COST' | 'SYNC_TRUE_UP' | 'NEGATIVE_STOCK_TRUE_UP';
  readonly documentRef: string;
  readonly amountMinor: number;
  readonly businessDate: string;
}

/** What a decrease may consume, in the shape `costIssue` reads (DR13.2). */
export interface StockCostLayerRow {
  readonly id: string;
  readonly qtyRemaining: number;
  readonly unitCost: number;
  readonly businessDate: string;
  readonly createdAt: string;
  readonly expiryDate: string | null;
}

export interface ProductStockPosition {
  readonly locationId: string;
  readonly locationName: string;
  readonly costStateId: string | null;
  readonly qtyOnHand: number;
  readonly avgUnitCost: number;
}

export interface InventoryStockRow {
  readonly productId: string; readonly productName: string;
  readonly productStatus: 'ACTIVE' | 'INACTIVE'; readonly baseUnitName: string;
  readonly tracksExpiry: boolean;
  readonly locationId: string | null; readonly locationName: string | null;
  readonly qtyOnHand: number; readonly minStockQty: number; readonly avgUnitCost: number;
}

export interface InventoryMovementRow {
  readonly id: string; readonly productId: string; readonly productName: string;
  readonly locationName: string; readonly lotId: string | null; readonly qty: number;
  readonly direction: 'IN' | 'OUT'; readonly sourceType: string;
  readonly sourceId: string; readonly sourceNumber: string;
  readonly businessDate: string; readonly createdAt: Date; readonly unitCost: number;
}

export interface InventoryLotRow {
  readonly id: string;
  readonly productId: string;
  readonly productName: string;
  readonly locationId: string;
  readonly locationName: string;
  readonly ownerType: 'OWNED' | 'VENDOR';
  readonly sourceType: string;
  readonly sourceId: string;
  readonly sourceNumber: string;
  readonly qtyReceived: number;
  readonly qtyRemaining: number;
  readonly purchaseUnitCost: number;
  readonly landedCostTotal: number;
  readonly actualUnitCost: number;
  readonly businessDate: string;
  readonly expiryDate: string | null;
  readonly status: 'OPEN' | 'CLOSED';
}

export interface InventoryLotFilter {
  /** `null` reads every product, for the Inventory Report's lot and expiry views. */
  readonly productId: string | null;
  readonly expiringOnly: boolean;
  /**
   * The Expiry card's three questions (Phase 7.2). `EXPIRED` past `asOf`,
   * `SOON` between `asOf` and the warn window, `MISSING` an expiry-tracked
   * batch with no date at all.
   */
  readonly expiry: 'EXPIRED' | 'SOON' | 'MISSING' | null;
  /** Today, and the last day of the warn window — both business dates. */
  readonly asOf: string;
  readonly warnUntil: string;
  readonly status: 'OPEN' | 'CLOSED' | null;
  readonly cursor: string | null;
  readonly limit: number;
  readonly sort: InventoryLotSort;
  readonly direction: SortDirection;
}

export interface InventoryValuationLotRow {
  readonly productId: string;
  readonly locationId: string;
  readonly qtyRemaining: number;
  readonly actualUnitCost: number;
}

export interface InventoryCostStateRow {
  readonly productId: string;
  readonly productName: string;
  readonly locationId: string;
  readonly locationName: string;
  readonly qtyOnHand: number;
  readonly avgUnitCost: number;
}

/**
 * What a posted stock adjustment did, read back so it can be undone exactly
 * (Phase 9.2, §2.5).
 *
 * The **stored** figures, never recomputed: an adjustment cancelled a month
 * later at today's average would take a different value off `INVENTORY` than
 * it put on, and the account would stop equalling the valuation (INV-05).
 */
export interface StockAdjustmentForReversal {
  readonly id: string;
  readonly number: string;
  readonly status: string;
  readonly businessDate: string;
  readonly productId: string;
  readonly locationId: string;
  readonly qtyDelta: number;
  readonly qty: number;
  readonly direction: 'IN' | 'OUT';
  readonly valueMinor: number;
  readonly version: number;
  readonly journalLines: readonly {
    readonly account: string;
    readonly amountMinor: number;
    readonly partyId: string | null;
  }[];
  /** The lot an increase created, with what is left of it. */
  readonly newLot: {
    readonly id: string;
    readonly qtyReceived: number;
    readonly qtyRemaining: number;
    readonly unitCost: number;
  } | null;
  /** The lots a decrease took from, so the quantity goes back where it came from. */
  readonly consumptions: readonly {
    readonly lotId: string;
    readonly qty: number;
    readonly unitCostUsed: number;
  }[];
  readonly costState: {
    readonly id: string;
    readonly qtyOnHand: number;
    readonly avgUnitCost: number;
  } | null;
}

/** Undoing one stock adjustment — the mirror of `insertAdjustment`. */
export interface StockAdjustmentReversal {
  readonly adjustmentId: string;
  readonly expectedVersion: number;
  readonly businessDate: string;
  readonly entryMode: string;
  readonly reason: string;
  readonly movementId: string;
  readonly direction: 'IN' | 'OUT';
  readonly qty: number;
  readonly journalEntryId: string;
  readonly journalLines: readonly {
    readonly id: string;
    readonly account: string;
    readonly amountMinor: number;
    readonly partyId: string | null;
  }[];
  /** The lot to close, when the adjustment being undone had created one. */
  readonly closeLotId: string | null;
  /** Quantities to put back into the lots a decrease consumed. */
  readonly refills: readonly { readonly lotId: string; readonly qty: number }[];
  readonly costState: {
    readonly id: string;
    readonly exists: boolean;
    readonly qtyOnHand: number;
    readonly avgUnitCost: number;
  };
}

export interface InventoryRepository {
  findDefaultLocation(tx: Tx, ctx: TenantContext): Promise<LocationRow | null>;
  createDefaultLocation(tx: Tx, ctx: TenantContext, id: string): Promise<LocationRow>;
  findOpeningByOperationId(tx: Tx, ctx: TenantContext, operationId: string): Promise<OpeningStockRecord | null>;
  findOpeningById(tx: Tx, ctx: TenantContext, id: string): Promise<OpeningStockRecord | null>;
  findOpeningByProduct(tx: Tx, ctx: TenantContext, productId: string): Promise<OpeningStockRecord | null>;
  insertOpening(tx: Tx, ctx: TenantContext, opening: OpeningStockRecord): Promise<void>;
  findAdjustmentByOperationId(tx: Tx, ctx: TenantContext, operationId: string): Promise<StockAdjustmentRecord | null>;
  insertAdjustment(tx: Tx, ctx: TenantContext, adjustment: StockAdjustmentRecord): Promise<void>;
  findAdjustmentForReversal(
    tx: Tx,
    ctx: TenantContext,
    adjustmentId: string,
  ): Promise<StockAdjustmentForReversal | null>;
  /** Returns false when somebody else changed the adjustment first (D-32). */
  reverseAdjustment(
    tx: Tx,
    ctx: TenantContext,
    reversal: StockAdjustmentReversal,
  ): Promise<boolean>;
  listAdjustments(tx: Tx, ctx: TenantContext, filter: StockAdjustmentFilter): Promise<readonly StockAdjustmentListRow[]>;
  listCostAdjustments(tx: Tx, ctx: TenantContext, filter: StockAdjustmentFilter): Promise<readonly CostAdjustmentListRow[]>;
  /** Where a product's stock currently sits, and what it is worth per unit. */
  findStockPosition(tx: Tx, ctx: TenantContext, productId: string): Promise<ProductStockPosition | null>;
  listCostLayers(tx: Tx, ctx: TenantContext, productId: string, locationId: string): Promise<readonly StockCostLayerRow[]>;
  /**
   * Whether anything has ever happened to this product's stock (§3.6).
   *
   * The delete guard asks this inside the transaction rather than trusting a
   * quantity the dialog happened to be showing — a product can read as zero on
   * hand and still have a lifetime of movements behind it.
   */
  productHasStockHistory(tx: Tx, ctx: TenantContext, productId: string): Promise<boolean>;
  listStock(tx: Tx, ctx: TenantContext): Promise<readonly InventoryStockRow[]>;
  listMovements(tx: Tx, ctx: TenantContext, filter: StockAdjustmentFilter): Promise<readonly InventoryMovementRow[]>;
  listLots(tx: Tx, ctx: TenantContext, filter: InventoryLotFilter): Promise<readonly InventoryLotRow[]>;
  /** How many batches sit in each of the three buckets, and what the expired ones are worth. */
  expirySummary(
    tx: Tx,
    ctx: TenantContext,
    range: { readonly productId: string | null; readonly asOf: string; readonly warnUntil: string },
  ): Promise<{
    readonly expiredCount: number;
    readonly expiredValueMinor: number;
    readonly soonCount: number;
    readonly missingCount: number;
  }>;
  /** Set or correct a batch's expiry date. Returns false when the lot is not this tenant's. */
  setLotExpiry(tx: Tx, ctx: TenantContext, lotId: string, expiryDate: string | null): Promise<boolean>;
  /** One lot, for the audit trail's before-and-after. */
  findLotById(
    tx: Tx,
    ctx: TenantContext,
    lotId: string,
  ): Promise<{ readonly id: string; readonly productId: string; readonly expiryDate: string | null } | null>;
  listValuationLots(tx: Tx, ctx: TenantContext): Promise<readonly InventoryValuationLotRow[]>;
  listCostStates(tx: Tx, ctx: TenantContext): Promise<readonly InventoryCostStateRow[]>;
  listInventoryJournalAmounts(tx: Tx, ctx: TenantContext): Promise<readonly number[]>;
}
