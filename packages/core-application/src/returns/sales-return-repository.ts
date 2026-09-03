import type { TenantContext } from '../ports/tenant-context';
import type { Tx } from '../ports/unit-of-work';

/**
 * Reading what may come back, and writing what did (Phase 7, §5.11).
 *
 * **Nothing here stores how much of an invoice has already been returned.** It
 * is `Σ sales_return_lines.qty` per sale line, computed in the same statement as
 * the line it caps — the same argument migration 0015 makes for a party balance
 * and 0017 for a bill's outstanding. A stored counter is a second answer to a
 * question the rows already answer, and the first posting path that forgets to
 * bump it lets a shop return four of three.
 */

/** One line of the invoice, with what is still returnable on it. */
export interface ReturnableLineRow {
  readonly saleLineId: string;
  readonly productId: string;
  readonly productName: string;
  readonly unitName: string;
  readonly locationId: string;
  readonly qtySold: number;
  readonly qtyReturned: number;
  readonly unitPriceMinor: number;
  readonly netAmountMinor: number;
  readonly costMinor: number;
  /** Consignment goods were never the shop's stock, so they cannot come back. */
  readonly source: 'OWN_STOCK' | 'VENDOR_CONSIGNMENT';
}

export interface ReturnableInvoiceRow {
  readonly saleId: string;
  readonly number: string;
  readonly businessDate: string;
  readonly status: 'POSTED' | 'VOIDED';
  readonly partyId: string;
  readonly isWalkIn: boolean;
  readonly customerName: string;
  /**
   * What the counter was told when the sale was made, even on a guest sale.
   * A return that leaves credit needs it: §5.8 says a balance must belong to
   * somebody the ledger can point at, and these are the details the shopkeeper
   * already collected.
   */
  readonly customerPhone: string | null;
  readonly customerGuardianName: string | null;
  readonly customerAddress: string | null;
  readonly locationId: string;
  readonly grandTotalMinor: number;
  /** What this invoice still owes, after payments, allocations and credits. */
  readonly dueMinor: number;
  readonly lines: readonly ReturnableLineRow[];
}

/** Which lots a sale line took stock from, and what each unit cost. */
export interface LineConsumptionRow {
  readonly saleLineId: string;
  readonly lotId: string;
  readonly qty: number;
  readonly unitCostUsed: number;
}

export interface ReturnableSourceAllocationRow {
  readonly id: string;
  readonly saleLineId: string;
  readonly sourceType: 'OWNED' | 'VENDOR' | 'NEGATIVE';
  readonly qty: number;
  readonly reversedQty: number;
  readonly ownedLotId: string | null;
  readonly vendorPartyId: string | null;
  readonly vendorLotId: string | null;
  readonly inventoryUnitId: string | null;
  readonly serialNo: string | null;
  readonly unitCostUsed: number;
}

export interface NewSalesReturnLine {
  readonly id: string;
  readonly lineNo: number;
  readonly saleLineId: string;
  readonly productId: string;
  readonly locationId: string;
  readonly qty: number;
  readonly valueMinor: number;
  readonly costMinor: number;
  readonly movementId: string;
  /** Which lots this quantity goes back into, and at what cost. */
  readonly refills: readonly { readonly lotId: string; readonly qty: number; readonly unitCostUsed: number }[];
  readonly vendorRestorations: readonly { readonly lotId: string; readonly qty: number }[];
  readonly sourceReversals: readonly {
    readonly id: string;
    readonly sourceAllocationId: string;
    readonly qty: number;
  }[];
  readonly serialUnitIds: readonly string[];
}

export interface NewSalesReturn {
  readonly id: string;
  readonly number: string;
  readonly saleId: string;
  readonly partyId: string;
  readonly customerName: string;
  readonly locationId: string;
  readonly reason: string;
  readonly note: string | null;
  readonly returnValueMinor: number;
  readonly refundMinor: number;
  readonly creditMinor: number;
  readonly settledMinor: number;
  readonly cogsMinor: number;
  readonly refundAccountCode: string | null;
  readonly approvedBy: string | null;
  readonly businessDate: string;
  readonly entryMode: string;
  readonly backdateReason: string | null;
  readonly operationId: string;
  readonly lines: readonly NewSalesReturnLine[];
  readonly journalEntryId: string;
  readonly journalLines: readonly {
    readonly id: string;
    readonly account: string;
    readonly amountMinor: number;
    readonly partyId: string | null;
  }[];
  /** The moving-average cache per product, after the goods came back. */
  readonly costStates: readonly {
    readonly id: string;
    readonly exists: boolean;
    readonly productId: string;
    readonly locationId: string;
    readonly avgUnitCost: number;
    readonly qtyOnHand: number;
  }[];
}

export interface SalesReturnLineRow {
  readonly id: string;
  readonly saleLineId: string;
  readonly productId: string;
  readonly productName: string;
  readonly unitName: string;
  readonly qty: number;
  readonly valueMinor: number;
}

export interface SalesReturnRow {
  readonly id: string;
  readonly number: string;
  readonly saleId: string;
  readonly saleNumber: string;
  readonly partyId: string;
  readonly customerName: string;
  readonly businessDate: string;
  readonly reason: string;
  readonly note: string | null;
  readonly returnValueMinor: number;
  readonly refundMinor: number;
  readonly creditMinor: number;
  readonly refundAccountCode: string | null;
  readonly refundAccountName: string | null;
  readonly approvedByName: string | null;
  readonly createdAt: Date;
  readonly lines: readonly SalesReturnLineRow[];
}

export interface SalesReturnFilter {
  readonly search: string | null;
  readonly partyId: string | null;
  readonly fromDate: string | null;
  readonly toDate: string | null;
  readonly cursor: string | null;
  readonly limit: number;
}

/**
 * How much cash somebody may hand back, and who can approve more.
 *
 * `null` is unlimited. The caps live on the **role** (owner decision
 * 2026-08-26), so this is read through whoever holds it rather than stored per
 * person.
 */
export interface RefundCaps {
  readonly perReturnMinor: number | null;
  readonly perDayMinor: number | null;
}

/** Somebody senior enough to approve this refund, and the PIN to check against. */
export interface ApprovalCandidate {
  readonly userId: string;
  readonly displayName: string;
  readonly pinHash: string;
}

/**
 * What a posted sales return did, read back so it can be undone exactly
 * (Phase 9.2, §2.5).
 *
 * The **stored** figures, never recomputed: a return cancelled next month at
 * today's average would take a different cost off `INVENTORY` than it put on,
 * and the account would stop equalling the valuation (INV-05).
 */
export interface SalesReturnForReversal {
  readonly id: string;
  readonly number: string;
  readonly status: string;
  readonly businessDate: string;
  readonly version: number;
  readonly cogsMinor: number;
  readonly journalLines: readonly {
    readonly account: string;
    readonly amountMinor: number;
    readonly partyId: string | null;
  }[];
  readonly lines: readonly {
    readonly saleLineId: string;
    readonly productId: string;
    readonly locationId: string;
    readonly qty: number;
    readonly costMinor: number;
    /** The lots this return put goods back into, and how much went into each. */
    readonly refills: readonly {
      readonly lotId: string;
      readonly qty: number;
      /** What is in that lot now — less than `qty` means it has been re-sold. */
      readonly lotRemaining: number;
    }[];
  }[];
  readonly sourceOrigins: readonly {
    readonly saleLineId: string;
    readonly sourceType: 'OWNED' | 'VENDOR' | 'NEGATIVE';
    readonly qty: number;
    readonly ownedLotId: string | null;
    readonly vendorLotId: string | null;
    /** What is in that vendor lot now — the vendor mirror of `lotRemaining`. */
    readonly vendorLotRemaining: number;
    readonly inventoryUnitId: string | null;
    readonly unitCostUsed: number;
    readonly serialPreviousStatus: string | null;
    readonly serialSaleId: string | null;
    readonly serialSaleLineId: string | null;
    readonly serialCustomerPartyId: string | null;
    readonly serialSoldDate: string | null;
    readonly serialCustomerWarrantyMonths: number | null;
  }[];
  readonly costStates: readonly {
    readonly id: string;
    readonly productId: string;
    readonly locationId: string;
    readonly qtyOnHand: number;
    readonly avgUnitCost: number;
  }[];
}

/** Undoing one sales return — the mirror of `postSalesReturn`. */
export interface SalesReturnReversal {
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
    readonly locationId: string;
    readonly qty: number;
    readonly costMinor: number;
    readonly takeBack: readonly { readonly lotId: string; readonly qty: number }[];
  }[];
  readonly vendorTakes: readonly { readonly lotId: string; readonly qty: number }[];
  readonly serialRestores: readonly {
    readonly unitId: string;
    readonly status: string;
    readonly saleId: string | null;
    readonly saleLineId: string | null;
    readonly customerPartyId: string | null;
    readonly soldDate: string | null;
    readonly customerWarrantyMonths: number | null;
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

export interface SalesReturnRepository {
  lockSale(tx: Tx, ctx: TenantContext, saleId: string): Promise<boolean>;
  refundCapsOf(tx: Tx, ctx: TenantContext, userId: string): Promise<RefundCaps>;
  /**
   * Every live user whose own role could hand this refund back today — the only
   * people whose PIN may unlock it. Filtered in SQL rather than in the service
   * so a PIN is never even compared against somebody who could not approve.
   */
  approvalCandidates(
    tx: Tx,
    ctx: TenantContext,
    refundMinor: number,
    businessDate: string,
  ): Promise<readonly ApprovalCandidate[]>;
  /** The invoice with per-line caps, or null when it is not this tenant's. */
  findReturnableInvoice(tx: Tx, ctx: TenantContext, saleId: string): Promise<ReturnableInvoiceRow | null>;
  /** The lots those lines consumed, in the order they were consumed. */
  lineConsumptions(tx: Tx, ctx: TenantContext, saleId: string): Promise<readonly LineConsumptionRow[]>;
  sourceAllocations(
    tx: Tx,
    ctx: TenantContext,
    saleId: string,
  ): Promise<readonly ReturnableSourceAllocationRow[]>;
  /** What each lot has already had put back, so a second return cannot overfill it. */
  refillsSoFar(
    tx: Tx,
    ctx: TenantContext,
    saleId: string,
  ): Promise<readonly { readonly saleLineId: string; readonly lotId: string; readonly qty: number }[]>;
  /** What this user has already refunded in cash on this business date. */
  cashRefundedToday(tx: Tx, ctx: TenantContext, userId: string, businessDate: string): Promise<number>;
  /** The whole return, in one transaction: document, stock, cost cache, journal. */
  postSalesReturn(tx: Tx, ctx: TenantContext, draft: NewSalesReturn): Promise<void>;
  findReturnForReversal(
    tx: Tx,
    ctx: TenantContext,
    returnId: string,
  ): Promise<SalesReturnForReversal | null>;
  /** Returns false when somebody else changed the return first (D-32). */
  reverseSalesReturn(tx: Tx, ctx: TenantContext, reversal: SalesReturnReversal): Promise<boolean>;
  findReturnById(tx: Tx, ctx: TenantContext, returnId: string): Promise<SalesReturnRow | null>;
  findReturnIdByOperationId(tx: Tx, ctx: TenantContext, operationId: string): Promise<string | null>;
  listReturns(
    tx: Tx,
    ctx: TenantContext,
    filter: SalesReturnFilter,
  ): Promise<{
    readonly returns: readonly SalesReturnRow[];
    readonly nextCursor: string | null;
    readonly totalValueMinor: number;
    readonly totalRefundMinor: number;
  }>;
}
