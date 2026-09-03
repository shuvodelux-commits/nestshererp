import type { AccountCode } from '@sher/core-domain';

import type { TenantContext } from '../ports/tenant-context';
import type { Tx } from '../ports/unit-of-work';

/**
 * Everything one posted purchase writes (§5.9), and the reads the two purchase
 * screens live on.
 *
 * Every id is generated in the application layer (R-C1) and handed down, so the
 * repository inserts rows and decides nothing about business meaning (R-B6).
 * One bill writes: the document, its lines, one lot and one stock movement per
 * line, the moving-average cache per product, and one journal entry — all in
 * the caller's transaction, because a bill that put stock on the shelf without
 * recording what it owes is not half a purchase, it is a wrong one.
 */

export interface NewJournalLine {
  readonly id: string;
  readonly account: AccountCode;
  readonly amountMinor: number;
  readonly partyId: string | null;
}

export interface NewPurchaseLine {
  readonly id: string;
  readonly lineNo: number;
  readonly productId: string;
  readonly locationId: string;
  readonly qty: number;
  readonly unitPriceMinor: number;
  readonly lineTotalMinor: number;
  readonly discountShareMinor: number;
  readonly extraCostShareMinor: number;
  /** Scale 4 — what the lot carries and a later sale is charged at. */
  readonly actualUnitCost: number;
  readonly lotValueMinor: number;
  readonly expiryDate: string | null;
  readonly lotId: string;
  readonly movementId: string;
  /** The plan line this fulfils, or null on an ordinary typed bill (Phase 8). */
  readonly planLineId?: string | null | undefined;
  /** The moving-average cache for this product after this line (DR13.5). */
  readonly costState: {
    readonly id: string;
    readonly exists: boolean;
    readonly avgUnitCost: number;
    readonly qtyOnHand: number;
  };
}

export interface NewPurchase {
  readonly id: string;
  readonly number: string;
  readonly operationId: string;
  readonly supplierPartyId: string;
  readonly supplierBillRef: string | null;
  readonly locationId: string;
  readonly dueDate: string | null;
  readonly itemsTotalMinor: number;
  readonly discountMinor: number;
  readonly extraCostMinor: number;
  readonly grandTotalMinor: number;
  readonly paidMinor: number;
  readonly paidAccountCode: string | null;
  /** The open day the cash left, when cash left at all (§5.16.1). */
  readonly sessionId: string | null;
  readonly notes: string | null;
  /** Marks that order CONVERTED and points it at this bill (Phase 8). */
  readonly supplierOrderId?: string | null | undefined;
  readonly businessDate: string;
  readonly entryMode: 'ON_TIME' | 'LATE_ENTRY' | 'BACKDATED' | 'CORRECTED';
  readonly journalEntryId: string;
  readonly journalLines: readonly NewJournalLine[];
  readonly lines: readonly NewPurchaseLine[];
  /** Named costs entered with the bill; their value is already in the lines/lots. */
  readonly landedCosts?: readonly {
    readonly id: string;
    readonly lineNo: number;
    readonly category: string;
    readonly method: string;
    readonly amountMinor: number;
    readonly description: string | null;
    readonly allocations: readonly {
      readonly id: string;
      readonly purchaseLineId: string;
      readonly amountMinor: number;
    }[];
  }[] | undefined;
}

export interface PurchaseLineRow {
  readonly id: string;
  readonly productId: string;
  readonly productName: string;
  readonly unitName: string;
  readonly qty: number;
  readonly unitPriceMinor: number;
  readonly lineTotalMinor: number;
  readonly discountShareMinor: number;
  readonly extraCostShareMinor: number;
  readonly actualUnitCost: number;
  readonly expiryDate: string | null;
  readonly lotId: string;
}

export interface PurchasePaymentRow {
  readonly id: string;
  readonly number: string;
  readonly businessDate: string;
  readonly accountName: string;
  readonly amountMinor: number;
}

export interface PurchaseRow {
  readonly id: string;
  readonly number: string;
  readonly supplierPartyId: string;
  readonly supplierName: string;
  readonly supplierBillRef: string | null;
  readonly businessDate: string;
  readonly dueDate: string | null;
  readonly status: 'POSTED' | 'VOIDED';
  readonly notes: string | null;
  readonly itemsTotalMinor: number;
  readonly discountMinor: number;
  readonly extraCostMinor: number;
  readonly grandTotalMinor: number;
  /** Paid on the bill plus everything allocated to it since — never stored. */
  readonly paidMinor: number;
  readonly dueMinor: number;
  readonly paidAccountCode: string | null;
  readonly paidAccountName: string | null;
  readonly createdAt: Date;
}

export interface PurchaseDetail extends PurchaseRow {
  readonly lines: readonly PurchaseLineRow[];
  readonly landedCosts: readonly {
    readonly id: string;
    readonly category: 'TRANSPORT' | 'LABOUR' | 'LOADING' | 'DELIVERY' | 'CUSTOMS' | 'OTHER';
    readonly method: 'BY_VALUE' | 'BY_QTY' | 'MANUAL';
    readonly amountMinor: number;
    readonly inventoryShareMinor: number;
    readonly cogsShareMinor: number;
    readonly businessDate: string;
    readonly description: string | null;
    readonly allocations: readonly { readonly purchaseLineId: string; readonly amountMinor: number }[];
  }[];
  readonly payments: readonly PurchasePaymentRow[];
  /** D-32: sent back on a cancel or a correction, so two writers cannot race. */
  readonly version: number;
}

export interface PurchaseListRowData {
  readonly id: string;
  readonly number: string;
  readonly supplierPartyId: string;
  readonly supplierName: string;
  readonly supplierBillRef: string | null;
  readonly businessDate: string;
  readonly dueDate: string | null;
  readonly status: 'POSTED' | 'VOIDED';
  readonly lineCount: number;
  readonly grandTotalMinor: number;
  readonly paidMinor: number;
  readonly dueMinor: number;
}

export interface PurchaseFilter {
  readonly search: string | null;
  readonly supplierPartyId: string | null;
  readonly fromDate: string | null;
  readonly toDate: string | null;
  readonly settlement: 'ALL' | 'UNPAID' | 'PAID';
  readonly cursor: string | null;
  readonly limit: number;
}

export interface PurchaseSummary {
  readonly periodTotalMinor: number;
  readonly unpaidTotalMinor: number;
  readonly overdueTotalMinor: number;
  readonly purchaseCount: number;
}

/** One bill with money still on it, oldest first — what a payment fills up. */
export interface OpenBillRow {
  readonly purchaseId: string;
  readonly number: string;
  readonly businessDate: string;
  readonly dueDate: string | null;
  readonly grandTotalMinor: number;
  readonly outstandingMinor: number;
}

export interface NewSupplierPayment {
  readonly id: string;
  readonly number: string;
  readonly operationId: string;
  readonly supplierPartyId: string;
  readonly accountCode: string;
  readonly amountMinor: number;
  readonly note: string | null;
  readonly sessionId: string | null;
  readonly businessDate: string;
  readonly entryMode: 'ON_TIME' | 'LATE_ENTRY' | 'BACKDATED' | 'CORRECTED';
  readonly journalEntryId: string;
  readonly journalLines: readonly NewJournalLine[];
  readonly allocations: readonly {
    readonly id: string;
    readonly purchaseId: string;
    readonly amountMinor: number;
  }[];
}

export interface SupplierPaymentDetail {
  readonly id: string;
  readonly number: string;
  readonly supplierPartyId: string;
  readonly supplierName: string;
  readonly accountCode: string;
  readonly amountMinor: number;
  readonly note: string | null;
  readonly businessDate: string;
  readonly createdAt: Date;
  readonly allocations: readonly {
    readonly purchaseId: string;
    readonly purchaseNumber: string;
    readonly amountMinor: number;
  }[];
  /** Phase 9.2: what a correction and a cancellation need (D-32), and what they leave. */
  readonly status: 'POSTED' | 'VOIDED';
  readonly entryMode: string;
  readonly voidReason: string | null;
  readonly version: number;
}

/**
 * A corrected supplier payment, re-posted under its own number (Phase 9.2).
 *
 * The row is updated in place, the bills are allocated again — the reversal
 * released the old pointers — and a `SUPPLIER_PAYMENT_CORRECTION` entry
 * carries the new figures (§2.5).
 */
export interface RepostSupplierPayment {
  readonly id: string;
  readonly expectedVersion: number;
  readonly supplierPartyId: string;
  readonly accountCode: string;
  readonly amountMinor: number;
  readonly note: string | null;
  readonly sessionId: string | null;
  readonly businessDate: string;
  readonly entryMode: string;
  readonly correctionReason: string | null;
  readonly originalBusinessDate: string | null;
  readonly journalEntryId: string;
  readonly journalLines: readonly {
    readonly id: string;
    readonly account: string;
    readonly amountMinor: number;
    readonly partyId: string | null;
  }[];
  readonly allocations: readonly {
    readonly id: string;
    readonly purchaseId: string;
    readonly amountMinor: number;
  }[];
}

export interface PurchaseRepository {
  insertPurchase(tx: Tx, ctx: TenantContext, purchase: NewPurchase): Promise<void>;
  /** C10: the permanent unique index is the guarantee, not the 30-day cache. */
  findPurchaseIdByOperationId(
    tx: Tx,
    ctx: TenantContext,
    operationId: string,
  ): Promise<string | null>;
  findPurchaseById(tx: Tx, ctx: TenantContext, id: string): Promise<PurchaseDetail | null>;
  listPurchases(
    tx: Tx,
    ctx: TenantContext,
    filter: PurchaseFilter,
  ): Promise<readonly PurchaseListRowData[]>;
  summarise(
    tx: Tx,
    ctx: TenantContext,
    filter: PurchaseFilter,
    today: string,
  ): Promise<PurchaseSummary>;
  /**
   * The supplier's open bills in settlement order — business date, then id.
   *
   * `purchaseId` narrows it to one bill for the "Pay this bill" entry point;
   * the ordering and the outstanding arithmetic are the same either way, which
   * is what keeps the two buttons one use case.
   */
  listOpenBills(
    tx: Tx,
    ctx: TenantContext,
    supplierPartyId: string,
    purchaseId: string | null,
  ): Promise<readonly OpenBillRow[]>;
  insertPayment(tx: Tx, ctx: TenantContext, payment: NewSupplierPayment): Promise<void>;
  /** Returns false when somebody else changed the payment first (D-32). */
  repostPayment(tx: Tx, ctx: TenantContext, payment: RepostSupplierPayment): Promise<boolean>;
  findPaymentIdByOperationId(
    tx: Tx,
    ctx: TenantContext,
    operationId: string,
  ): Promise<string | null>;
  findPaymentById(tx: Tx, ctx: TenantContext, id: string): Promise<SupplierPaymentDetail | null>;
  /** A posted bill with everything needed to undo it (§2.5). */
  findPurchaseForReversal(
    tx: Tx,
    ctx: TenantContext,
    id: string,
  ): Promise<PurchaseForReversal | null>;
  /**
   * Undo a posted bill: the reversing entry, the goods back off the shelf, the
   * lots emptied and closed, and the document marked VOIDED. Returns false when
   * the version moved under it, so two people cannot reverse the same bill.
   */
  reversePurchase(tx: Tx, ctx: TenantContext, reversal: PurchaseReversal): Promise<boolean>;
  /**
   * Point a bill's payment allocations at its replacement.
   *
   * A correction reverses the original and posts the corrected bill under the
   * same number; money already handed over was handed over for *that* bill, so
   * it follows the number rather than being unallocated and re-entered by hand.
   */
  movePaymentAllocations(
    tx: Tx,
    ctx: TenantContext,
    fromPurchaseId: string,
    toPurchaseId: string,
  ): Promise<void>;
}

/**
 * A posted bill, read for correction or cancellation (Phase 7, §2.5).
 *
 * Everything needed to undo what it did, and nothing else: the entry it posted
 * (read back, never recomputed), the lot each line created with what is left in
 * it, and whether money has been allocated to it since.
 */
export interface PurchaseForReversal {
  readonly id: string;
  readonly number: string;
  readonly businessDate: string;
  readonly status: 'POSTED' | 'VOIDED';
  readonly supplierPartyId: string;
  readonly locationId: string;
  readonly grandTotalMinor: number;
  readonly paidMinor: number;
  /** Later supplier payments pointed at this bill. */
  readonly allocatedMinor: number;
  readonly version: number;
  readonly journalLines: readonly {
    readonly account: string;
    readonly amountMinor: number;
    readonly partyId: string | null;
  }[];
  readonly lines: readonly {
    readonly id: string;
    readonly productId: string;
    readonly lotId: string;
    readonly locationId: string;
    readonly qty: number;
    /** Still in the lot this line created. Less means some of it has gone. */
    readonly qtyRemainingInLot: number;
    /** What this line put into INVENTORY: qty × actual_unit_cost. */
    readonly costMinor: number;
  }[];
}

export interface PurchaseReversal {
  readonly purchaseId: string;
  readonly expectedVersion: number;
  readonly businessDate: string;
  readonly entryMode: string;
  readonly journalEntryId: string;
  readonly journalLines: readonly {
    readonly id: string;
    readonly account: string;
    readonly amountMinor: number;
    readonly partyId: string | null;
  }[];
  /** One OUT movement per line, taking the goods off the shelf again. */
  readonly movements: readonly {
    readonly id: string;
    readonly productId: string;
    readonly locationId: string;
    readonly lotId: string;
    readonly qty: number;
    readonly unitCost: number;
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
