import type { AccountCode } from '@sher/core-domain';

import type { TenantContext } from '../ports/tenant-context';
import type { Tx } from '../ports/unit-of-work';

/**
 * Everything one posted sale writes (§5.7, §5.8), and the reads the counter,
 * the invoice and the customer's hub live on.
 *
 * Every id is generated in the application layer (R-C1) and handed down, so the
 * repository inserts rows and decides nothing about business meaning (R-B6).
 * One sale writes: the document, its lines, its payment rows, one stock
 * movement and its lot consumptions per line, the moving-average cache per
 * product, and one journal entry — all in the caller's transaction, because
 * goods that left the shelf without the money being recorded is not half a
 * sale, it is a wrong one.
 */

export interface NewJournalLine {
  readonly id: string;
  readonly account: AccountCode;
  readonly amountMinor: number;
  readonly partyId: string | null;
}

/** One lot this line took stock from, in the order the domain chose (DR13.2). */
export interface NewLotConsumption {
  readonly id: string;
  readonly lotId: string;
  readonly qty: number;
  readonly unitCostUsed: number;
  /** DR13.11: a lot reaching zero is CLOSED and kept forever, never deleted. */
  readonly closesLot: boolean;
}

export interface NewSaleSourceAllocation {
  readonly id: string;
  readonly sourceType: 'OWNED' | 'VENDOR' | 'NEGATIVE';
  readonly qty: number;
  readonly ownedLotId: string | null;
  readonly vendorPartyId: string | null;
  readonly vendorStockReceiptId: string | null;
  readonly vendorLotId: string | null;
  readonly inventoryUnitId: string | null;
  readonly unitCostUsed: number | null;
}

export interface NewSaleLine {
  readonly id: string;
  readonly lineNo: number;
  readonly productId: string;
  readonly locationId: string;
  readonly qty: number;
  readonly unitPriceMinor: number;
  readonly lineDiscountMinor: number;
  readonly lineTotalMinor: number;
  readonly discountShareMinor: number;
  readonly netAmountMinor: number;
  /** What these goods cost the shop — the COGS side of this line. */
  readonly costMinor: number;
  readonly source: 'OWN_STOCK' | 'VENDOR_CONSIGNMENT';
  readonly vendorPartyId: string | null;
  readonly vendorUnitCost: number | null;
  readonly isProvisionalCost: boolean;
  readonly movementId: string;
  /**
   * A consignment line creates the lot it immediately sells (DR13.10's deemed
   * purchase) so the goods have a costed origin; an own-stock line has none of
   * its own and consumes the lots already there.
   */
  readonly vendorLot: { readonly id: string; readonly unitCost: number } | null;
  readonly consumptions: readonly NewLotConsumption[];
  readonly sourceAllocations: readonly NewSaleSourceAllocation[];
  readonly serialUnitIds: readonly string[];
  /** The moving-average cache for this product after this line (DR13.5). */
  readonly costState: {
    readonly id: string;
    readonly exists: boolean;
    readonly avgUnitCost: number;
    readonly qtyOnHand: number;
    /** Owned plus negative quantity issued; vendor-owned quantity is excluded. */
    readonly qtyChange: number;
  };
}

export interface NewSalePayment {
  readonly id: string;
  readonly lineNo: number;
  readonly accountCode: string;
  readonly amountMinor: number;
  readonly sessionId: string | null;
}

export interface NewSale {
  readonly id: string;
  readonly number: string;
  readonly operationId: string;
  readonly partyId: string;
  readonly customerName: string;
  readonly customerPhone: string | null;
  readonly customerGuardianName: string | null;
  readonly customerAddress: string | null;
  readonly locationId: string;
  readonly dueDate: string | null;
  readonly itemsTotalMinor: number;
  readonly discountMinor: number;
  readonly grandTotalMinor: number;
  readonly cogsMinor: number;
  readonly paidMinor: number;
  /** The open day the drawer took cash on, when it did (§5.16.1). */
  readonly sessionId: string | null;
  readonly notes: string | null;
  readonly businessDate: string;
  readonly entryMode: 'ON_TIME' | 'LATE_ENTRY' | 'BACKDATED' | 'CORRECTED';
  readonly journalEntryId: string;
  readonly journalLines: readonly NewJournalLine[];
  readonly lines: readonly NewSaleLine[];
  readonly payments: readonly NewSalePayment[];
}

export interface SaleLineRow {
  readonly id: string;
  readonly productId: string;
  readonly productName: string;
  readonly displayName: string | null;
  readonly unitName: string;
  readonly locationId: string;
  readonly qty: number;
  readonly unitPriceMinor: number;
  readonly lineDiscountMinor: number;
  readonly lineTotalMinor: number;
  readonly discountShareMinor: number;
  readonly netAmountMinor: number;
  readonly costMinor: number;
  readonly source: 'OWN_STOCK' | 'VENDOR_CONSIGNMENT';
  readonly vendorPartyId: string | null;
  readonly vendorName: string | null;
  readonly isProvisionalCost: boolean;
  readonly tracksSerial: boolean;
  readonly allocations: readonly {
    readonly id: string;
    readonly sourceType: 'OWNED' | 'VENDOR' | 'NEGATIVE';
    readonly qty: number;
    readonly ownedLotId: string | null;
    readonly vendorPartyId: string | null;
    readonly vendorStockReceiptId: string | null;
    readonly vendorLotId: string | null;
    readonly inventoryUnitId: string | null;
    readonly serialNo: string | null;
    readonly unitCostUsed: number | null;
  }[];
}

export interface SalePaymentRow {
  readonly id: string;
  readonly accountCode: string;
  readonly accountName: string;
  readonly accountType: 'CASH' | 'BANK';
  readonly amountMinor: number;
}

export interface SaleReceiptRow {
  readonly id: string;
  readonly number: string;
  readonly businessDate: string;
  readonly accountName: string;
  readonly amountMinor: number;
}

export interface InvoicePresentationRow {
  readonly customerDisplayName: string | null;
  readonly customerPhone: string | null;
  readonly customerGuardianName: string | null;
  readonly customerAddress: string | null;
  readonly deliveryAddress: string | null;
  readonly courierName: string | null;
  readonly deliveryInstruction: string | null;
  readonly paymentNote: string | null;
  readonly customLabel1: string | null;
  readonly customValue1: string | null;
  readonly customLabel2: string | null;
  readonly customValue2: string | null;
  readonly customLabel3: string | null;
  readonly customValue3: string | null;
  readonly lineNames: readonly { readonly saleLineId: string; readonly displayName: string }[];
}

export interface SaleRow {
  readonly id: string;
  readonly number: string;
  readonly partyId: string;
  readonly isWalkIn: boolean;
  readonly customerName: string;
  readonly customerPhone: string | null;
  readonly customerGuardianName: string | null;
  readonly customerAddress: string | null;
  readonly businessDate: string;
  readonly dueDate: string | null;
  readonly status: 'POSTED' | 'VOIDED';
  readonly notes: string | null;
  readonly itemsTotalMinor: number;
  readonly discountMinor: number;
  readonly grandTotalMinor: number;
  readonly cogsMinor: number;
  /** Taken at the counter plus everything allocated since — never stored. */
  readonly paidMinor: number;
  readonly dueMinor: number;
  readonly createdAt: Date;
  /** Phase 12.4 (§18) — where it was typed, and by which machine. */
  readonly originMode: 'ONLINE' | 'OFFLINE';
  readonly originDeviceName: string | null;
  readonly originDeviceCode: string | null;
  readonly deviceCreatedAt: Date | null;
}

export interface SaleDetail extends SaleRow {
  readonly lines: readonly SaleLineRow[];
  readonly payments: readonly SalePaymentRow[];
  readonly receipts: readonly SaleReceiptRow[];
  readonly presentation: InvoicePresentationRow | null;
  /**
   * What this sale posted, as it posted it — read back rather than recomputed
   * so a cancellation reverses the entry that actually exists (§2.5). Costs
   * move over time; an entry rebuilt from today's lots would not cancel out.
   */
  readonly journalLines: readonly {
    readonly account: string;
    readonly amountMinor: number;
    readonly partyId: string | null;
  }[];
  /** Which lots each line took stock from, for putting the goods back. */
  readonly consumptions: readonly {
    readonly saleLineId: string;
    readonly lotId: string;
    readonly qty: number;
    readonly unitCostUsed: number;
  }[];
  readonly version: number;
}

export interface SaleFilter {
  readonly search: string | null;
  readonly partyId: string | null;
  readonly fromDate: string | null;
  readonly toDate: string | null;
  readonly unpaidOnly: boolean;
  /** Phase 12.4 (§18). Absent means every invoice, whatever the line was doing. */
  readonly origin?: 'ALL' | 'ONLINE' | 'OFFLINE' | undefined;
  readonly cursor: string | null;
  readonly limit: number;
}

export interface SaleTotalsRow {
  readonly salesMinor: number;
  readonly receivedMinor: number;
  readonly dueMinor: number;
  readonly invoiceCount: number;
}

/** One invoice with money still on it, oldest first (§5.8 allocation). */
export interface OpenInvoiceRow {
  readonly id: string;
  readonly number: string;
  readonly businessDate: string;
  readonly dueDate: string | null;
  readonly grandTotalMinor: number;
  readonly outstandingMinor: number;
}

export interface NewCustomerReceipt {
  readonly id: string;
  readonly number: string;
  readonly operationId: string;
  readonly customerPartyId: string;
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
    readonly saleId: string;
    readonly amountMinor: number;
  }[];
}

export interface CustomerReceiptRow {
  readonly id: string;
  readonly number: string;
  readonly customerPartyId: string;
  readonly customerName: string;
  readonly accountCode: string;
  readonly accountName: string;
  readonly amountMinor: number;
  readonly settledMinor: number;
  readonly advanceMinor: number;
  readonly businessDate: string;
  readonly note: string | null;
  readonly allocations: readonly {
    readonly saleId: string;
    readonly saleNumber: string;
    readonly amountMinor: number;
  }[];
  /** Phase 9.2: what a correction and a cancellation need (D-32), and what they leave. */
  readonly status: 'POSTED' | 'VOIDED';
  readonly entryMode: string;
  readonly voidReason: string | null;
  readonly version: number;
}

/** A customer's standing, read from the journal (INV-06), never from invoices. */
export interface CustomerStandingRow {
  readonly dueMinor: number;
  readonly advanceMinor: number;
}

export interface PosProductRow {
  readonly id: string;
  readonly name: string;
  readonly sku: string | null;
  readonly barcode: string | null;
  readonly brandName: string | null;
  readonly categoryName: string | null;
  readonly unitName: string;
  readonly sellingPriceMinor: number;
  readonly purchasePriceMinor: number;
  readonly groupPriceMinor: number | null;
  /** Net owned position, which may be negative. */
  readonly qtyOnHand: number;
  /** Physical, sellable OWNED lots; distinct from the net owned position. */
  readonly sellableOwnedQty: number;
  readonly minStockQty: number;
  readonly hasImage: boolean;
  /** The precomputed line the search matches and ranks against (0026). */
  readonly searchText: string;
  readonly tracksExpiry: boolean;
  readonly tracksSerial: boolean;
}

export interface PosProductFilter {
  /**
   * The business date expired batches stop counting on, or null when they
   * still count (Phase 7.2, owner decision 2026-08-26).
   *
   * Under BLOCK the tile has to show what the cashier can actually sell: three
   * of five expired means the number is two, and a cashier promising five to a
   * customer must not find out at the cart.
   */
  readonly expiredOn: string | null;
  readonly search: string | null;
  readonly barcode: string | null;
  readonly categoryId: string | null;
  readonly brandId: string | null;
  readonly customerGroupId: string | null;
  readonly cursor: string | null;
  readonly limit: number;
}

export interface InvoiceSettingsRow {
  readonly language: 'EN' | 'BN';
  readonly defaultTemplate: 'A4' | 'THERMAL_80';
  readonly showLogo: boolean;
  readonly showBusinessBlock: boolean;
  readonly showCustomerBlock: boolean;
  readonly showSku: boolean;
  readonly showBarcode: boolean;
  readonly showDiscount: boolean;
  readonly showPaymentBreakdown: boolean;
  readonly showDue: boolean;
  readonly showAmountInWords: boolean;
  readonly headerText: string | null;
  readonly showHeaderText: boolean;
  readonly invoiceTitle: string | null;
  readonly businessNameEn: string | null;
  readonly proprietorName: string | null;
  readonly proprietorNote: string | null;
  readonly businessDescription: string | null;
  readonly businessPhone2: string | null;
  readonly contactPhones: { label: string; number: string }[];
  readonly mfsNumbers: { label: string; number: string }[];
  readonly terms: string[];
  readonly paymentTermsDays: number;
  readonly paymentTermsLabel: string | null;
  readonly thermalPaper: '58mm' | '80mm';
  readonly showSignatureLines: boolean;
  readonly hasLogo: boolean;
  readonly businessName: string | null;
  readonly businessAddress: string | null;
  readonly businessPhone: string | null;
  readonly footerText: string | null;
  readonly termsText: string | null;
  readonly businessPadEnabled: boolean;
  readonly businessPadTopMm: number;
  readonly pageMarginMm: number;
}

export interface NewQuotation {
  readonly id: string;
  readonly kind: 'QUOTATION' | 'ORDER';
  readonly number: string;
  readonly operationId: string;
  readonly partyId: string | null;
  readonly customerName: string;
  readonly customerPhone: string | null;
  readonly validUntil: string | null;
  readonly itemsTotalMinor: number;
  readonly discountMinor: number;
  readonly grandTotalMinor: number;
  readonly notes: string | null;
  readonly businessDate: string;
  readonly sourceQuotationId: string | null;
  readonly lines: readonly {
    readonly id: string;
    readonly lineNo: number;
    readonly productId: string;
    readonly qty: number;
    readonly unitPriceMinor: number;
    readonly lineDiscountMinor: number;
    readonly lineTotalMinor: number;
  }[];
}

export interface QuotationRow {
  readonly id: string;
  readonly kind: 'QUOTATION' | 'ORDER';
  readonly number: string;
  readonly partyId: string | null;
  readonly customerName: string;
  readonly customerPhone: string | null;
  readonly validUntil: string | null;
  readonly businessDate: string;
  readonly status: string;
  readonly itemsTotalMinor: number;
  readonly discountMinor: number;
  readonly grandTotalMinor: number;
  readonly notes: string | null;
  readonly lines: readonly {
    readonly id: string;
    readonly productId: string;
    readonly productName: string;
    readonly unitName: string;
    readonly qty: number;
    readonly unitPriceMinor: number;
    readonly lineDiscountMinor: number;
    readonly lineTotalMinor: number;
    readonly qtyConverted: number;
  }[];
}

/**
 * Cancelling a posted sale (§2.5): the goods come back and the money is undone.
 *
 * Nothing is deleted and nothing is rewritten. The original document, its
 * lines, its movements and its journal entry stay exactly where they are; this
 * writes the opposite of each and marks the sale `VOIDED`, so a shopkeeper
 * asking "what happened to invoice 214" can see both halves.
 */
export interface SaleReversal {
  readonly saleId: string;
  readonly expectedVersion: number;
  readonly businessDate: string;
  readonly entryMode: 'ON_TIME' | 'LATE_ENTRY' | 'BACKDATED' | 'CORRECTED';
  readonly journalEntryId: string;
  readonly journalLines: readonly NewJournalLine[];
  /** One IN movement per original line, putting the goods back on the shelf. */
  readonly movements: readonly {
    readonly id: string;
    readonly saleLineId: string;
    readonly productId: string;
    readonly locationId: string;
    readonly qty: number;
    readonly unitCost: number;
  }[];
  /** Quantity returned to each lot it came out of, reopening a closed one. */
  readonly restorations: readonly {
    readonly lotId: string;
    readonly qty: number;
  }[];
  /** Vendor-owned quantity returns only to the exact recorded consignment lot. */
  readonly vendorRestorations: readonly { readonly lotId: string; readonly qty: number }[];
  /** Append-only reversal facts; source allocation rows remain immutable. */
  readonly allocationReversals: readonly {
    readonly id: string;
    readonly sourceAllocationId: string;
    readonly qty: number;
  }[];
  readonly serialUnitIds: readonly string[];
  readonly costStates: readonly {
    readonly id: string;
    readonly exists: boolean;
    readonly productId: string;
    readonly locationId: string;
    readonly avgUnitCost: number;
    readonly qtyOnHand: number;
  }[];
}

export interface NewSaleDraft {
  readonly id: string;
  readonly label: string;
  readonly customerName: string | null;
  readonly itemCount: number;
  readonly grandTotalMinor: number;
  readonly cart: Record<string, unknown>;
  readonly businessDate: string;
}

export interface SaleDraftRow extends NewSaleDraft {
  readonly savedAt: Date;
}

/**
 * A corrected receipt, re-posted under its own number (Phase 9.2).
 *
 * The row is updated in place, the allocations are written again — the
 * reversal released the old ones — and a `CUSTOMER_RECEIPT_CORRECTION` entry
 * carries the new figures. All three facts stay in the journal (§2.5).
 */
export interface RepostCustomerReceipt {
  readonly id: string;
  readonly expectedVersion: number;
  readonly customerPartyId: string;
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
    readonly saleId: string;
    readonly amountMinor: number;
  }[];
}

export interface SaleRepository {
  lockSale(tx: Tx, ctx: TenantContext, saleId: string): Promise<boolean>;
  /** Serializes receivable allocation for one party inside the caller's transaction. */
  lockReceivableParty(tx: Tx, ctx: TenantContext, partyId: string): Promise<boolean>;
  findSaleIdByOperationId(tx: Tx, ctx: TenantContext, operationId: string): Promise<string | null>;
  insertSale(tx: Tx, ctx: TenantContext, sale: NewSale): Promise<void>;
  findSaleById(tx: Tx, ctx: TenantContext, id: string): Promise<SaleDetail | null>;
  cancellationBlocker(
    tx: Tx,
    ctx: TenantContext,
    id: string,
  ): Promise<'POSTED_RETURN' | 'VENDOR_SETTLEMENT' | null>;
  listSales(tx: Tx, ctx: TenantContext, filter: SaleFilter): Promise<readonly SaleRow[]>;
  totals(tx: Tx, ctx: TenantContext, filter: SaleFilter): Promise<SaleTotalsRow>;
  /** Marks a sale voided; the reversal entry is written by the caller. */
  reverseSale(tx: Tx, ctx: TenantContext, reversal: SaleReversal): Promise<boolean>;

  listOpenInvoices(
    tx: Tx,
    ctx: TenantContext,
    partyId: string,
    saleIds: readonly string[],
  ): Promise<readonly OpenInvoiceRow[]>;
  customerStanding(tx: Tx, ctx: TenantContext, partyId: string): Promise<CustomerStandingRow>;

  findReceiptIdByOperationId(tx: Tx, ctx: TenantContext, operationId: string): Promise<string | null>;
  insertReceipt(tx: Tx, ctx: TenantContext, receipt: NewCustomerReceipt): Promise<void>;
  /** Returns false when somebody else changed the receipt first (D-32). */
  repostReceipt(tx: Tx, ctx: TenantContext, receipt: RepostCustomerReceipt): Promise<boolean>;
  findReceiptById(tx: Tx, ctx: TenantContext, id: string): Promise<CustomerReceiptRow | null>;

  listPosProducts(
    tx: Tx,
    ctx: TenantContext,
    filter: PosProductFilter,
  ): Promise<readonly PosProductRow[]>;

  findPresentation(tx: Tx, ctx: TenantContext, saleId: string): Promise<InvoicePresentationRow | null>;
  savePresentation(
    tx: Tx,
    ctx: TenantContext,
    saleId: string,
    presentation: InvoicePresentationRow,
  ): Promise<void>;

  findInvoiceSettings(tx: Tx, ctx: TenantContext): Promise<InvoiceSettingsRow | null>;
  /** The logo bytes, served as an image rather than carried in the settings. */
  findInvoiceLogo(
    tx: Tx,
    ctx: TenantContext,
  ): Promise<{ readonly mime: string; readonly bytes: Uint8Array } | null>;
  saveInvoiceLogo(
    tx: Tx,
    ctx: TenantContext,
    logo: { readonly mime: string; readonly bytes: Uint8Array } | null,
  ): Promise<void>;
  saveInvoiceSettings(tx: Tx, ctx: TenantContext, settings: InvoiceSettingsRow): Promise<void>;

  /** A parked cart — not a document, and deletable outright (§5.7). */
  listDrafts(tx: Tx, ctx: TenantContext, limit: number): Promise<readonly SaleDraftRow[]>;
  saveDraft(tx: Tx, ctx: TenantContext, draft: NewSaleDraft): Promise<void>;
  deleteDraft(tx: Tx, ctx: TenantContext, id: string): Promise<void>;

  insertQuotation(tx: Tx, ctx: TenantContext, quotation: NewQuotation): Promise<void>;
  findQuotationById(
    tx: Tx,
    ctx: TenantContext,
    kind: 'QUOTATION' | 'ORDER',
    id: string,
  ): Promise<QuotationRow | null>;
  listQuotations(
    tx: Tx,
    ctx: TenantContext,
    kind: 'QUOTATION' | 'ORDER',
    limit: number,
  ): Promise<readonly QuotationRow[]>;
  markQuotationConverted(
    tx: Tx,
    ctx: TenantContext,
    kind: 'QUOTATION' | 'ORDER',
    id: string,
  ): Promise<void>;
}
