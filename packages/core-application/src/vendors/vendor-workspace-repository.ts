import type { VendorActivityKind } from '@sher/core-contracts';

import type { NewJournalLine } from '../purchasing/purchase-repository';
import type { TenantContext } from '../ports/tenant-context';
import type { Tx } from '../ports/unit-of-work';

/**
 * What the Vendor Workspace needs that no existing repository already answers
 * (Phase 8.3, §5.6 M07).
 *
 * Deliberately narrow. Consignment receipts stay with `VendorStockRepository`,
 * sales with `SaleRepository`, the statement with `PartyRepository` — this port
 * adds only the vendor's own money documents, the custody of goods lent out,
 * and the two read queries that have to span all of them: the balances split by
 * account, and one activity list in date order.
 */

/** The three figures a vendor's tiles show, summed from journal lines (INV-06). */
export interface VendorAccountBalances {
  /** `VENDOR_PAYABLE` — what selling their consignment goods made the shop owe. */
  readonly payableMinor: number;
  /** `VENDOR_ADVANCE` — money resting with them, not yet worked off. */
  readonly advanceMinor: number;
  /** `AR` — goods charged to them and not yet paid for. */
  readonly receivableMinor: number;
}

export interface NewVendorMoneyDocument {
  readonly id: string;
  readonly number: string;
  readonly operationId: string;
  readonly vendorPartyId: string;
  readonly intent: string;
  readonly accountCode: string;
  readonly amountMinor: number;
  readonly note: string | null;
  readonly sessionId: string | null;
  readonly businessDate: string;
  readonly entryMode: 'ON_TIME' | 'LATE_ENTRY' | 'BACKDATED' | 'CORRECTED';
  readonly journalEntryId: string;
  readonly journalLines: readonly NewJournalLine[];
}

export interface VendorMoneyDocumentRow {
  readonly id: string;
  readonly number: string;
  readonly vendorPartyId: string;
  readonly intent: string;
  readonly accountCode: string;
  readonly amountMinor: number;
  readonly note: string | null;
  readonly businessDate: string;
}

/** One lot a temporary issue drew from, with what is still out of it. */
export interface NewIssueLot {
  readonly id: string;
  readonly lotId: string;
  readonly qty: number;
  readonly unitCost: number;
}

export interface NewVendorProductIssue {
  readonly id: string;
  readonly number: string;
  readonly operationId: string;
  readonly vendorPartyId: string;
  readonly productId: string;
  readonly locationId: string;
  readonly qty: number;
  readonly costMinor: number;
  readonly movementId: string;
  readonly note: string | null;
  readonly businessDate: string;
  readonly lots: readonly NewIssueLot[];
}

export interface VendorProductIssueRow {
  readonly id: string;
  readonly number: string;
  readonly vendorPartyId: string;
  readonly vendorName: string;
  readonly productId: string;
  readonly displayName: string;
  readonly unitName: string;
  readonly locationId: string;
  readonly qty: number;
  readonly returnedQty: number;
  readonly costMinor: number;
  readonly note: string | null;
  readonly businessDate: string;
  readonly version: number;
}

/** A return of lent goods: the document, the movement, and each lot's share. */
export interface NewVendorIssueReturn {
  readonly id: string;
  readonly number: string;
  readonly operationId: string;
  readonly issueId: string;
  readonly qty: number;
  readonly costMinor: number;
  readonly movementId: string;
  readonly note: string | null;
  readonly businessDate: string;
  readonly productId: string;
  readonly locationId: string;
  readonly restores: readonly {
    readonly issueLotId: string;
    readonly lotId: string;
    readonly qty: number;
    readonly qtyOutstandingAfter: number;
  }[];
  /** `qty + returnedQty` before this return, so the update is optimistic (D-32). */
  readonly issueVersion: number;
  readonly returnedQtyAfter: number;
}

export interface VendorActivityFilter {
  readonly vendorPartyId: string;
  readonly kinds: readonly VendorActivityKind[];
  readonly limit: number;
}

export interface VendorActivityRowData {
  readonly id: string;
  readonly kind: VendorActivityKind;
  readonly businessDate: string;
  readonly number: string;
  readonly description: string;
  readonly qty: number | null;
  readonly amountMinor: number | null;
  readonly openQty: number | null;
  readonly status: string;
  readonly sourceType: string;
  readonly sourceId: string;
}

export interface NewVendorProductSettlement {
  readonly id: string;
  readonly number: string;
  readonly operationId: string;
  readonly vendorPartyId: string;
  readonly purchaseId: string;
  readonly purchaseNumber: string;
  readonly grossProductMinor: number;
  readonly discountMinor: number;
  readonly netProductMinor: number;
  readonly landedCostMinor: number;
  readonly receivableBeforeMinor: number;
  readonly receivableAfterMinor: number;
  readonly businessDate: string;
  readonly entryMode: 'ON_TIME' | 'LATE_ENTRY' | 'BACKDATED' | 'CORRECTED';
  readonly journalEntryId: string;
  readonly journalLines: readonly NewJournalLine[];
  readonly allocations: readonly {
    readonly id: string;
    readonly saleId: string;
    readonly saleNumber: string;
    readonly amountMinor: number;
  }[];
}

export type VendorProductSettlementRow = Omit<
  NewVendorProductSettlement,
  'operationId' | 'entryMode' | 'journalEntryId' | 'journalLines'
>;

export interface VendorWorkspaceRepository {
  /** Split by account, because the tiles and the payment guard need them apart. */
  accountBalances(
    tx: Tx,
    ctx: TenantContext,
    vendorPartyId: string,
  ): Promise<VendorAccountBalances>;

  insertPayment(tx: Tx, ctx: TenantContext, payment: NewVendorMoneyDocument): Promise<void>;
  findPaymentIdByOperationId(tx: Tx, ctx: TenantContext, operationId: string): Promise<string | null>;
  findPaymentById(tx: Tx, ctx: TenantContext, id: string): Promise<VendorMoneyDocumentRow | null>;

  insertReceipt(tx: Tx, ctx: TenantContext, receipt: NewVendorMoneyDocument): Promise<void>;
  findReceiptIdByOperationId(tx: Tx, ctx: TenantContext, operationId: string): Promise<string | null>;
  findReceiptById(tx: Tx, ctx: TenantContext, id: string): Promise<VendorMoneyDocumentRow | null>;

  /**
   * The issue, its stock movement out and its lot provenance, written together.
   * The lots are decremented in the same statement set — goods cannot be both
   * on the shelf and at the vendor's.
   */
  insertIssue(tx: Tx, ctx: TenantContext, issue: NewVendorProductIssue): Promise<void>;
  findIssueIdByOperationId(tx: Tx, ctx: TenantContext, operationId: string): Promise<string | null>;
  findIssueById(tx: Tx, ctx: TenantContext, id: string): Promise<VendorProductIssueRow | null>;
  listIssues(
    tx: Tx,
    ctx: TenantContext,
    options: { readonly vendorPartyId: string; readonly openOnly: boolean; readonly limit: number },
  ): Promise<readonly VendorProductIssueRow[]>;

  /** What is still out, per lot, oldest first — the order a return is spread in. */
  listIssueLotsOutstanding(
    tx: Tx,
    ctx: TenantContext,
    issueId: string,
  ): Promise<readonly {
    readonly id: string;
    readonly lotId: string;
    readonly unitCost: number;
    readonly qtyOutstanding: number;
  }[]>;

  /** Returns false when the issue moved under the caller (D-32). */
  insertIssueReturn(tx: Tx, ctx: TenantContext, record: NewVendorIssueReturn): Promise<boolean>;
  findIssueReturnIdByOperationId(
    tx: Tx,
    ctx: TenantContext,
    operationId: string,
  ): Promise<string | null>;

  insertProductSettlement(
    tx: Tx,
    ctx: TenantContext,
    settlement: NewVendorProductSettlement,
  ): Promise<void>;
  findProductSettlementByOperationId(
    tx: Tx,
    ctx: TenantContext,
    operationId: string,
  ): Promise<VendorProductSettlementRow | null>;

  /**
   * One history list across six kinds of document, in business-date order.
   *
   * Read from the modules that own each row rather than from a table of its
   * own: a second copy of a sale's date and total would be a second thing to
   * keep in step with the sale.
   */
  listActivity(
    tx: Tx,
    ctx: TenantContext,
    filter: VendorActivityFilter,
  ): Promise<readonly VendorActivityRowData[]>;
}
