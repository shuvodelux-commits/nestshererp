import type { TenantContext } from '../ports/tenant-context';
import type { Tx } from '../ports/unit-of-work';

/**
 * Reading what may go back to a supplier, and writing what did (Phase 7, §5.11).
 *
 * Two caps, both computed rather than stored: what the bill line still has
 * un-returned (`Σ purchase_return_lines.qty`), and what its lot still holds
 * (`inventory_lots.qty_remaining`). The second is the one that matters at a
 * counter — goods already sold belong to somebody else and cannot be sent back.
 */

export interface ReturnableBillLineRow {
  readonly purchaseLineId: string;
  readonly productId: string;
  readonly productName: string;
  readonly unitName: string;
  readonly lotId: string;
  readonly locationId: string;
  readonly qtyReceived: number;
  readonly qtyReturned: number;
  readonly qtyRemainingInLot: number;
  /** What the supplier billed for the line, after the bill discount. */
  readonly billedNetMinor: number;
  /** Poisha per unit at scale 4, as the lot holds it. */
  readonly actualUnitCost: number;
}

export interface ReturnableBillRow {
  readonly purchaseId: string;
  readonly number: string;
  readonly businessDate: string;
  readonly status: string;
  readonly supplierPartyId: string;
  readonly supplierName: string;
  readonly locationId: string;
  readonly grandTotalMinor: number;
  /** What the shop still owes on this bill, after payments and credits. */
  readonly outstandingMinor: number;
  readonly lines: readonly ReturnableBillLineRow[];
}

export interface NewPurchaseReturnLine {
  readonly id: string;
  readonly lineNo: number;
  readonly purchaseLineId: string;
  readonly productId: string;
  readonly lotId: string;
  readonly locationId: string;
  readonly qty: number;
  readonly valueMinor: number;
  readonly costMinor: number;
  readonly movementId: string;
}

export interface NewPurchaseReturn {
  readonly id: string;
  readonly number: string;
  readonly purchaseId: string;
  readonly supplierPartyId: string;
  readonly supplierName: string;
  readonly locationId: string;
  readonly reason: string;
  readonly note: string | null;
  readonly returnValueMinor: number;
  readonly inventoryMinor: number;
  readonly receivedMinor: number;
  readonly creditMinor: number;
  readonly settledMinor: number;
  readonly receiptAccountCode: string | null;
  readonly businessDate: string;
  readonly entryMode: string;
  readonly backdateReason: string | null;
  readonly operationId: string;
  readonly lines: readonly NewPurchaseReturnLine[];
  readonly journalEntryId: string;
  readonly journalLines: readonly {
    readonly id: string;
    readonly account: string;
    readonly amountMinor: number;
    readonly partyId: string | null;
  }[];
  readonly costStates: readonly {
    readonly id: string;
    readonly exists: boolean;
    readonly productId: string;
    readonly locationId: string;
    readonly avgUnitCost: number;
    readonly qtyOnHand: number;
  }[];
}

export interface PurchaseReturnLineRow {
  readonly id: string;
  readonly purchaseLineId: string;
  readonly productId: string;
  readonly productName: string;
  readonly unitName: string;
  readonly qty: number;
  readonly valueMinor: number;
}

export interface PurchaseReturnRow {
  readonly id: string;
  readonly number: string;
  readonly purchaseId: string;
  readonly purchaseNumber: string;
  readonly supplierPartyId: string;
  readonly supplierName: string;
  readonly businessDate: string;
  readonly reason: string;
  readonly note: string | null;
  readonly returnValueMinor: number;
  readonly receivedMinor: number;
  readonly creditMinor: number;
  readonly receiptAccountCode: string | null;
  readonly receiptAccountName: string | null;
  readonly createdAt: Date;
  readonly lines: readonly PurchaseReturnLineRow[];
}

export interface PurchaseReturnFilter {
  readonly search: string | null;
  readonly supplierPartyId: string | null;
  readonly fromDate: string | null;
  readonly toDate: string | null;
  readonly cursor: string | null;
  readonly limit: number;
}

/**
 * What a posted purchase return did, read back so it can be undone exactly
 * (Phase 9.2, §2.5). The **stored** figures, never recomputed.
 */
export interface PurchaseReturnForReversal {
  readonly id: string;
  readonly number: string;
  readonly status: string;
  readonly businessDate: string;
  readonly version: number;
  readonly journalLines: readonly {
    readonly account: string;
    readonly amountMinor: number;
    readonly partyId: string | null;
  }[];
  readonly lines: readonly {
    readonly productId: string;
    readonly lotId: string;
    readonly locationId: string;
    readonly qty: number;
    readonly costMinor: number;
  }[];
  readonly costStates: readonly {
    readonly id: string;
    readonly productId: string;
    readonly locationId: string;
    readonly qtyOnHand: number;
    readonly avgUnitCost: number;
  }[];
}

/** Undoing one purchase return — the mirror of `postPurchaseReturn`. */
export interface PurchaseReturnReversal {
  readonly returnId: string;
  readonly expectedVersion: number;
  readonly businessDate: string;
  readonly entryMode: string;
  readonly reason: string;
  readonly journalEntryId: string;
  readonly journalLines: readonly {
    readonly id: string;
    readonly account: string;
    readonly amountMinor: number;
    readonly partyId: string | null;
  }[];
  readonly lines: readonly {
    readonly movementId: string;
    readonly productId: string;
    readonly lotId: string;
    readonly locationId: string;
    readonly qty: number;
    readonly costMinor: number;
  }[];
  readonly costStates: readonly {
    readonly id: string;
    readonly exists: boolean;
    readonly productId: string;
    readonly locationId: string;
    readonly qtyOnHand: number;
    readonly avgUnitCost: number;
  }[];
}

export interface PurchaseReturnRepository {
  findReturnableBill(tx: Tx, ctx: TenantContext, purchaseId: string): Promise<ReturnableBillRow | null>;
  postPurchaseReturn(tx: Tx, ctx: TenantContext, draft: NewPurchaseReturn): Promise<void>;
  findReturnForReversal(
    tx: Tx,
    ctx: TenantContext,
    returnId: string,
  ): Promise<PurchaseReturnForReversal | null>;
  /** Returns false when somebody else changed the return first (D-32). */
  reversePurchaseReturn(
    tx: Tx,
    ctx: TenantContext,
    reversal: PurchaseReturnReversal,
  ): Promise<boolean>;
  findReturnById(tx: Tx, ctx: TenantContext, returnId: string): Promise<PurchaseReturnRow | null>;
  findReturnIdByOperationId(tx: Tx, ctx: TenantContext, operationId: string): Promise<string | null>;
  listReturns(
    tx: Tx,
    ctx: TenantContext,
    filter: PurchaseReturnFilter,
  ): Promise<{
    readonly returns: readonly PurchaseReturnRow[];
    readonly nextCursor: string | null;
    readonly totalValueMinor: number;
    readonly totalReceivedMinor: number;
  }>;
}
