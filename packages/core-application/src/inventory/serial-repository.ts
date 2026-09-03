import type { SerialUnitStatus } from '@sher/core-domain';

import type { TenantContext } from '../ports/tenant-context';
import type { Tx } from '../ports/unit-of-work';

/** Serialised units: one row per physical item (§5.19, D-18, Phase 8). */

export interface NewSerialUnit {
  readonly id: string;
  readonly productId: string;
  readonly serialNo: string;
  readonly lotId: string | null;
  readonly purchaseId: string | null;
  readonly purchaseLineId: string | null;
  readonly supplierPartyId: string | null;
  readonly vendorPartyId: string | null;
  readonly vendorStockReceiptId: string | null;
  readonly vendorLotId: string | null;
  readonly receivedDate: string;
  readonly expiryDate: string | null;
  readonly supplierWarrantyMonths: number | null;
}

export interface SerialLineRow {
  readonly purchaseLineId: string;
  readonly purchaseId: string;
  readonly productId: string;
  readonly displayName: string;
  readonly tracksSerial: boolean;
  readonly qty: number;
  readonly lotId: string;
  readonly expiryDate: string | null;
  readonly supplierPartyId: string;
  readonly businessDate: string;
  readonly supplierWarrantyMonths: number | null;
  readonly recorded: number;
  readonly serials: readonly string[];
}

export interface SerialUnitRow {
  readonly id: string;
  readonly serialNo: string;
  readonly productId: string;
  readonly displayName: string;
  readonly status: string;
  readonly receivedDate: string;
  readonly expiryDate: string | null;
  readonly soldDate: string | null;
  readonly supplierPartyId: string | null;
  readonly supplierName: string | null;
  readonly customerPartyId: string | null;
  readonly customerName: string | null;
  readonly saleId: string | null;
  readonly invoiceNumber: string | null;
  readonly purchaseId: string | null;
  readonly lotId: string | null;
  readonly vendorPartyId: string | null;
  readonly vendorStockReceiptId: string | null;
  readonly vendorLotId: string | null;
  readonly customerWarrantyMonths: number | null;
  readonly supplierWarrantyMonths: number | null;
}

export interface SerialRepository {
  findPurchaseLineForSerials(
    tx: Tx,
    ctx: TenantContext,
    purchaseLineId: string,
  ): Promise<SerialLineRow | null>;

  listPurchaseLinesForSerials(
    tx: Tx,
    ctx: TenantContext,
    purchaseId: string,
  ): Promise<readonly SerialLineRow[]>;

  /** Active duplicates only (D-18): a sold or written-off unit releases its number. */
  findActiveSerials(
    tx: Tx,
    ctx: TenantContext,
    productId: string,
    serials: readonly string[],
  ): Promise<readonly string[]>;

  insertSerialUnits(tx: Tx, ctx: TenantContext, units: readonly NewSerialUnit[]): Promise<void>;

  findBySerial(tx: Tx, ctx: TenantContext, serial: string): Promise<SerialUnitRow | null>;

  findById(tx: Tx, ctx: TenantContext, unitId: string): Promise<SerialUnitRow | null>;

  listByPhoneOrInvoice(
    tx: Tx,
    ctx: TenantContext,
    input: { readonly phone?: string | undefined; readonly invoiceNumber?: string | undefined },
  ): Promise<readonly SerialUnitRow[]>;

  /**
   * In-stock units of one product, for choosing what to sell or hand over.
   *
   * `expiredOn` is the business date an **owned** batch must still be good on
   * (§5.13, BLOCK); null switches the cut-off off entirely. Consignment units
   * are never cut off by it — an expired vendor lot is sellable, and it is
   * precisely what a shop hands back to its vendor (§5.6 M07).
   */
  listAvailable(
    tx: Tx,
    ctx: TenantContext,
    productId: string,
    limit: number,
    expiredOn: string | null,
  ): Promise<readonly SerialUnitRow[]>;

  findAvailableByIds(
    tx: Tx,
    ctx: TenantContext,
    productId: string,
    unitIds: readonly string[],
  ): Promise<readonly SerialUnitRow[]>;

  /**
   * How many units of a product have no serial yet.
   *
   * A serial-tracked product may not be sold without one (§5.19), and a bill
   * saved before the stickers were read leaves exactly this gap — the units are
   * on the shelf but not sellable until somebody types them in.
   */
  countUnserialised(tx: Tx, ctx: TenantContext, productId: string): Promise<number>;

  markSold(
    tx: Tx,
    ctx: TenantContext,
    input: {
      readonly unitIds: readonly string[];
      readonly saleId: string;
      readonly saleLineId: string;
      readonly customerPartyId: string | null;
      readonly soldDate: string;
      readonly customerWarrantyMonths: number | null;
    },
  ): Promise<number>;

  markReturnedToVendor(
    tx: Tx,
    ctx: TenantContext,
    input: {
      readonly unitIds: readonly string[];
      readonly vendorStockReceiptId: string;
      readonly vendorLotId: string;
    },
  ): Promise<number>;

  /**
   * Move a unit to a status that carries no extra facts of its own.
   *
   * This writes `status` and nothing else, so `SOLD` is only legal here for a
   * unit that **already** names the sale that took it and the day it went —
   * restoring one that came back from the supplier, say. A unit that has never
   * been sold cannot be made `SOLD` this way without breaking
   * `inventory_units_sold_has_sale` (migration 0033); giving one away to settle
   * a warranty claim is `WARRANTY_REPLACEMENT`, and selling one is `markSold`.
   */
  setStatus(
    tx: Tx,
    ctx: TenantContext,
    unitId: string,
    status: SerialUnitStatus,
  ): Promise<void>;
}
