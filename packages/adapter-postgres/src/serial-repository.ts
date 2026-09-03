import type {
  NewSerialUnit,
  SerialLineRow,
  SerialRepository,
  SerialUnitRow,
  TenantContext,
  Tx,
} from '@sher/core-application';
import type { SerialUnitStatus } from '@sher/core-domain';
import type { Clock } from '@sher/shared-utils';
import { and, eq, inArray, sql } from 'drizzle-orm';

import { inventoryUnits } from './schema';
import { txOf } from './unit-of-work';

/**
 * Serialised units over PostgreSQL (§5.19, D-18, Phase 8).
 *
 * The one rule this file does enforce is D-18's, and only because it is an
 * index: a serial may exist once among **active** units of a product. A sold or
 * written-off unit releases its number, which is a manufacturer reusing one
 * years later rather than the shop making the same mistake twice.
 */

/** Only these statuses hold a serial against reuse (D-18). */
const ACTIVE = sql`('IN_STOCK', 'WITH_SUPPLIER')`;

interface RawUnit extends Record<string, unknown> {
  id: string;
  serial_no: string;
  product_id: string;
  display_name: string;
  status: string;
  received_date: string;
  expiry_date: string | null;
  sold_date: string | null;
  supplier_party_id: string | null;
  supplier_name: string | null;
  customer_party_id: string | null;
  customer_name: string | null;
  sale_id: string | null;
  invoice_number: string | null;
  purchase_id: string | null;
  lot_id: string | null;
  vendor_party_id: string | null;
  vendor_stock_receipt_id: string | null;
  vendor_lot_id: string | null;
  customer_warranty_months: number | null;
  supplier_warranty_months: number | null;
}

/** The one shape every unit read comes back in, so five queries cannot disagree. */
const UNIT_SELECT = sql`
  SELECT iu.id, iu.serial_no, iu.product_id,
         CASE WHEN b.name IS NULL OR b.name = '' THEN p.name
              ELSE b.name || ' ' || p.name END AS display_name,
         iu.status, iu.received_date::text, iu.expiry_date::text, iu.sold_date::text,
         iu.supplier_party_id, sup.name AS supplier_name,
         iu.customer_party_id, cus.name AS customer_name,
         iu.sale_id, s.sale_number AS invoice_number, iu.purchase_id, iu.lot_id,
         iu.vendor_party_id, iu.vendor_stock_receipt_id, iu.vendor_lot_id,
         iu.customer_warranty_months, iu.supplier_warranty_months
    FROM inventory_units iu
    JOIN products p ON p.id = iu.product_id AND p.tenant_id = iu.tenant_id
    LEFT JOIN brands b ON b.id = p.brand_id AND b.tenant_id = p.tenant_id
    LEFT JOIN parties sup ON sup.id = iu.supplier_party_id AND sup.tenant_id = iu.tenant_id
    LEFT JOIN parties cus ON cus.id = iu.customer_party_id AND cus.tenant_id = iu.tenant_id
    LEFT JOIN sales s ON s.id = iu.sale_id AND s.tenant_id = iu.tenant_id
`;

function toUnit(row: RawUnit): SerialUnitRow {
  return {
    id: row.id,
    serialNo: row.serial_no,
    productId: row.product_id,
    displayName: row.display_name,
    status: row.status,
    receivedDate: row.received_date,
    expiryDate: row.expiry_date,
    soldDate: row.sold_date,
    supplierPartyId: row.supplier_party_id,
    supplierName: row.supplier_name,
    customerPartyId: row.customer_party_id,
    customerName: row.customer_name,
    saleId: row.sale_id,
    invoiceNumber: row.invoice_number,
    purchaseId: row.purchase_id,
    lotId: row.lot_id,
    vendorPartyId: row.vendor_party_id,
    vendorStockReceiptId: row.vendor_stock_receipt_id,
    vendorLotId: row.vendor_lot_id,
    customerWarrantyMonths: row.customer_warranty_months,
    supplierWarrantyMonths: row.supplier_warranty_months,
  };
}

interface RawLine extends Record<string, unknown> {
  purchase_line_id: string;
  purchase_id: string;
  product_id: string;
  display_name: string;
  tracks_serial: boolean;
  qty: string;
  lot_id: string;
  expiry_date: string | null;
  supplier_party_id: string;
  business_date: string;
  supplier_warranty_months: number | null;
  recorded: string;
  serials: string[] | null;
}

/**
 * A bill line and the serials it has so far.
 *
 * The supplier warranty falls back through the delivery's own override to the
 * product's usual terms (owner decision 2026-08-26): a line that came on
 * different terms says so, and one that did not inherits.
 */
const LINE_SELECT = sql`
  SELECT pl.id AS purchase_line_id, pl.purchase_id, pl.product_id,
         CASE WHEN b.name IS NULL OR b.name = '' THEN p.name
              ELSE b.name || ' ' || p.name END AS display_name,
         p.tracks_serial, pl.qty::text, pl.lot_id, il.expiry_date::text,
         pu.supplier_party_id, pu.business_date::text,
         COALESCE(pl.supplier_warranty_months, p.supplier_warranty_months) AS supplier_warranty_months,
         COALESCE(units.recorded, 0)::text AS recorded,
         units.serials
    FROM purchase_lines pl
    JOIN purchases pu ON pu.id = pl.purchase_id AND pu.tenant_id = pl.tenant_id
    JOIN products p ON p.id = pl.product_id AND p.tenant_id = pl.tenant_id
    JOIN inventory_lots il ON il.id = pl.lot_id AND il.tenant_id = pl.tenant_id
    LEFT JOIN brands b ON b.id = p.brand_id AND b.tenant_id = p.tenant_id
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS recorded, ARRAY_AGG(iu.serial_no ORDER BY iu.created_at) AS serials
        FROM inventory_units iu
       WHERE iu.tenant_id = pl.tenant_id AND iu.purchase_line_id = pl.id
    ) units ON TRUE
`;

function toLine(row: RawLine): SerialLineRow {
  return {
    purchaseLineId: row.purchase_line_id,
    purchaseId: row.purchase_id,
    productId: row.product_id,
    displayName: row.display_name,
    tracksSerial: row.tracks_serial,
    qty: Number(row.qty),
    lotId: row.lot_id,
    expiryDate: row.expiry_date,
    supplierPartyId: row.supplier_party_id,
    businessDate: row.business_date,
    supplierWarrantyMonths: row.supplier_warranty_months,
    recorded: Number(row.recorded),
    serials: row.serials ?? [],
  };
}

export class PostgresSerialRepository implements SerialRepository {
  constructor(private readonly clock: Clock) {}

  async findPurchaseLineForSerials(
    tx: Tx,
    ctx: TenantContext,
    purchaseLineId: string,
  ): Promise<SerialLineRow | null> {
    const rows = await txOf(tx).execute<RawLine>(sql`
      ${LINE_SELECT}
       WHERE pl.tenant_id = ${ctx.tenantId} AND pl.id = ${purchaseLineId}
       LIMIT 1
    `);
    const row = rows.rows[0];
    return row === undefined ? null : toLine(row);
  }

  async listPurchaseLinesForSerials(
    tx: Tx,
    ctx: TenantContext,
    purchaseId: string,
  ): Promise<readonly SerialLineRow[]> {
    const rows = await txOf(tx).execute<RawLine>(sql`
      ${LINE_SELECT}
       WHERE pl.tenant_id = ${ctx.tenantId} AND pl.purchase_id = ${purchaseId}
       ORDER BY pl.line_no ASC
    `);
    return rows.rows.map(toLine);
  }

  async findActiveSerials(
    tx: Tx,
    ctx: TenantContext,
    productId: string,
    serials: readonly string[],
  ): Promise<readonly string[]> {
    if (serials.length === 0) return [];

    const rows = await txOf(tx).execute<{ serial_no: string }>(sql`
      SELECT serial_no FROM inventory_units
       WHERE tenant_id = ${ctx.tenantId}
         AND product_id = ${productId}
         AND status IN ${ACTIVE}
         AND serial_no IN (${sql.join(
           serials.map((serial) => sql`${serial}`),
           sql`, `,
         )})
    `);
    return rows.rows.map((row) => row.serial_no);
  }

  async insertSerialUnits(
    tx: Tx,
    ctx: TenantContext,
    units: readonly NewSerialUnit[],
  ): Promise<void> {
    if (units.length === 0) return;
    const now = this.clock.now();

    await txOf(tx)
      .insert(inventoryUnits)
      .values(
        units.map((unit) => ({
          id: unit.id,
          tenantId: ctx.tenantId,
          productId: unit.productId,
          serialNo: unit.serialNo,
          lotId: unit.lotId,
          purchaseId: unit.purchaseId,
          purchaseLineId: unit.purchaseLineId,
          supplierPartyId: unit.supplierPartyId,
          vendorPartyId: unit.vendorPartyId,
          vendorStockReceiptId: unit.vendorStockReceiptId,
          vendorLotId: unit.vendorLotId,
          receivedDate: unit.receivedDate,
          expiryDate: unit.expiryDate,
          supplierWarrantyMonths: unit.supplierWarrantyMonths,
          saleId: null,
          saleLineId: null,
          customerPartyId: null,
          soldDate: null,
          customerWarrantyMonths: null,
          status: 'IN_STOCK',
          createdAt: now,
          updatedAt: now,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
          version: 1,
        })),
      );
  }

  async findBySerial(
    tx: Tx,
    ctx: TenantContext,
    serial: string,
  ): Promise<SerialUnitRow | null> {
    const rows = await txOf(tx).execute<RawUnit>(sql`
      ${UNIT_SELECT}
       WHERE iu.tenant_id = ${ctx.tenantId}
         AND UPPER(iu.serial_no) = UPPER(${serial})
       ORDER BY iu.created_at DESC
       LIMIT 1
    `);
    const row = rows.rows[0];
    return row === undefined ? null : toUnit(row);
  }

  async findById(tx: Tx, ctx: TenantContext, unitId: string): Promise<SerialUnitRow | null> {
    const rows = await txOf(tx).execute<RawUnit>(sql`
      ${UNIT_SELECT}
       WHERE iu.tenant_id = ${ctx.tenantId} AND iu.id = ${unitId}
       LIMIT 1
    `);
    const row = rows.rows[0];
    return row === undefined ? null : toUnit(row);
  }

  async listByPhoneOrInvoice(
    tx: Tx,
    ctx: TenantContext,
    input: { readonly phone?: string | undefined; readonly invoiceNumber?: string | undefined },
  ): Promise<readonly SerialUnitRow[]> {
    const phone = input.phone?.trim() ?? '';
    const invoice = input.invoiceNumber?.trim() ?? '';
    if (phone === '' && invoice === '') return [];

    /*
     * The invoice's own phone snapshot is searched as well as the customer
     * record's, because §5.8 lets a fully paid walk-in create no party at all —
     * and that customer still comes back with a faulty item.
     */
    const byPhone =
      phone === ''
        ? sql`FALSE`
        : sql`(cus.phone = ${phone} OR s.customer_phone_snapshot = ${phone})`;
    const byInvoice = invoice === '' ? sql`FALSE` : sql`s.sale_number = ${invoice}`;

    const rows = await txOf(tx).execute<RawUnit>(sql`
      ${UNIT_SELECT}
       WHERE iu.tenant_id = ${ctx.tenantId}
         AND iu.sale_id IS NOT NULL
         AND (${byPhone} OR ${byInvoice})
       ORDER BY iu.sold_date DESC NULLS LAST, iu.id DESC
       LIMIT 50
    `);
    return rows.rows.map(toUnit);
  }

  async listAvailable(
    tx: Tx,
    ctx: TenantContext,
    productId: string,
    limit: number,
    expiredOn: string | null,
  ): Promise<readonly SerialUnitRow[]> {
    /*
     * The expiry cut-off is a rule about **selling the shop's own batches**
     * (§5.13): under BLOCK an expired owned batch stops being sellable stock,
     * so the picker passes over it. It was never a rule about consignment —
     * `listSellableLots` applies no expiry test at all, so an expired vendor
     * lot is sold exactly as any other is — and applying it here anyway hid the
     * one thing a shop most wants to do with expired consignment goods: hand
     * them back (§5.6 M07). The return dialog needs one serial per unit and the
     * server insists on it, so a filter that showed nothing refused the return
     * outright. Owned units are still cut off; nothing about selling changes.
     */
    const rows = await txOf(tx).execute<RawUnit>(sql`
      ${UNIT_SELECT}
       WHERE iu.tenant_id = ${ctx.tenantId}
         AND iu.product_id = ${productId}
         AND iu.status = 'IN_STOCK'
         AND (${expiredOn}::date IS NULL OR iu.vendor_lot_id IS NOT NULL
              OR iu.expiry_date IS NULL OR iu.expiry_date >= ${expiredOn}::date)
       ORDER BY iu.received_date ASC, iu.id ASC
       LIMIT ${limit}
    `);
    return rows.rows.map(toUnit);
  }

  async findAvailableByIds(
    tx: Tx,
    ctx: TenantContext,
    productId: string,
    unitIds: readonly string[],
  ): Promise<readonly SerialUnitRow[]> {
    if (unitIds.length === 0) return [];
    const rows = await txOf(tx).execute<RawUnit>(sql`
      ${UNIT_SELECT}
       WHERE iu.tenant_id = ${ctx.tenantId}
         AND iu.product_id = ${productId}
         AND iu.status = 'IN_STOCK'
         AND iu.id IN (${sql.join(unitIds.map((id) => sql`${id}`), sql`, `)})
       ORDER BY iu.received_date ASC, iu.id ASC
    `);
    return rows.rows.map(toUnit);
  }

  /**
   * Stock on the shelf that no serial has been typed for yet.
   *
   * The difference between what the lots say is there and how many units have
   * been recorded. Those are the ones that cannot be sold until somebody reads
   * the stickers (§5.19, owner decision 2026-08-26).
   */
  async countUnserialised(tx: Tx, ctx: TenantContext, productId: string): Promise<number> {
    const rows = await txOf(tx).execute<{ missing: string }>(sql`
      SELECT GREATEST(
               FLOOR(COALESCE((
                 SELECT SUM(il.qty_remaining) FROM inventory_lots il
                  WHERE il.tenant_id = ${ctx.tenantId} AND il.product_id = ${productId}
                    AND il.deleted_at IS NULL AND il.owner_type = 'OWNED' AND il.qty_remaining > 0
               ), 0) / 1000)
               - COALESCE((
                 SELECT COUNT(*) FROM inventory_units iu
                  WHERE iu.tenant_id = ${ctx.tenantId} AND iu.product_id = ${productId}
                    AND iu.status = 'IN_STOCK'
               ), 0),
               0
             )::text AS missing
    `);
    return Number(rows.rows[0]?.missing ?? 0);
  }

  async markSold(
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
  ): Promise<number> {
    if (input.unitIds.length === 0) return 0;

    const changed = await txOf(tx)
      .update(inventoryUnits)
      .set({
        status: 'SOLD',
        saleId: input.saleId,
        saleLineId: input.saleLineId,
        customerPartyId: input.customerPartyId,
        soldDate: input.soldDate,
        // Snapshotted at the sale: the customer's cover is what the product
        // promised on the day they bought it, not what it promises now.
        customerWarrantyMonths: input.customerWarrantyMonths,
        updatedAt: this.clock.now(),
        updatedBy: ctx.userId,
        version: sql`${inventoryUnits.version} + 1`,
      })
      .where(
        and(
          eq(inventoryUnits.tenantId, ctx.tenantId),
          inArray(inventoryUnits.id, [...input.unitIds]),
          eq(inventoryUnits.status, 'IN_STOCK'),
        ),
      )
      .returning({ id: inventoryUnits.id });
    return changed.length;
  }

  async setStatus(
    tx: Tx,
    ctx: TenantContext,
    unitId: string,
    status: SerialUnitStatus,
  ): Promise<void> {
    await txOf(tx)
      .update(inventoryUnits)
      .set({
        status,
        updatedAt: this.clock.now(),
        updatedBy: ctx.userId,
        version: sql`${inventoryUnits.version} + 1`,
      })
      .where(and(eq(inventoryUnits.tenantId, ctx.tenantId), eq(inventoryUnits.id, unitId)));
  }

  async markReturnedToVendor(
    tx: Tx,
    ctx: TenantContext,
    input: {
      readonly unitIds: readonly string[];
      readonly vendorStockReceiptId: string;
      readonly vendorLotId: string;
    },
  ): Promise<number> {
    if (input.unitIds.length === 0) return 0;
    const changed = await txOf(tx)
      .update(inventoryUnits)
      .set({
        status: 'RETURNED_TO_VENDOR',
        updatedAt: this.clock.now(),
        updatedBy: ctx.userId,
        version: sql`${inventoryUnits.version} + 1`,
      })
      .where(
        and(
          eq(inventoryUnits.tenantId, ctx.tenantId),
          inArray(inventoryUnits.id, [...input.unitIds]),
          eq(inventoryUnits.status, 'IN_STOCK'),
          eq(inventoryUnits.vendorStockReceiptId, input.vendorStockReceiptId),
          eq(inventoryUnits.vendorLotId, input.vendorLotId),
        ),
      )
      .returning({ id: inventoryUnits.id });
    return changed.length;
  }
}
