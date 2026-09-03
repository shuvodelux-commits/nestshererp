import type {
  NewVendorReceipt,
  NewVendorReturn,
  TenantContext,
  Tx,
  VendorReceiptRow,
  VendorStockRepository,
} from '@sher/core-application';
import type { Clock } from '@sher/shared-utils';
import { and, eq, gte, sql } from 'drizzle-orm';

import {
  inventoryLots,
  stockMovements,
  vendorStockReceipts,
  vendorStockReturns,
} from './schema';
import { txOf } from './unit-of-work';

/**
 * Vendor-held stock over PostgreSQL (§5.6 M07, DR13.10, Phase 8).
 *
 * **No journal entry is written by anything in this file.** The lot carries
 * `owner_type = 'VENDOR'`, which is what keeps these goods out of valuation and
 * out of COGS while the shop is only holding them. The money happens at the
 * till, when the sale converts the lot to owned at the vendor's cost and
 * creates the payable — and that lives in the sale's own transaction, not here.
 */

interface RawReceipt extends Record<string, unknown> {
  id: string;
  receipt_number: string;
  vendor_party_id: string;
  vendor_name: string;
  product_id: string;
  display_name: string;
  unit_name: string;
  business_date: string;
  expiry_date: string | null;
  note: string | null;
  qty: string;
  vendor_unit_cost: string;
  lot_id: string;
  location_id: string;
  lot_qty_remaining: string;
  returned_qty: string;
  version: number;
}

const RECEIPT_SELECT = sql`
  SELECT vsr.id, vsr.receipt_number, vsr.vendor_party_id,
         COALESCE(v.name, '') AS vendor_name,
         vsr.product_id,
         CASE WHEN b.name IS NULL OR b.name = '' THEN p.name
              ELSE b.name || ' ' || p.name END AS display_name,
         u.name AS unit_name,
         vsr.business_date::text, il.expiry_date::text, vsr.note,
         vsr.qty::text, vsr.vendor_unit_cost::text, vsr.lot_id, vsr.location_id,
         COALESCE(il.qty_remaining, 0)::text AS lot_qty_remaining,
         COALESCE((
           SELECT SUM(r.qty) FROM vendor_stock_returns r
            WHERE r.tenant_id = vsr.tenant_id AND r.receipt_id = vsr.id
         ), 0)::text AS returned_qty,
         vsr.version
    FROM vendor_stock_receipts vsr
    JOIN products p ON p.id = vsr.product_id AND p.tenant_id = vsr.tenant_id
    JOIN units u ON u.id = p.base_unit_id AND u.tenant_id = p.tenant_id
    LEFT JOIN brands b ON b.id = p.brand_id AND b.tenant_id = p.tenant_id
    LEFT JOIN parties v ON v.id = vsr.vendor_party_id AND v.tenant_id = vsr.tenant_id
    LEFT JOIN inventory_lots il ON il.id = vsr.lot_id AND il.tenant_id = vsr.tenant_id
`;

function toReceipt(row: RawReceipt): VendorReceiptRow {
  return {
    id: row.id,
    receiptNumber: row.receipt_number,
    vendorPartyId: row.vendor_party_id,
    vendorName: row.vendor_name,
    productId: row.product_id,
    displayName: row.display_name,
    unitName: row.unit_name,
    businessDate: row.business_date,
    expiryDate: row.expiry_date,
    note: row.note,
    qty: Number(row.qty),
    vendorUnitCost: Number(row.vendor_unit_cost),
    lotId: row.lot_id,
    locationId: row.location_id,
    lotQtyRemaining: Number(row.lot_qty_remaining),
    returnedQty: Number(row.returned_qty),
    version: row.version,
  };
}

export class PostgresVendorStockRepository implements VendorStockRepository {
  constructor(private readonly clock: Clock) {}

  async insertReceipt(tx: Tx, ctx: TenantContext, receipt: NewVendorReceipt): Promise<void> {
    const db = txOf(tx);
    const now = this.clock.now();

    /*
     * A VENDOR lot. `purchase_unit_cost` and `actual_unit_cost` both carry the
     * agreed vendor cost so that the deemed purchase at the till has a costed
     * origin to point at — but the lot is excluded from valuation by its owner
     * type, not by its cost, so INV-04 holds while the shop merely holds it.
     */
    await db.insert(inventoryLots).values({
      id: receipt.lotId,
      tenantId: ctx.tenantId,
      productId: receipt.productId,
      locationId: receipt.locationId,
      ownerType: 'VENDOR',
      vendorPartyId: receipt.vendorPartyId,
      supplierPartyId: null,
      sourceDocumentType: 'VENDOR_STOCK_RECEIPT',
      sourceDocumentId: receipt.id,
      sourceNumber: receipt.receiptNumber,
      qtyReceived: receipt.qty,
      qtyRemaining: receipt.qty,
      purchaseUnitCost: receipt.vendorUnitCost,
      landedCostTotal: 0,
      actualUnitCost: receipt.vendorUnitCost,
      businessDate: receipt.businessDate,
      expiryDate: receipt.expiryDate,
      status: 'OPEN',
      createdAt: now,
      updatedAt: now,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
      version: 1,
    });

    await db.insert(stockMovements).values({
      id: receipt.movementId,
      tenantId: ctx.tenantId,
      createdAt: now,
      createdBy: ctx.userId,
      productId: receipt.productId,
      locationId: receipt.locationId,
      lotId: receipt.lotId,
      qty: receipt.qty,
      direction: 'IN',
      businessDate: receipt.businessDate,
      sourceDocumentType: 'VENDOR_STOCK_RECEIPT',
      sourceDocumentId: receipt.id,
      sourceNumber: receipt.receiptNumber,
      unitCost: receipt.vendorUnitCost,
    });

    await db.insert(vendorStockReceipts).values({
      id: receipt.id,
      tenantId: ctx.tenantId,
      receiptNumber: receipt.receiptNumber,
      vendorPartyId: receipt.vendorPartyId,
      productId: receipt.productId,
      locationId: receipt.locationId,
      qty: receipt.qty,
      vendorUnitCost: receipt.vendorUnitCost,
      lotId: receipt.lotId,
      movementId: receipt.movementId,
      note: receipt.note,
      businessDate: receipt.businessDate,
      operationId: receipt.operationId,
      createdAt: now,
      updatedAt: now,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
      version: 1,
    });
  }

  async insertReturn(
    tx: Tx,
    ctx: TenantContext,
    record: NewVendorReturn,
  ): Promise<void> {
    const db = txOf(tx);
    const now = this.clock.now();

    await db.insert(stockMovements).values({
      id: record.movementId,
      tenantId: ctx.tenantId,
      createdAt: now,
      createdBy: ctx.userId,
      productId: record.productId,
      locationId: record.locationId,
      lotId: record.lotId,
      qty: record.qty,
      direction: 'OUT',
      businessDate: record.businessDate,
      sourceDocumentType: 'VENDOR_STOCK_RETURN',
      sourceDocumentId: record.id,
      sourceNumber: record.returnNumber,
      unitCost: null,
    });

    const updatedLot = await db
      .update(inventoryLots)
      .set({
        qtyRemaining: sql`${inventoryLots.qtyRemaining} - ${record.qty}`,
        // A lot with nothing left is closed, exactly as a fully consumed
        // purchase lot is — the vendor's goods have all gone one way or another.
        status: sql`CASE WHEN ${inventoryLots.qtyRemaining} - ${record.qty} <= 0 THEN 'CLOSED' ELSE 'OPEN' END`,
        updatedAt: now,
        updatedBy: ctx.userId,
        version: sql`${inventoryLots.version} + 1`,
      })
      .where(
        and(
          eq(inventoryLots.tenantId, ctx.tenantId),
          eq(inventoryLots.id, record.lotId),
          gte(inventoryLots.qtyRemaining, record.qty),
        ),
      )
      .returning({ id: inventoryLots.id });
    if (updatedLot.length === 0) {
      throw new Error('Vendor stock changed while this return was being posted');
    }

    await db.insert(vendorStockReturns).values({
      id: record.id,
      tenantId: ctx.tenantId,
      returnNumber: record.returnNumber,
      receiptId: record.receiptId,
      vendorPartyId: record.vendorPartyId,
      productId: record.productId,
      qty: record.qty,
      movementId: record.movementId,
      note: record.note,
      businessDate: record.businessDate,
      operationId: record.operationId,
      createdAt: now,
      updatedAt: now,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
      version: 1,
    });
  }

  async findReceipt(
    tx: Tx,
    ctx: TenantContext,
    receiptId: string,
  ): Promise<VendorReceiptRow | null> {
    const rows = await txOf(tx).execute<RawReceipt>(sql`
      ${RECEIPT_SELECT}
       WHERE vsr.tenant_id = ${ctx.tenantId} AND vsr.id = ${receiptId}
       LIMIT 1
    `);
    const row = rows.rows[0];
    return row === undefined ? null : toReceipt(row);
  }

  async listReceipts(
    tx: Tx,
    ctx: TenantContext,
    options: { readonly vendorPartyId?: string | undefined; readonly limit: number },
  ): Promise<readonly VendorReceiptRow[]> {
    const vendorFilter =
      options.vendorPartyId === undefined
        ? sql``
        : sql`AND vsr.vendor_party_id = ${options.vendorPartyId}`;

    const rows = await txOf(tx).execute<RawReceipt>(sql`
      ${RECEIPT_SELECT}
       WHERE vsr.tenant_id = ${ctx.tenantId}
         ${vendorFilter}
       ORDER BY vsr.business_date DESC, vsr.id DESC
       LIMIT ${options.limit}
    `);
    return rows.rows.map(toReceipt);
  }

  async listSellableLots(
    tx: Tx,
    ctx: TenantContext,
    vendorPartyId: string,
    productId: string,
  ): Promise<readonly VendorReceiptRow[]> {
    const rows = await txOf(tx).execute<RawReceipt>(sql`
      ${RECEIPT_SELECT}
       WHERE vsr.tenant_id = ${ctx.tenantId}
         AND vsr.vendor_party_id = ${vendorPartyId}
         AND vsr.product_id = ${productId}
         AND il.qty_remaining > 0
         AND il.status = 'OPEN'
       ORDER BY il.expiry_date ASC NULLS LAST, vsr.business_date ASC, vsr.created_at ASC, vsr.id ASC
    `);
    return rows.rows.map(toReceipt);
  }

  async findReceiptByOperationId(
    tx: Tx,
    ctx: TenantContext,
    operationId: string,
  ): Promise<string | null> {
    const rows = await txOf(tx)
      .select({ id: vendorStockReceipts.id })
      .from(vendorStockReceipts)
      .where(
        and(
          eq(vendorStockReceipts.tenantId, ctx.tenantId),
          eq(vendorStockReceipts.operationId, operationId),
        ),
      )
      .limit(1);
    return rows[0]?.id ?? null;
  }

  /**
   * What the vendor is owed and what has been paid, from the journal.
   *
   * Read from `VENDOR_PAYABLE` rather than tallied from the receipts, because
   * the ledger is what the accounts are: a second count kept beside it would
   * eventually disagree, and the ledger would still be the one that was right.
   */
  async vendorLedgerTotals(
    tx: Tx,
    ctx: TenantContext,
    vendorPartyId: string,
  ): Promise<{ readonly dueMinor: number; readonly paidMinor: number }> {
    const rows = await txOf(tx).execute<{ due: string; paid: string }>(sql`
      SELECT COALESCE(SUM(CASE WHEN jl.amount_minor < 0 THEN -jl.amount_minor ELSE 0 END), 0)::text AS due,
             COALESCE(SUM(CASE WHEN jl.amount_minor > 0 THEN jl.amount_minor ELSE 0 END), 0)::text AS paid
        FROM journal_lines jl
       WHERE jl.tenant_id = ${ctx.tenantId}
         AND jl.account_code = 'VENDOR_PAYABLE'
         AND jl.party_id = ${vendorPartyId}
    `);
    const row = rows.rows[0];
    return { dueMinor: Number(row?.due ?? 0), paidMinor: Number(row?.paid ?? 0) };
  }
}
