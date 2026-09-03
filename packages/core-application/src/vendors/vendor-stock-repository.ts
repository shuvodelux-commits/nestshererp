import type { TenantContext } from '../ports/tenant-context';
import type { Tx } from '../ports/unit-of-work';

/** Goods held for a vendor (§5.6 M07, DR13.10, Phase 8). */

export interface NewVendorReceipt {
  readonly id: string;
  readonly receiptNumber: string;
  readonly vendorPartyId: string;
  readonly productId: string;
  readonly locationId: string;
  readonly qty: number;
  /** Scale 4 — what the vendor is owed per unit when one sells. */
  readonly vendorUnitCost: number;
  readonly lotId: string;
  readonly movementId: string;
  readonly note: string | null;
  readonly businessDate: string;
  readonly expiryDate: string | null;
  readonly operationId: string;
}

export interface NewVendorReturn {
  readonly id: string;
  readonly returnNumber: string;
  readonly receiptId: string;
  readonly vendorPartyId: string;
  readonly productId: string;
  readonly locationId: string;
  readonly qty: number;
  readonly lotId: string;
  readonly movementId: string;
  readonly note: string | null;
  readonly businessDate: string;
  readonly operationId: string;
}

export interface VendorReceiptRow {
  readonly id: string;
  readonly receiptNumber: string;
  readonly vendorPartyId: string;
  readonly vendorName: string;
  readonly productId: string;
  readonly displayName: string;
  readonly unitName: string;
  readonly businessDate: string;
  readonly expiryDate: string | null;
  readonly note: string | null;
  readonly qty: number;
  readonly vendorUnitCost: number;
  readonly lotId: string;
  readonly locationId: string;
  /** What is left of the lot this receipt created. */
  readonly lotQtyRemaining: number;
  readonly returnedQty: number;
  readonly version: number;
}

export interface VendorStockRepository {
  insertReceipt(tx: Tx, ctx: TenantContext, receipt: NewVendorReceipt): Promise<void>;

  insertReturn(
    tx: Tx,
    ctx: TenantContext,
    record: NewVendorReturn,
  ): Promise<void>;

  findReceipt(tx: Tx, ctx: TenantContext, receiptId: string): Promise<VendorReceiptRow | null>;

  listReceipts(
    tx: Tx,
    ctx: TenantContext,
    options: { readonly vendorPartyId?: string | undefined; readonly limit: number },
  ): Promise<readonly VendorReceiptRow[]>;

  /** Recorded sellable stock for one vendor/product, FIFO/FEFO order. */
  listSellableLots(
    tx: Tx,
    ctx: TenantContext,
    vendorPartyId: string,
    productId: string,
  ): Promise<readonly VendorReceiptRow[]>;

  findReceiptByOperationId(
    tx: Tx,
    ctx: TenantContext,
    operationId: string,
  ): Promise<string | null>;

  /** What selling this vendor's goods has made the shop owe, from the journal. */
  vendorLedgerTotals(
    tx: Tx,
    ctx: TenantContext,
    vendorPartyId: string,
  ): Promise<{ readonly dueMinor: number; readonly paidMinor: number }>;
}
