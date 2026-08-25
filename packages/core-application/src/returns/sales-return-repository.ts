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

export interface SalesReturnRepository {
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
