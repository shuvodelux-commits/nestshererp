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
  readonly soldDate: string | null;
  readonly supplierPartyId: string | null;
  readonly supplierName: string | null;
  readonly customerPartyId: string | null;
  readonly customerName: string | null;
  readonly saleId: string | null;
  readonly invoiceNumber: string | null;
  readonly purchaseId: string | null;
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

  /** In-stock units of one product, for choosing what to sell or hand over. */
  listAvailable(
    tx: Tx,
    ctx: TenantContext,
    productId: string,
    limit: number,
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
  ): Promise<void>;

  setStatus(
    tx: Tx,
    ctx: TenantContext,
    unitId: string,
    status: 'IN_STOCK' | 'SOLD' | 'WITH_SUPPLIER' | 'WRITTEN_OFF',
  ): Promise<void>;
}
