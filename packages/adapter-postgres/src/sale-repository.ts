import type {
  CustomerReceiptRow,
  CustomerStandingRow,
  InvoicePresentationRow,
  InvoiceSettingsRow,
  NewCustomerReceipt,
  NewQuotation,
  NewSale,
  OpenInvoiceRow,
  PosProductFilter,
  PosProductRow,
  QuotationRow,
  NewSaleDraft,
  SaleDetail,
  SaleDraftRow,
  SaleFilter,
  SaleRepository,
  SaleReversal,
  SaleRow,
  SaleTotalsRow,
  TenantContext,
  Tx,
  RepostCustomerReceipt,
} from '@sher/core-application';
import type { Clock } from '@sher/shared-utils';
import { searchTokens } from '@sher/core-domain';
import { and, asc, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';

import {
  accounts,
  brands,
  categories,
  customerReceipts,
  inventoryLots,
  inventoryUnits,
  invoiceLinePresentation,
  invoicePresentation,
  invoiceSettings,
  journalEntries,
  journalLines,
  lotConsumptions,
  parties,
  productCostState,
  products,
  quotationLines,
  quotations,
  receiptAllocations,
  salesReturns,
  saleDrafts,
  saleLineSourceAllocations,
  saleSourceAllocationReversals,
  saleLines,
  salePayments,
  sales,
  salesOrderLines,
  salesOrders,
  stockMovements,
  units,
  vendorReceivableSettlementAllocations,
} from './schema';
import { txOf } from './unit-of-work';

/**
 * Sales, receipts, invoice presentation and the wholesale drafts over
 * PostgreSQL. No business rule lives here (R-B6) — the service decides what a
 * sale costs and what a receipt settles; this writes the rows and reads them
 * back.
 *
 * **What is still owed is always computed**, never stored: `grand_total −
 * paid_minor − Σ allocations`, in the same statement as the row it belongs to,
 * so the list, its tiles, the invoice screen and the Receive Payment dialog are
 * four readings of one expression rather than four numbers that can drift
 * (migration 0018 — the same argument 0017 makes for a purchase).
 */
function allocatedMinor(saleId: SQL): SQL<number> {
  return sql<number>`COALESCE((
    SELECT SUM(ra.amount_minor)
      FROM receipt_allocations ra
     WHERE ra.sale_id = ${saleId}
  ), 0)::bigint + COALESCE((
    SELECT SUM(vrsa.amount_minor)
      FROM vendor_receivable_settlement_allocations vrsa
     WHERE vrsa.sale_id = ${saleId}
  ), 0)::bigint`;
}

const PAID_MINOR = sql<number>`(${sales.paidMinor} + ${allocatedMinor(sql`${sales.id}`)})`;
const DUE_MINOR = sql<number>`(${sales.grandTotalMinor} - ${sales.paidMinor} - ${allocatedMinor(sql`${sales.id}`)})`;

export class PostgresSaleRepository implements SaleRepository {
  constructor(private readonly clock: Clock) {}

  async lockSale(tx: Tx, ctx: TenantContext, saleId: string): Promise<boolean> {
    const rows = await txOf(tx)
      .select({ id: sales.id })
      .from(sales)
      .where(and(eq(sales.tenantId, ctx.tenantId), eq(sales.id, saleId)))
      .for('update')
      .limit(1);
    return rows.length === 1;
  }

  async lockReceivableParty(tx: Tx, ctx: TenantContext, partyId: string): Promise<boolean> {
    const rows = await txOf(tx)
      .select({ id: parties.id })
      .from(parties)
      .where(and(eq(parties.tenantId, ctx.tenantId), eq(parties.id, partyId)))
      .for('update')
      .limit(1);
    return rows.length === 1;
  }

  async cancellationBlocker(
    tx: Tx,
    ctx: TenantContext,
    id: string,
  ): Promise<'POSTED_RETURN' | 'VENDOR_SETTLEMENT' | null> {
    const db = txOf(tx);
    const postedReturn = await db
      .select({ id: salesReturns.id })
      .from(salesReturns)
      .where(
        and(
          eq(salesReturns.tenantId, ctx.tenantId),
          eq(salesReturns.saleId, id),
          eq(salesReturns.status, 'POSTED'),
          isNull(salesReturns.deletedAt),
        ),
      )
      .limit(1);
    if (postedReturn.length > 0) return 'POSTED_RETURN';

    const settlement = await db
      .select({ id: vendorReceivableSettlementAllocations.id })
      .from(vendorReceivableSettlementAllocations)
      .where(
        and(
          eq(vendorReceivableSettlementAllocations.tenantId, ctx.tenantId),
          eq(vendorReceivableSettlementAllocations.saleId, id),
        ),
      )
      .limit(1);
    return settlement.length > 0 ? 'VENDOR_SETTLEMENT' : null;
  }

  async findSaleIdByOperationId(
    tx: Tx,
    ctx: TenantContext,
    operationId: string,
  ): Promise<string | null> {
    const rows = await txOf(tx)
      .select({ id: sales.id })
      .from(sales)
      .where(
        and(
          eq(sales.tenantId, ctx.tenantId),
          eq(sales.operationId, operationId),
          isNull(sales.deletedAt),
        ),
      )
      .limit(1);
    return rows[0]?.id.trim() ?? null;
  }

  async insertSale(tx: Tx, ctx: TenantContext, sale: NewSale): Promise<void> {
    const db = txOf(tx);
    const now = this.clock.now();

    await db.insert(sales).values({
      id: sale.id,
      tenantId: ctx.tenantId,
      saleNumber: sale.number,
      partyId: sale.partyId,
      customerNameSnapshot: sale.customerName,
      customerPhoneSnapshot: sale.customerPhone,
      customerGuardianNameSnapshot: sale.customerGuardianName,
      customerAddressSnapshot: sale.customerAddress,
      locationId: sale.locationId,
      dueDate: sale.dueDate,
      itemsTotalMinor: sale.itemsTotalMinor,
      discountMinor: sale.discountMinor,
      grandTotalMinor: sale.grandTotalMinor,
      cogsMinor: sale.cogsMinor,
      paidMinor: sale.paidMinor,
      sessionId: sale.sessionId,
      notes: sale.notes,
      businessDate: sale.businessDate,
      entryMode: sale.entryMode,
      status: 'POSTED',
      operationId: sale.operationId,
      createdAt: now,
      updatedAt: now,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
      version: 1,
    });

    for (const line of sale.lines) {
      /*
       * A consignment line creates the lot it immediately sells (DR13.10's
       * deemed purchase). `ownerType: 'VENDOR'` is what keeps those goods out
       * of owned valuation (INV-04) while still giving the sale a costed origin
       * the movement trail can point at.
       */
      if (line.vendorLot !== null) {
        await db.insert(inventoryLots).values({
          id: line.vendorLot.id,
          tenantId: ctx.tenantId,
          productId: line.productId,
          locationId: line.locationId,
          ownerType: 'VENDOR',
          vendorPartyId: line.vendorPartyId,
          supplierPartyId: null,
          sourceDocumentType: 'SALE',
          sourceDocumentId: sale.id,
          sourceNumber: sale.number,
          qtyReceived: line.qty,
          qtyRemaining: 0,
          purchaseUnitCost: line.vendorLot.unitCost,
          landedCostTotal: 0,
          actualUnitCost: line.vendorLot.unitCost,
          businessDate: sale.businessDate,
          expiryDate: null,
          status: 'CLOSED',
          createdAt: now,
          updatedAt: now,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
          version: 1,
        });
      }

      await db.insert(stockMovements).values({
        id: line.movementId,
        tenantId: ctx.tenantId,
        createdAt: now,
        createdBy: ctx.userId,
        productId: line.productId,
        locationId: line.locationId,
        lotId: line.vendorLot?.id ?? null,
        qty: line.qty,
        direction: 'OUT',
        businessDate: sale.businessDate,
        sourceDocumentType: 'SALE',
        sourceDocumentId: sale.id,
        sourceNumber: sale.number,
        unitCost: line.qty === 0 ? 0 : Math.round((line.costMinor * 100000) / line.qty / 10) * 10,
      });

      for (const consumption of line.consumptions) {
        await db.insert(lotConsumptions).values({
          id: consumption.id,
          tenantId: ctx.tenantId,
          createdAt: now,
          createdBy: ctx.userId,
          movementId: line.movementId,
          lotId: consumption.lotId,
          qty: consumption.qty,
          unitCostUsed: consumption.unitCostUsed,
          documentType: 'SALE',
          documentId: sale.id,
          businessDate: sale.businessDate,
          supersededBy: null,
        });

        const consumed = await db
          .update(inventoryLots)
          .set({
            qtyRemaining: sql`${inventoryLots.qtyRemaining} - ${consumption.qty}`,
            // DR13.11: an emptied lot is CLOSED and kept forever, never deleted.
            ...(consumption.closesLot ? { status: 'CLOSED' as const } : {}),
            updatedAt: now,
            updatedBy: ctx.userId,
            version: sql`${inventoryLots.version} + 1`,
          })
          .where(
            and(
              eq(inventoryLots.tenantId, ctx.tenantId),
              eq(inventoryLots.id, consumption.lotId),
              gte(inventoryLots.qtyRemaining, consumption.qty),
            ),
          )
          .returning({ id: inventoryLots.id });
        if (consumed.length === 0) {
          throw new Error('Owned stock changed while this sale was being posted');
        }
      }

      if (line.costState.exists) {
        await db
          .update(productCostState)
          .set({
            qtyOnHand: sql`${productCostState.qtyOnHand} - ${line.costState.qtyChange}`,
            lastRecomputedAt: now,
            updatedAt: now,
            updatedBy: ctx.userId,
            version: sql`${productCostState.version} + 1`,
          })
          .where(
            and(
              eq(productCostState.tenantId, ctx.tenantId),
              eq(productCostState.id, line.costState.id),
            ),
          );
      } else {
        await db.insert(productCostState).values({
          id: line.costState.id,
          tenantId: ctx.tenantId,
          productId: line.productId,
          locationId: line.locationId,
          avgUnitCost: line.costState.avgUnitCost,
          qtyOnHand: line.costState.qtyOnHand,
          lastRecomputedAt: now,
          createdAt: now,
          updatedAt: now,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
          version: 1,
        });
      }

      await db.insert(saleLines).values({
        id: line.id,
        tenantId: ctx.tenantId,
        saleId: sale.id,
        lineNo: line.lineNo,
        productId: line.productId,
        qty: line.qty,
        unitPriceMinor: line.unitPriceMinor,
        lineDiscountMinor: line.lineDiscountMinor,
        lineTotalMinor: line.lineTotalMinor,
        discountShareMinor: line.discountShareMinor,
        netAmountMinor: line.netAmountMinor,
        costMinor: line.costMinor,
        source: line.source,
        vendorPartyId: line.vendorPartyId,
        vendorUnitCost: line.vendorUnitCost,
        movementId: line.movementId,
        vendorLotId: line.vendorLot?.id ?? null,
        isProvisionalCost: line.isProvisionalCost,
        createdAt: now,
        createdBy: ctx.userId,
      });

      for (const allocation of line.sourceAllocations) {
        if (allocation.sourceType === 'VENDOR') {
          if (allocation.vendorLotId === null) {
            throw new Error('Vendor sale allocation has no vendor lot');
          }
          const changed = await db
            .update(inventoryLots)
            .set({
              qtyRemaining: sql`${inventoryLots.qtyRemaining} - ${allocation.qty}`,
              updatedAt: now,
              updatedBy: ctx.userId,
              version: sql`${inventoryLots.version} + 1`,
            })
            .where(
              and(
                eq(inventoryLots.tenantId, ctx.tenantId),
                eq(inventoryLots.id, allocation.vendorLotId),
                eq(inventoryLots.ownerType, 'VENDOR'),
                sql`${inventoryLots.qtyRemaining} >= ${allocation.qty}`,
              ),
            )
            .returning({ qtyRemaining: inventoryLots.qtyRemaining });
          const remaining = changed[0]?.qtyRemaining;
          if (remaining === undefined) {
            throw new Error('Recorded vendor stock changed before this sale could post');
          }
          if (Number(remaining) === 0) {
            await db
              .update(inventoryLots)
              .set({ status: 'CLOSED', updatedAt: now, updatedBy: ctx.userId })
              .where(
                and(
                  eq(inventoryLots.tenantId, ctx.tenantId),
                  eq(inventoryLots.id, allocation.vendorLotId),
                ),
              );
          }
        }

        await db.insert(saleLineSourceAllocations).values({
          id: allocation.id,
          tenantId: ctx.tenantId,
          saleId: sale.id,
          saleLineId: line.id,
          sourceType: allocation.sourceType,
          qty: allocation.qty,
          ownedLotId: allocation.ownedLotId,
          vendorPartyId: allocation.vendorPartyId,
          vendorStockReceiptId: allocation.vendorStockReceiptId,
          vendorLotId: allocation.vendorLotId,
          inventoryUnitId: allocation.inventoryUnitId,
          unitCostUsed: allocation.unitCostUsed,
          createdAt: now,
          createdBy: ctx.userId,
        });
      }
    }

    for (const payment of sale.payments) {
      await db.insert(salePayments).values({
        id: payment.id,
        tenantId: ctx.tenantId,
        saleId: sale.id,
        lineNo: payment.lineNo,
        accountCode: payment.accountCode,
        amountMinor: payment.amountMinor,
        sessionId: payment.sessionId,
        createdAt: now,
        createdBy: ctx.userId,
      });
    }

    await this.insertJournal(
      tx,
      ctx,
      sale.journalEntryId,
      sale.businessDate,
      sale.entryMode,
      'SALE',
      sale.id,
      sale.number,
      sale.journalLines,
    );
  }

  async findSaleById(tx: Tx, ctx: TenantContext, id: string): Promise<SaleDetail | null> {
    const db = txOf(tx);
    const rows = await db
      .select({
        id: sales.id,
        number: sales.saleNumber,
        partyId: sales.partyId,
        isWalkIn: parties.isSystemReserved,
        customerName: sales.customerNameSnapshot,
        customerPhone: sales.customerPhoneSnapshot,
        customerGuardianName: sales.customerGuardianNameSnapshot,
        customerAddress: sales.customerAddressSnapshot,
        businessDate: sales.businessDate,
        dueDate: sales.dueDate,
        status: sales.status,
        notes: sales.notes,
        itemsTotalMinor: sales.itemsTotalMinor,
        discountMinor: sales.discountMinor,
        grandTotalMinor: sales.grandTotalMinor,
        cogsMinor: sales.cogsMinor,
        paidMinor: PAID_MINOR,
        dueMinor: DUE_MINOR,
        createdAt: sales.createdAt,
        /*
         * Phase 12.4 (§18). The machine's name comes from a subquery rather
         * than a join: `device_authorizations` is read by raw SQL everywhere
         * else, and adding a table definition and a LEFT JOIN to every sale
         * read would cost more than the one label it buys.
         */
        originMode: sales.originMode,
        originDeviceCode: sql<string | null>`(SELECT d.device_code FROM device_authorizations d WHERE d.id = ${sales.originDeviceId})`,
        originDeviceName: sql<string | null>`(SELECT d.name FROM device_authorizations d WHERE d.id = ${sales.originDeviceId})`,
        deviceCreatedAt: sales.deviceCreatedAt,
        version: sales.version,
      })
      .from(sales)
      .innerJoin(parties, and(eq(parties.tenantId, ctx.tenantId), eq(parties.id, sales.partyId)))
      .where(and(eq(sales.tenantId, ctx.tenantId), eq(sales.id, id), isNull(sales.deletedAt)))
      .limit(1);

    const row = rows[0];
    if (row === undefined) return null;

    const lineRows = await db
      .select({
        id: saleLines.id,
        productId: saleLines.productId,
        productName: products.name,
        displayName: invoiceLinePresentation.displayName,
        unitName: units.name,
        locationId: products.id,
        qty: saleLines.qty,
        unitPriceMinor: saleLines.unitPriceMinor,
        lineDiscountMinor: saleLines.lineDiscountMinor,
        lineTotalMinor: saleLines.lineTotalMinor,
        discountShareMinor: saleLines.discountShareMinor,
        netAmountMinor: saleLines.netAmountMinor,
        costMinor: saleLines.costMinor,
        source: saleLines.source,
        vendorPartyId: saleLines.vendorPartyId,
        isProvisionalCost: saleLines.isProvisionalCost,
        tracksSerial: products.tracksSerial,
      })
      .from(saleLines)
      .innerJoin(
        products,
        and(eq(products.tenantId, ctx.tenantId), eq(products.id, saleLines.productId)),
      )
      .innerJoin(units, and(eq(units.tenantId, ctx.tenantId), eq(units.id, products.baseUnitId)))
      .leftJoin(
        invoiceLinePresentation,
        and(
          eq(invoiceLinePresentation.tenantId, ctx.tenantId),
          eq(invoiceLinePresentation.saleLineId, saleLines.id),
        ),
      )
      .where(and(eq(saleLines.tenantId, ctx.tenantId), eq(saleLines.saleId, row.id)))
      .orderBy(saleLines.lineNo);

    const vendorIds = lineRows
      .map((line) => line.vendorPartyId)
      .filter((partyId): partyId is string => partyId !== null);
    const vendorNames =
      vendorIds.length === 0
        ? new Map<string, string>()
        : new Map(
            (
              await db
                .select({ id: parties.id, name: parties.name })
                .from(parties)
                .where(and(eq(parties.tenantId, ctx.tenantId), inArray(parties.id, vendorIds)))
            ).map((party) => [party.id.trim(), party.name]),
          );

    const allocationRows = await db
      .select({
        id: saleLineSourceAllocations.id,
        saleLineId: saleLineSourceAllocations.saleLineId,
        sourceType: saleLineSourceAllocations.sourceType,
        qty: saleLineSourceAllocations.qty,
        ownedLotId: saleLineSourceAllocations.ownedLotId,
        vendorPartyId: saleLineSourceAllocations.vendorPartyId,
        vendorStockReceiptId: saleLineSourceAllocations.vendorStockReceiptId,
        vendorLotId: saleLineSourceAllocations.vendorLotId,
        inventoryUnitId: saleLineSourceAllocations.inventoryUnitId,
        serialNo: inventoryUnits.serialNo,
        unitCostUsed: saleLineSourceAllocations.unitCostUsed,
      })
      .from(saleLineSourceAllocations)
      .leftJoin(
        inventoryUnits,
        and(
          eq(inventoryUnits.tenantId, saleLineSourceAllocations.tenantId),
          eq(inventoryUnits.id, saleLineSourceAllocations.inventoryUnitId),
        ),
      )
      .where(
        and(
          eq(saleLineSourceAllocations.tenantId, ctx.tenantId),
          eq(saleLineSourceAllocations.saleId, row.id),
        ),
      )
      .orderBy(saleLineSourceAllocations.id);

    const locationRows = await db
      .select({ id: sales.locationId })
      .from(sales)
      .where(and(eq(sales.tenantId, ctx.tenantId), eq(sales.id, row.id)))
      .limit(1);
    const locationId = locationRows[0]?.id.trim() ?? '';

    const paymentRows = await db
      .select({
        id: salePayments.id,
        accountCode: salePayments.accountCode,
        amountMinor: salePayments.amountMinor,
      })
      .from(salePayments)
      .where(and(eq(salePayments.tenantId, ctx.tenantId), eq(salePayments.saleId, row.id)))
      .orderBy(salePayments.lineNo);

    const receiptRows = await db
      .select({
        id: customerReceipts.id,
        number: customerReceipts.receiptNumber,
        businessDate: customerReceipts.businessDate,
        accountCode: customerReceipts.accountCode,
        amountMinor: receiptAllocations.amountMinor,
      })
      .from(receiptAllocations)
      .innerJoin(
        customerReceipts,
        and(
          eq(customerReceipts.tenantId, ctx.tenantId),
          eq(customerReceipts.id, receiptAllocations.receiptId),
        ),
      )
      .where(
        and(eq(receiptAllocations.tenantId, ctx.tenantId), eq(receiptAllocations.saleId, row.id)),
      )
      .orderBy(customerReceipts.businessDate, customerReceipts.id);

    const accountRows = await this.accountsByCode(tx, ctx, [
      ...paymentRows.map((payment) => payment.accountCode),
      ...receiptRows.map((receipt) => receipt.accountCode),
    ]);

    const journalRows = await db
      .select({
        accountCode: journalLines.accountCode,
        amountMinor: journalLines.amountMinor,
        partyId: journalLines.partyId,
      })
      .from(journalLines)
      .innerJoin(
        journalEntries,
        and(
          eq(journalEntries.tenantId, ctx.tenantId),
          eq(journalEntries.id, journalLines.journalEntryId),
        ),
      )
      .where(
        and(
          eq(journalLines.tenantId, ctx.tenantId),
          eq(journalEntries.sourceDocumentType, 'SALE'),
          eq(journalEntries.sourceDocumentId, row.id),
        ),
      );

    const consumptionRows = await db
      .select({
        movementId: lotConsumptions.movementId,
        lotId: lotConsumptions.lotId,
        qty: lotConsumptions.qty,
        unitCostUsed: lotConsumptions.unitCostUsed,
        saleLineId: saleLines.id,
      })
      .from(lotConsumptions)
      .innerJoin(
        saleLines,
        and(
          eq(saleLines.tenantId, ctx.tenantId),
          eq(saleLines.movementId, lotConsumptions.movementId),
        ),
      )
      .where(
        and(eq(lotConsumptions.tenantId, ctx.tenantId), eq(lotConsumptions.documentId, row.id)),
      );

    const presentation = await this.findPresentation(tx, ctx, row.id.trim());

    return {
      id: row.id.trim(),
      number: row.number,
      partyId: row.partyId.trim(),
      isWalkIn: row.isWalkIn,
      customerName: row.customerName,
      customerPhone: row.customerPhone,
      customerGuardianName: row.customerGuardianName,
      customerAddress: row.customerAddress,
      businessDate: row.businessDate,
      dueDate: row.dueDate,
      status: row.status as 'POSTED' | 'VOIDED',
      notes: row.notes,
      itemsTotalMinor: Number(row.itemsTotalMinor),
      discountMinor: Number(row.discountMinor),
      grandTotalMinor: Number(row.grandTotalMinor),
      cogsMinor: Number(row.cogsMinor),
      paidMinor: Number(row.paidMinor),
      dueMinor: Number(row.dueMinor),
      createdAt: row.createdAt,
      originMode: row.originMode === 'OFFLINE' ? ('OFFLINE' as const) : ('ONLINE' as const),
      originDeviceCode: row.originDeviceCode,
      originDeviceName: row.originDeviceName,
      deviceCreatedAt: row.deviceCreatedAt,
      version: row.version,
      lines: lineRows.map((line) => ({
        id: line.id.trim(),
        productId: line.productId.trim(),
        productName: line.productName,
        displayName: line.displayName,
        unitName: line.unitName,
        locationId,
        qty: Number(line.qty),
        unitPriceMinor: Number(line.unitPriceMinor),
        lineDiscountMinor: Number(line.lineDiscountMinor),
        lineTotalMinor: Number(line.lineTotalMinor),
        discountShareMinor: Number(line.discountShareMinor),
        netAmountMinor: Number(line.netAmountMinor),
        costMinor: Number(line.costMinor),
        source: line.source as 'OWN_STOCK' | 'VENDOR_CONSIGNMENT',
        vendorPartyId: line.vendorPartyId?.trim() ?? null,
        vendorName:
          line.vendorPartyId === null ? null : (vendorNames.get(line.vendorPartyId.trim()) ?? null),
        isProvisionalCost: line.isProvisionalCost,
        tracksSerial: line.tracksSerial,
        allocations: allocationRows
          .filter((allocation) => allocation.saleLineId.trim() === line.id.trim())
          .map((allocation) => ({
            id: allocation.id.trim(),
            sourceType: allocation.sourceType as 'OWNED' | 'VENDOR' | 'NEGATIVE',
            qty: Number(allocation.qty),
            ownedLotId: allocation.ownedLotId?.trim() ?? null,
            vendorPartyId: allocation.vendorPartyId?.trim() ?? null,
            vendorStockReceiptId: allocation.vendorStockReceiptId?.trim() ?? null,
            vendorLotId: allocation.vendorLotId?.trim() ?? null,
            inventoryUnitId: allocation.inventoryUnitId?.trim() ?? null,
            serialNo: allocation.serialNo,
            unitCostUsed:
              allocation.unitCostUsed === null ? null : Number(allocation.unitCostUsed),
          })),
      })),
      payments: paymentRows.map((payment) => ({
        id: payment.id.trim(),
        accountCode: payment.accountCode,
        accountName: accountRows.get(payment.accountCode)?.name ?? payment.accountCode,
        accountType: accountRows.get(payment.accountCode)?.type ?? 'CASH',
        amountMinor: Number(payment.amountMinor),
      })),
      receipts: receiptRows.map((receipt) => ({
        id: receipt.id.trim(),
        number: receipt.number,
        businessDate: receipt.businessDate,
        accountName: accountRows.get(receipt.accountCode)?.name ?? receipt.accountCode,
        amountMinor: Number(receipt.amountMinor),
      })),
      presentation,
      journalLines: journalRows.map((line) => ({
        account: line.accountCode,
        amountMinor: Number(line.amountMinor),
        partyId: line.partyId?.trim() ?? null,
      })),
      consumptions: consumptionRows.map((consumption) => ({
        saleLineId: consumption.saleLineId.trim(),
        lotId: consumption.lotId.trim(),
        qty: Number(consumption.qty),
        unitCostUsed: Number(consumption.unitCostUsed),
      })),
    };
  }

  async listSales(tx: Tx, ctx: TenantContext, filter: SaleFilter): Promise<readonly SaleRow[]> {
    const rows = await txOf(tx)
      .select({
        id: sales.id,
        number: sales.saleNumber,
        partyId: sales.partyId,
        isWalkIn: parties.isSystemReserved,
        customerName: sales.customerNameSnapshot,
        customerPhone: sales.customerPhoneSnapshot,
        businessDate: sales.businessDate,
        dueDate: sales.dueDate,
        status: sales.status,
        itemsTotalMinor: sales.itemsTotalMinor,
        discountMinor: sales.discountMinor,
        grandTotalMinor: sales.grandTotalMinor,
        cogsMinor: sales.cogsMinor,
        paidMinor: PAID_MINOR,
        dueMinor: DUE_MINOR,
        createdAt: sales.createdAt,
        /*
         * Phase 12.4 (§18). The machine's name comes from a subquery rather
         * than a join: `device_authorizations` is read by raw SQL everywhere
         * else, and adding a table definition and a LEFT JOIN to every sale
         * read would cost more than the one label it buys.
         */
        originMode: sales.originMode,
        originDeviceCode: sql<string | null>`(SELECT d.device_code FROM device_authorizations d WHERE d.id = ${sales.originDeviceId})`,
        originDeviceName: sql<string | null>`(SELECT d.name FROM device_authorizations d WHERE d.id = ${sales.originDeviceId})`,
        deviceCreatedAt: sales.deviceCreatedAt,
      })
      .from(sales)
      .innerJoin(parties, and(eq(parties.tenantId, ctx.tenantId), eq(parties.id, sales.partyId)))
      .where(this.saleFilter(ctx, filter))
      .orderBy(desc(sales.businessDate), desc(sales.id))
      .limit(filter.limit);

    return rows.map((row) => ({
      id: row.id.trim(),
      number: row.number,
      partyId: row.partyId.trim(),
      isWalkIn: row.isWalkIn,
      customerName: row.customerName,
      customerPhone: row.customerPhone,
      customerGuardianName: null,
      customerAddress: null,
      businessDate: row.businessDate,
      dueDate: row.dueDate,
      status: row.status as 'POSTED' | 'VOIDED',
      notes: null,
      itemsTotalMinor: Number(row.itemsTotalMinor),
      discountMinor: Number(row.discountMinor),
      grandTotalMinor: Number(row.grandTotalMinor),
      cogsMinor: Number(row.cogsMinor),
      paidMinor: Number(row.paidMinor),
      dueMinor: Number(row.dueMinor),
      createdAt: row.createdAt,
      originMode: row.originMode === 'OFFLINE' ? ('OFFLINE' as const) : ('ONLINE' as const),
      originDeviceCode: row.originDeviceCode,
      originDeviceName: row.originDeviceName,
      deviceCreatedAt: row.deviceCreatedAt,
    }));
  }

  /** The tiles, over the same filter minus paging, so they match the table. */
  async totals(tx: Tx, ctx: TenantContext, filter: SaleFilter): Promise<SaleTotalsRow> {
    const rows = await txOf(tx)
      .select({
        salesMinor: sql<number>`COALESCE(SUM(${sales.grandTotalMinor}), 0)::bigint`,
        receivedMinor: sql<number>`COALESCE(SUM(${PAID_MINOR}), 0)::bigint`,
        dueMinor: sql<number>`COALESCE(SUM(${DUE_MINOR}), 0)::bigint`,
        invoiceCount: sql<number>`COUNT(*)::int`,
      })
      .from(sales)
      .innerJoin(parties, and(eq(parties.tenantId, ctx.tenantId), eq(parties.id, sales.partyId)))
      .where(this.saleFilter(ctx, filter));

    const row = rows[0];
    return {
      salesMinor: Number(row?.salesMinor ?? 0),
      receivedMinor: Number(row?.receivedMinor ?? 0),
      dueMinor: Number(row?.dueMinor ?? 0),
      invoiceCount: Number(row?.invoiceCount ?? 0),
    };
  }

  async reverseSale(tx: Tx, ctx: TenantContext, reversal: SaleReversal): Promise<boolean> {
    const db = txOf(tx);
    const now = this.clock.now();

    const updated = await db
      .update(sales)
      .set({
        status: 'VOIDED',
        updatedAt: now,
        updatedBy: ctx.userId,
        version: sql`${sales.version} + 1`,
      })
      .where(
        and(
          eq(sales.tenantId, ctx.tenantId),
          eq(sales.id, reversal.saleId),
          eq(sales.version, reversal.expectedVersion),
          eq(sales.status, 'POSTED'),
        ),
      )
      .returning({ id: sales.id });
    if (updated.length === 0) return false;

    for (const movement of reversal.movements) {
      await db.insert(stockMovements).values({
        id: movement.id,
        tenantId: ctx.tenantId,
        createdAt: now,
        createdBy: ctx.userId,
        productId: movement.productId,
        locationId: movement.locationId,
        lotId: null,
        qty: movement.qty,
        direction: 'IN',
        businessDate: reversal.businessDate,
        sourceDocumentType: 'SALE_CANCELLATION',
        sourceDocumentId: reversal.saleId,
        sourceNumber: reversal.saleId,
        unitCost: movement.unitCost,
      });
    }

    for (const restoration of reversal.restorations) {
      const restored = await db
        .update(inventoryLots)
        .set({
          qtyRemaining: sql`${inventoryLots.qtyRemaining} + ${restoration.qty}`,
          // A lot that was emptied by this sale opens again with the goods.
          status: 'OPEN',
          updatedAt: now,
          updatedBy: ctx.userId,
          version: sql`${inventoryLots.version} + 1`,
        })
        .where(
          and(eq(inventoryLots.tenantId, ctx.tenantId), eq(inventoryLots.id, restoration.lotId)),
        )
        .returning({ id: inventoryLots.id });
      if (restored.length !== 1) throw new Error('Owned sale origin lot was not found');
    }

    for (const restoration of reversal.vendorRestorations) {
      const restored = await db
        .update(inventoryLots)
        .set({
          qtyRemaining: sql`${inventoryLots.qtyRemaining} + ${restoration.qty}`,
          status: 'OPEN',
          updatedAt: now,
          updatedBy: ctx.userId,
          version: sql`${inventoryLots.version} + 1`,
        })
        .where(
          and(
            eq(inventoryLots.tenantId, ctx.tenantId),
            eq(inventoryLots.id, restoration.lotId),
            eq(inventoryLots.ownerType, 'VENDOR'),
          ),
        )
        .returning({ id: inventoryLots.id });
      if (restored.length !== 1) throw new Error('Vendor sale origin lot was not found');
    }

    for (const reversalRow of reversal.allocationReversals) {
      await db.insert(saleSourceAllocationReversals).values({
        id: reversalRow.id,
        tenantId: ctx.tenantId,
        sourceAllocationId: reversalRow.sourceAllocationId,
        sourceDocumentType: 'SALE_CANCELLATION',
        sourceDocumentId: reversal.saleId,
        qty: reversalRow.qty,
        serialPreviousStatus: null,
        serialSaleId: null,
        serialSaleLineId: null,
        serialCustomerPartyId: null,
        serialSoldDate: null,
        serialCustomerWarrantyMonths: null,
        createdAt: now,
        createdBy: ctx.userId,
      });
    }

    if (reversal.serialUnitIds.length > 0) {
      const restored = await db
        .update(inventoryUnits)
        .set({
          status: 'IN_STOCK',
          saleId: null,
          saleLineId: null,
          customerPartyId: null,
          soldDate: null,
          customerWarrantyMonths: null,
          updatedAt: now,
          updatedBy: ctx.userId,
          version: sql`${inventoryUnits.version} + 1`,
        })
        .where(
          and(
            eq(inventoryUnits.tenantId, ctx.tenantId),
            inArray(inventoryUnits.id, [...reversal.serialUnitIds]),
            eq(inventoryUnits.saleId, reversal.saleId),
            eq(inventoryUnits.status, 'SOLD'),
          ),
        )
        .returning({ id: inventoryUnits.id });
      if (restored.length !== reversal.serialUnitIds.length) {
        throw new Error('One or more exact sale serials could not be restored');
      }
    }

    for (const state of reversal.costStates) {
      if (state.exists) {
        await db
          .update(productCostState)
          .set({
            qtyOnHand: state.qtyOnHand,
            avgUnitCost: state.avgUnitCost,
            lastRecomputedAt: now,
            updatedAt: now,
            updatedBy: ctx.userId,
            version: sql`${productCostState.version} + 1`,
          })
          .where(
            and(eq(productCostState.tenantId, ctx.tenantId), eq(productCostState.id, state.id)),
          );
      } else {
        await db.insert(productCostState).values({
          id: state.id,
          tenantId: ctx.tenantId,
          productId: state.productId,
          locationId: state.locationId,
          avgUnitCost: state.avgUnitCost,
          qtyOnHand: state.qtyOnHand,
          lastRecomputedAt: now,
          createdAt: now,
          updatedAt: now,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
          version: 1,
        });
      }
    }

    await this.insertJournal(
      tx,
      ctx,
      reversal.journalEntryId,
      reversal.businessDate,
      reversal.entryMode,
      'SALE_CANCELLATION',
      reversal.saleId,
      reversal.saleId,
      reversal.journalLines,
    );
    return true;
  }

  /** Invoices with money still on them, oldest first — the allocation order. */
  async listOpenInvoices(
    tx: Tx,
    ctx: TenantContext,
    partyId: string,
    saleIds: readonly string[],
  ): Promise<readonly OpenInvoiceRow[]> {
    const rows = await txOf(tx)
      .select({
        id: sales.id,
        number: sales.saleNumber,
        businessDate: sales.businessDate,
        dueDate: sales.dueDate,
        grandTotalMinor: sales.grandTotalMinor,
        outstandingMinor: DUE_MINOR,
      })
      .from(sales)
      .where(
        and(
          eq(sales.tenantId, ctx.tenantId),
          eq(sales.partyId, partyId),
          eq(sales.status, 'POSTED'),
          isNull(sales.deletedAt),
          sql`${DUE_MINOR} > 0`,
          ...(saleIds.length === 0 ? [] : [inArray(sales.id, [...saleIds])]),
        ),
      )
      .orderBy(asc(sales.businessDate), asc(sales.id));

    return rows.map((row) => ({
      id: row.id.trim(),
      number: row.number,
      businessDate: row.businessDate,
      dueDate: row.dueDate,
      grandTotalMinor: Number(row.grandTotalMinor),
      outstandingMinor: Number(row.outstandingMinor),
    }));
  }

  /**
   * A customer's standing, from journal lines (INV-06) — never from adding
   * invoices up. §5.8 requires exactly this, and it is why a due shown at the
   * counter equals the one on their statement to the poisha.
   */
  async customerStanding(
    tx: Tx,
    ctx: TenantContext,
    partyId: string,
  ): Promise<CustomerStandingRow> {
    const rows = await txOf(tx)
      .select({
        dueMinor: sql<number>`COALESCE(SUM(CASE WHEN ${journalLines.accountCode} = 'AR' THEN ${journalLines.amountMinor} ELSE 0 END), 0)::bigint`,
        advanceMinor: sql<number>`COALESCE(SUM(CASE WHEN ${journalLines.accountCode} LIKE 'CUSTOMER_ADVANCE%' THEN -${journalLines.amountMinor} ELSE 0 END), 0)::bigint`,
      })
      .from(journalLines)
      .where(and(eq(journalLines.tenantId, ctx.tenantId), eq(journalLines.partyId, partyId)));

    const row = rows[0];
    return {
      dueMinor: Number(row?.dueMinor ?? 0),
      advanceMinor: Number(row?.advanceMinor ?? 0),
    };
  }

  async findReceiptIdByOperationId(
    tx: Tx,
    ctx: TenantContext,
    operationId: string,
  ): Promise<string | null> {
    const rows = await txOf(tx)
      .select({ id: customerReceipts.id })
      .from(customerReceipts)
      .where(
        and(
          eq(customerReceipts.tenantId, ctx.tenantId),
          eq(customerReceipts.operationId, operationId),
          isNull(customerReceipts.deletedAt),
        ),
      )
      .limit(1);
    return rows[0]?.id.trim() ?? null;
  }

  async repostReceipt(
    tx: Tx,
    ctx: TenantContext,
    receipt: RepostCustomerReceipt,
  ): Promise<boolean> {
    const db = txOf(tx);
    const now = this.clock.now();

    // Back to POSTED from the VOIDED the reversal left moments ago, inside the
    // same transaction: no reader sees the receipt cancelled, and none sees the
    // customer's balance without it.
    const updated = await db
      .update(customerReceipts)
      .set({
        customerPartyId: receipt.customerPartyId,
        accountCode: receipt.accountCode,
        amountMinor: receipt.amountMinor,
        note: receipt.note,
        sessionId: receipt.sessionId,
        businessDate: receipt.businessDate,
        entryMode: receipt.entryMode,
        correctionReason: receipt.correctionReason,
        originalBusinessDate: receipt.originalBusinessDate,
        status: 'POSTED',
        voidReason: null,
        updatedAt: now,
        updatedBy: ctx.userId,
        version: receipt.expectedVersion + 1,
      })
      .where(
        and(
          eq(customerReceipts.tenantId, ctx.tenantId),
          eq(customerReceipts.id, receipt.id),
          eq(customerReceipts.version, receipt.expectedVersion),
        ),
      )
      .returning({ id: customerReceipts.id, number: customerReceipts.receiptNumber });
    const saved = updated[0];
    if (saved === undefined) return false;

    // The reversal released the old allocations, so the corrected amount is
    // pointed at invoices again from scratch rather than patched.
    for (const allocation of receipt.allocations) {
      await db.insert(receiptAllocations).values({
        id: allocation.id,
        tenantId: ctx.tenantId,
        receiptId: receipt.id,
        saleId: allocation.saleId,
        amountMinor: allocation.amountMinor,
        createdAt: now,
        createdBy: ctx.userId,
      });
    }

    await this.insertJournal(
      tx,
      ctx,
      receipt.journalEntryId,
      receipt.businessDate,
      receipt.entryMode,
      'CUSTOMER_RECEIPT_CORRECTION',
      receipt.id,
      saved.number,
      receipt.journalLines,
    );

    return true;
  }

  async insertReceipt(tx: Tx, ctx: TenantContext, receipt: NewCustomerReceipt): Promise<void> {
    const db = txOf(tx);
    const now = this.clock.now();

    await db.insert(customerReceipts).values({
      id: receipt.id,
      tenantId: ctx.tenantId,
      receiptNumber: receipt.number,
      customerPartyId: receipt.customerPartyId,
      accountCode: receipt.accountCode,
      amountMinor: receipt.amountMinor,
      note: receipt.note,
      sessionId: receipt.sessionId,
      businessDate: receipt.businessDate,
      entryMode: receipt.entryMode,
      status: 'POSTED',
      operationId: receipt.operationId,
      createdAt: now,
      updatedAt: now,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
      version: 1,
    });

    for (const allocation of receipt.allocations) {
      await db.insert(receiptAllocations).values({
        id: allocation.id,
        tenantId: ctx.tenantId,
        receiptId: receipt.id,
        saleId: allocation.saleId,
        amountMinor: allocation.amountMinor,
        createdAt: now,
        createdBy: ctx.userId,
      });
    }

    await this.insertJournal(
      tx,
      ctx,
      receipt.journalEntryId,
      receipt.businessDate,
      receipt.entryMode,
      'CUSTOMER_RECEIPT',
      receipt.id,
      receipt.number,
      receipt.journalLines,
    );
  }

  async findReceiptById(
    tx: Tx,
    ctx: TenantContext,
    id: string,
  ): Promise<CustomerReceiptRow | null> {
    const db = txOf(tx);
    const rows = await db
      .select({
        id: customerReceipts.id,
        number: customerReceipts.receiptNumber,
        customerPartyId: customerReceipts.customerPartyId,
        customerName: parties.name,
        accountCode: customerReceipts.accountCode,
        amountMinor: customerReceipts.amountMinor,
        businessDate: customerReceipts.businessDate,
        note: customerReceipts.note,
        status: customerReceipts.status,
        entryMode: customerReceipts.entryMode,
        voidReason: customerReceipts.voidReason,
        version: customerReceipts.version,
      })
      .from(customerReceipts)
      .innerJoin(
        parties,
        and(eq(parties.tenantId, ctx.tenantId), eq(parties.id, customerReceipts.customerPartyId)),
      )
      .where(and(eq(customerReceipts.tenantId, ctx.tenantId), eq(customerReceipts.id, id)))
      .limit(1);

    const row = rows[0];
    if (row === undefined) return null;

    const allocationRows = await db
      .select({
        saleId: receiptAllocations.saleId,
        saleNumber: sales.saleNumber,
        amountMinor: receiptAllocations.amountMinor,
      })
      .from(receiptAllocations)
      .innerJoin(sales, and(eq(sales.tenantId, ctx.tenantId), eq(sales.id, receiptAllocations.saleId)))
      .where(
        and(eq(receiptAllocations.tenantId, ctx.tenantId), eq(receiptAllocations.receiptId, row.id)),
      )
      .orderBy(sales.businessDate, sales.id);

    const settledMinor = allocationRows.reduce(
      (sum, allocation) => sum + Number(allocation.amountMinor),
      0,
    );
    const names = await this.accountsByCode(tx, ctx, [row.accountCode]);

    return {
      id: row.id.trim(),
      number: row.number,
      customerPartyId: row.customerPartyId.trim(),
      customerName: row.customerName,
      accountCode: row.accountCode,
      accountName: names.get(row.accountCode)?.name ?? row.accountCode,
      amountMinor: Number(row.amountMinor),
      settledMinor,
      advanceMinor: Number(row.amountMinor) - settledMinor,
      businessDate: row.businessDate,
      note: row.note,
      allocations: allocationRows.map((allocation) => ({
        saleId: allocation.saleId.trim(),
        saleNumber: allocation.saleNumber,
        amountMinor: Number(allocation.amountMinor),
      })),
      status: row.status === 'VOIDED' ? 'VOIDED' : 'POSTED',
      entryMode: row.entryMode,
      voidReason: row.voidReason,
      version: row.version,
    };
  }

  /**
   * The POS grid (§5.7): ACTIVE products only, with live stock and the group
   * price when one applies. Stock comes from `product_cost_state`, which is the
   * same cache every other stock screen reads.
   */
  async listPosProducts(
    tx: Tx,
    ctx: TenantContext,
    filter: PosProductFilter,
  ): Promise<readonly PosProductRow[]> {
    const search = filter.search?.trim() ?? '';
    const conditions = [
      eq(products.tenantId, ctx.tenantId),
      isNull(products.deletedAt),
      eq(products.status, 'ACTIVE'),
    ];
    if (filter.barcode !== null) conditions.push(eq(products.barcode, filter.barcode));
    if (search !== '') {
      /*
       * Every fragment, anywhere, in any order (migration 0026) — the counter
       * types `sam a15` and `a15 sam` and means the same product. Ranking is
       * the use case's, so the same domain rule orders this list and the one
       * the browser narrows while the request is in flight.
       */
      for (const token of searchTokens(search)) {
        conditions.push(sql`${products.searchText} LIKE ${`%${token}%`}`);
      }
    }
    if (filter.categoryId !== null) conditions.push(eq(products.categoryId, filter.categoryId));
    if (filter.brandId !== null) conditions.push(eq(products.brandId, filter.brandId));
    if (filter.cursor !== null) conditions.push(sql`${products.id} > ${filter.cursor}`);

    const groupPrice =
      filter.customerGroupId === null
        ? sql<number | null>`NULL::bigint`
        : sql<number | null>`(
            SELECT pgp.price_minor FROM product_group_prices pgp
             WHERE pgp.tenant_id = ${ctx.tenantId}
               AND pgp.product_id = ${products.id}
               AND pgp.customer_group_id = ${filter.customerGroupId}
             LIMIT 1
          )`;

    const rows = await txOf(tx)
      .select({
        id: products.id,
        name: products.name,
        sku: products.sku,
        barcode: products.barcode,
        brandName: brands.name,
        categoryName: categories.name,
        unitName: units.name,
        sellingPriceMinor: products.sellingPriceMinor,
        purchasePriceMinor: products.purchasePriceMinor,
        minStockQty: products.minStockQty,
        tracksExpiry: products.tracksExpiry,
        tracksSerial: products.tracksSerial,
        hasImage: sql<boolean>`(${products.imageMime} IS NOT NULL)`,
        searchText: products.searchText,
        /*
         * What the cashier can actually sell.
         *
         * Normally the moving-average cache, which is what every other stock
         * figure reads. Under BLOCK it is the open lots with the expired ones
         * left out instead (Phase 7.2): three of five expired has to show two,
         * because a cashier promising five must not find out at the cart. An
         * undated lot never expires, so it always counts.
         */
        qtyOnHand:
          filter.expiredOn === null
            ? sql<number>`COALESCE((
                SELECT SUM(pcs.qty_on_hand) FROM product_cost_state pcs
                 WHERE pcs.tenant_id = ${ctx.tenantId} AND pcs.product_id = ${products.id}
                   AND pcs.deleted_at IS NULL
              ), 0)::bigint`
            : sql<number>`COALESCE((
                SELECT SUM(il.qty_remaining) FROM inventory_lots il
                 WHERE il.tenant_id = ${ctx.tenantId} AND il.product_id = ${products.id}
                   AND il.deleted_at IS NULL AND il.qty_remaining > 0
                   AND il.owner_type = 'OWNED' AND il.status = 'OPEN'
                   AND (il.expiry_date IS NULL OR il.expiry_date >= ${filter.expiredOn})
              ), 0)::bigint`,
        sellableOwnedQty: sql<number>`COALESCE((
          SELECT SUM(il.qty_remaining) FROM inventory_lots il
           WHERE il.tenant_id = ${ctx.tenantId} AND il.product_id = ${products.id}
             AND il.deleted_at IS NULL AND il.qty_remaining > 0
             AND il.owner_type = 'OWNED' AND il.status = 'OPEN'
             ${filter.expiredOn === null
               ? sql``
               : sql`AND (il.expiry_date IS NULL OR il.expiry_date >= ${filter.expiredOn})`}
        ), 0)::bigint`,
        groupPriceMinor: groupPrice,
      })
      .from(products)
      .innerJoin(units, and(eq(units.tenantId, ctx.tenantId), eq(units.id, products.baseUnitId)))
      .leftJoin(brands, and(eq(brands.tenantId, ctx.tenantId), eq(brands.id, products.brandId)))
      .leftJoin(
        categories,
        and(eq(categories.tenantId, ctx.tenantId), eq(categories.id, products.categoryId)),
      )
      .where(and(...conditions))
      .orderBy(asc(products.id))
      .limit(filter.limit);

    return rows.map((row) => ({
      id: row.id.trim(),
      name: row.name,
      sku: row.sku,
      barcode: row.barcode,
      brandName: row.brandName,
      categoryName: row.categoryName,
      unitName: row.unitName,
      sellingPriceMinor: Number(row.sellingPriceMinor),
      purchasePriceMinor: Number(row.purchasePriceMinor),
      groupPriceMinor: row.groupPriceMinor === null ? null : Number(row.groupPriceMinor),
      qtyOnHand: Number(row.qtyOnHand),
      sellableOwnedQty: Number(row.sellableOwnedQty),
      minStockQty: Number(row.minStockQty),
      hasImage: row.hasImage,
      searchText: row.searchText,
      tracksExpiry: row.tracksExpiry,
      tracksSerial: row.tracksSerial,
    }));
  }

  async findPresentation(
    tx: Tx,
    ctx: TenantContext,
    saleId: string,
  ): Promise<InvoicePresentationRow | null> {
    const db = txOf(tx);
    const rows = await db
      .select()
      .from(invoicePresentation)
      .where(
        and(eq(invoicePresentation.tenantId, ctx.tenantId), eq(invoicePresentation.saleId, saleId)),
      )
      .limit(1);

    const row = rows[0];
    const lineRows = await db
      .select({
        saleLineId: invoiceLinePresentation.saleLineId,
        displayName: invoiceLinePresentation.displayName,
      })
      .from(invoiceLinePresentation)
      .where(
        and(
          eq(invoiceLinePresentation.tenantId, ctx.tenantId),
          eq(invoiceLinePresentation.saleId, saleId),
        ),
      );

    if (row === undefined && lineRows.length === 0) return null;

    return {
      customerDisplayName: row?.customerDisplayName ?? null,
      customerPhone: row?.customerPhone ?? null,
      customerGuardianName: row?.customerGuardianName ?? null,
      customerAddress: row?.customerAddress ?? null,
      deliveryAddress: row?.deliveryAddress ?? null,
      courierName: row?.courierName ?? null,
      deliveryInstruction: row?.deliveryInstruction ?? null,
      paymentNote: row?.paymentNote ?? null,
      customLabel1: row?.customLabel1 ?? null,
      customValue1: row?.customValue1 ?? null,
      customLabel2: row?.customLabel2 ?? null,
      customValue2: row?.customValue2 ?? null,
      customLabel3: row?.customLabel3 ?? null,
      customValue3: row?.customValue3 ?? null,
      lineNames: lineRows.map((line) => ({
        saleLineId: line.saleLineId.trim(),
        displayName: line.displayName,
      })),
    };
  }

  async savePresentation(
    tx: Tx,
    ctx: TenantContext,
    saleId: string,
    presentation: InvoicePresentationRow,
  ): Promise<void> {
    const db = txOf(tx);
    const now = this.clock.now();
    const values = {
      customerDisplayName: presentation.customerDisplayName,
      customerPhone: presentation.customerPhone,
      customerGuardianName: presentation.customerGuardianName,
      customerAddress: presentation.customerAddress,
      deliveryAddress: presentation.deliveryAddress,
      courierName: presentation.courierName,
      deliveryInstruction: presentation.deliveryInstruction,
      paymentNote: presentation.paymentNote,
      customLabel1: presentation.customLabel1,
      customValue1: presentation.customValue1,
      customLabel2: presentation.customLabel2,
      customValue2: presentation.customValue2,
      customLabel3: presentation.customLabel3,
      customValue3: presentation.customValue3,
    };

    await db
      .insert(invoicePresentation)
      .values({
        saleId,
        tenantId: ctx.tenantId,
        ...values,
        createdAt: now,
        updatedAt: now,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
        version: 1,
      })
      .onConflictDoUpdate({
        target: invoicePresentation.saleId,
        set: {
          ...values,
          updatedAt: now,
          updatedBy: ctx.userId,
          version: sql`${invoicePresentation.version} + 1`,
        },
      });

    // The whole set is rewritten rather than diffed: a label removed on the
    // screen must disappear from the print, and there are at most a cart's
    // worth of them.
    await db
      .delete(invoiceLinePresentation)
      .where(
        and(
          eq(invoiceLinePresentation.tenantId, ctx.tenantId),
          eq(invoiceLinePresentation.saleId, saleId),
        ),
      );
    for (const line of presentation.lineNames) {
      await db.insert(invoiceLinePresentation).values({
        saleLineId: line.saleLineId,
        tenantId: ctx.tenantId,
        saleId,
        displayName: line.displayName,
        createdAt: now,
        updatedAt: now,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
        version: 1,
      });
    }
  }

  async findInvoiceSettings(tx: Tx, ctx: TenantContext): Promise<InvoiceSettingsRow | null> {
    const rows = await txOf(tx)
      .select()
      .from(invoiceSettings)
      .where(eq(invoiceSettings.tenantId, ctx.tenantId))
      .limit(1);

    const row = rows[0];
    if (row === undefined) return null;
    return {
      language: row.language as 'EN' | 'BN',
      defaultTemplate: row.defaultTemplate as 'A4' | 'THERMAL_80',
      showLogo: row.showLogo,
      showBusinessBlock: row.showBusinessBlock,
      showCustomerBlock: row.showCustomerBlock,
      showSku: row.showSku,
      showBarcode: row.showBarcode,
      showDiscount: row.showDiscount,
      showPaymentBreakdown: row.showPaymentBreakdown,
      showDue: row.showDue,
      showAmountInWords: row.showAmountInWords,
      headerText: row.headerText,
      showHeaderText: row.showHeaderText,
      invoiceTitle: row.invoiceTitle,
      businessNameEn: row.businessNameEn,
      proprietorName: row.proprietorName,
      proprietorNote: row.proprietorNote,
      businessDescription: row.businessDescription,
      businessPhone2: row.businessPhone2,
      contactPhones: Array.isArray(row.contactPhones)
        ? [...(row.contactPhones as { label: string; number: string }[])]
        : [],
      // JSONB comes back as whatever was written; a shop that has never opened
      // the screen has `[]`, and anything else is treated as empty rather than
      // trusted into the renderer.
      mfsNumbers: Array.isArray(row.mfsNumbers)
        ? [...(row.mfsNumbers as { label: string; number: string }[])]
        : [],
      terms: Array.isArray(row.terms) ? [...(row.terms as string[])] : [],
      paymentTermsDays: row.paymentTermsDays,
      paymentTermsLabel: row.paymentTermsLabel,
      thermalPaper: row.thermalPaper === '58mm' ? '58mm' : '80mm',
      showSignatureLines: row.showSignatureLines,
      hasLogo: row.logoMime !== null,
      businessName: row.businessName,
      businessAddress: row.businessAddress,
      businessPhone: row.businessPhone,
      footerText: row.footerText,
      termsText: row.termsText,
      businessPadEnabled: row.businessPadEnabled,
      businessPadTopMm: row.businessPadTopMm,
      pageMarginMm: row.pageMarginMm,
    };
  }

  async saveInvoiceSettings(
    tx: Tx,
    ctx: TenantContext,
    settings: InvoiceSettingsRow,
  ): Promise<void> {
    const db = txOf(tx);
    const now = this.clock.now();
    const { mfsNumbers, terms, contactPhones } = settings;
    const stored = {
      // `hasLogo` is derived from the bytes on read, so it is never written.
      ...omitHasLogo(settings),
      mfsNumbers,
      terms,
      contactPhones,
    };
    await db
      .insert(invoiceSettings)
      .values({
        tenantId: ctx.tenantId,
        ...stored,
        createdAt: now,
        updatedAt: now,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
        version: 1,
      })
      .onConflictDoUpdate({
        target: invoiceSettings.tenantId,
        set: {
          ...stored,
          updatedAt: now,
          updatedBy: ctx.userId,
          version: sql`${invoiceSettings.version} + 1`,
        },
      });
  }

  async findInvoiceLogo(
    tx: Tx,
    ctx: TenantContext,
  ): Promise<{ readonly mime: string; readonly bytes: Uint8Array } | null> {
    const rows = await txOf(tx)
      .select({ mime: invoiceSettings.logoMime, bytes: invoiceSettings.logoBytes })
      .from(invoiceSettings)
      .where(eq(invoiceSettings.tenantId, ctx.tenantId))
      .limit(1);

    const row = rows[0];
    if (row === undefined || row.mime === null || row.bytes === null) return null;
    return { mime: row.mime, bytes: row.bytes };
  }

  async saveInvoiceLogo(
    tx: Tx,
    ctx: TenantContext,
    logo: { readonly mime: string; readonly bytes: Uint8Array } | null,
  ): Promise<void> {
    await txOf(tx)
      .update(invoiceSettings)
      .set({
        logoMime: logo?.mime ?? null,
        logoBytes: logo === null ? null : Buffer.from(logo.bytes),
        updatedAt: this.clock.now(),
        updatedBy: ctx.userId,
      })
      .where(eq(invoiceSettings.tenantId, ctx.tenantId));
  }

  async listDrafts(
    tx: Tx,
    ctx: TenantContext,
    limit: number,
  ): Promise<readonly SaleDraftRow[]> {
    const rows = await txOf(tx)
      .select()
      .from(saleDrafts)
      .where(eq(saleDrafts.tenantId, ctx.tenantId))
      .orderBy(desc(saleDrafts.createdAt), desc(saleDrafts.id))
      .limit(limit);

    return rows.map((row) => ({
      id: row.id.trim(),
      label: row.label,
      customerName: row.customerName,
      itemCount: row.itemCount,
      grandTotalMinor: Number(row.grandTotalMinor),
      cart: (row.cart ?? {}) as Record<string, unknown>,
      businessDate: row.businessDate,
      savedAt: row.createdAt,
    }));
  }

  async saveDraft(tx: Tx, ctx: TenantContext, draft: NewSaleDraft): Promise<void> {
    const now = this.clock.now();
    await txOf(tx).insert(saleDrafts).values({
      id: draft.id,
      tenantId: ctx.tenantId,
      label: draft.label,
      customerName: draft.customerName,
      itemCount: draft.itemCount,
      grandTotalMinor: draft.grandTotalMinor,
      cart: draft.cart,
      businessDate: draft.businessDate,
      createdAt: now,
      updatedAt: now,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
      version: 1,
    });
  }

  /** Hard delete: a draft posted nothing, so there is nothing to reverse. */
  async deleteDraft(tx: Tx, ctx: TenantContext, id: string): Promise<void> {
    await txOf(tx)
      .delete(saleDrafts)
      .where(and(eq(saleDrafts.tenantId, ctx.tenantId), eq(saleDrafts.id, id)));
  }

  async insertQuotation(tx: Tx, ctx: TenantContext, quotation: NewQuotation): Promise<void> {
    const db = txOf(tx);
    const now = this.clock.now();
    const common = {
      id: quotation.id,
      tenantId: ctx.tenantId,
      partyId: quotation.partyId,
      customerNameSnapshot: quotation.customerName,
      customerPhoneSnapshot: quotation.customerPhone,
      itemsTotalMinor: quotation.itemsTotalMinor,
      discountMinor: quotation.discountMinor,
      grandTotalMinor: quotation.grandTotalMinor,
      notes: quotation.notes,
      businessDate: quotation.businessDate,
      operationId: quotation.operationId,
      createdAt: now,
      updatedAt: now,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
      version: 1,
    };

    if (quotation.kind === 'QUOTATION') {
      await db.insert(quotations).values({
        ...common,
        quotationNumber: quotation.number,
        validUntil: quotation.validUntil,
        status: 'DRAFT',
      });
      for (const line of quotation.lines) {
        await db.insert(quotationLines).values({
          id: line.id,
          tenantId: ctx.tenantId,
          quotationId: quotation.id,
          lineNo: line.lineNo,
          productId: line.productId,
          qty: line.qty,
          unitPriceMinor: line.unitPriceMinor,
          lineDiscountMinor: line.lineDiscountMinor,
          lineTotalMinor: line.lineTotalMinor,
          qtyConverted: 0,
          createdAt: now,
          createdBy: ctx.userId,
        });
      }
      return;
    }

    await db.insert(salesOrders).values({
      ...common,
      orderNumber: quotation.number,
      sourceQuotationId: quotation.sourceQuotationId,
      expectedDate: quotation.validUntil,
      status: 'OPEN',
    });
    for (const line of quotation.lines) {
      await db.insert(salesOrderLines).values({
        id: line.id,
        tenantId: ctx.tenantId,
        salesOrderId: quotation.id,
        lineNo: line.lineNo,
        productId: line.productId,
        qty: line.qty,
        unitPriceMinor: line.unitPriceMinor,
        lineDiscountMinor: line.lineDiscountMinor,
        lineTotalMinor: line.lineTotalMinor,
        qtyConverted: 0,
        createdAt: now,
        createdBy: ctx.userId,
      });
    }
  }

  async findQuotationById(
    tx: Tx,
    ctx: TenantContext,
    kind: 'QUOTATION' | 'ORDER',
    id: string,
  ): Promise<QuotationRow | null> {
    const rows = await this.readQuotations(tx, ctx, kind, id, 1);
    return rows[0] ?? null;
  }

  async listQuotations(
    tx: Tx,
    ctx: TenantContext,
    kind: 'QUOTATION' | 'ORDER',
    limit: number,
  ): Promise<readonly QuotationRow[]> {
    return this.readQuotations(tx, ctx, kind, null, limit);
  }

  async markQuotationConverted(
    tx: Tx,
    ctx: TenantContext,
    kind: 'QUOTATION' | 'ORDER',
    id: string,
  ): Promise<void> {
    const db = txOf(tx);
    const now = this.clock.now();
    if (kind === 'QUOTATION') {
      await db
        .update(quotations)
        .set({ status: 'CONVERTED', updatedAt: now, updatedBy: ctx.userId })
        .where(and(eq(quotations.tenantId, ctx.tenantId), eq(quotations.id, id)));
      return;
    }
    await db
      .update(salesOrders)
      .set({ status: 'CONVERTED', updatedAt: now, updatedBy: ctx.userId })
      .where(and(eq(salesOrders.tenantId, ctx.tenantId), eq(salesOrders.id, id)));
  }

  private async readQuotations(
    tx: Tx,
    ctx: TenantContext,
    kind: 'QUOTATION' | 'ORDER',
    id: string | null,
    limit: number,
  ): Promise<readonly QuotationRow[]> {
    const db = txOf(tx);
    const head = kind === 'QUOTATION' ? quotations : salesOrders;
    const body = kind === 'QUOTATION' ? quotationLines : salesOrderLines;
    const numberColumn = kind === 'QUOTATION' ? quotations.quotationNumber : salesOrders.orderNumber;
    const validColumn = kind === 'QUOTATION' ? quotations.validUntil : salesOrders.expectedDate;
    const parentColumn = kind === 'QUOTATION' ? quotationLines.quotationId : salesOrderLines.salesOrderId;

    const rows = await db
      .select({
        id: head.id,
        number: numberColumn,
        partyId: head.partyId,
        customerName: head.customerNameSnapshot,
        customerPhone: head.customerPhoneSnapshot,
        validUntil: validColumn,
        businessDate: head.businessDate,
        status: head.status,
        itemsTotalMinor: head.itemsTotalMinor,
        discountMinor: head.discountMinor,
        grandTotalMinor: head.grandTotalMinor,
        notes: head.notes,
      })
      .from(head)
      .where(
        and(
          eq(head.tenantId, ctx.tenantId),
          isNull(head.deletedAt),
          ...(id === null ? [] : [eq(head.id, id)]),
        ),
      )
      .orderBy(desc(head.businessDate), desc(head.id))
      .limit(limit);

    if (rows.length === 0) return [];

    const lineRows = await db
      .select({
        id: body.id,
        parentId: parentColumn,
        productId: body.productId,
        productName: products.name,
        unitName: units.name,
        qty: body.qty,
        unitPriceMinor: body.unitPriceMinor,
        lineDiscountMinor: body.lineDiscountMinor,
        lineTotalMinor: body.lineTotalMinor,
        qtyConverted: body.qtyConverted,
      })
      .from(body)
      .innerJoin(products, and(eq(products.tenantId, ctx.tenantId), eq(products.id, body.productId)))
      .innerJoin(units, and(eq(units.tenantId, ctx.tenantId), eq(units.id, products.baseUnitId)))
      .where(
        and(
          eq(body.tenantId, ctx.tenantId),
          inArray(
            parentColumn,
            rows.map((row) => row.id),
          ),
        ),
      )
      .orderBy(body.lineNo);

    return rows.map((row) => ({
      id: row.id.trim(),
      kind,
      number: row.number,
      partyId: row.partyId?.trim() ?? null,
      customerName: row.customerName,
      customerPhone: row.customerPhone,
      validUntil: row.validUntil,
      businessDate: row.businessDate,
      status: row.status,
      itemsTotalMinor: Number(row.itemsTotalMinor),
      discountMinor: Number(row.discountMinor),
      grandTotalMinor: Number(row.grandTotalMinor),
      notes: row.notes,
      lines: lineRows
        .filter((line) => line.parentId.trim() === row.id.trim())
        .map((line) => ({
          id: line.id.trim(),
          productId: line.productId.trim(),
          productName: line.productName,
          unitName: line.unitName,
          qty: Number(line.qty),
          unitPriceMinor: Number(line.unitPriceMinor),
          lineDiscountMinor: Number(line.lineDiscountMinor),
          lineTotalMinor: Number(line.lineTotalMinor),
          qtyConverted: Number(line.qtyConverted),
        })),
    }));
  }

  private saleFilter(ctx: TenantContext, filter: SaleFilter): SQL | undefined {
    const search = filter.search?.trim() ?? '';
    const conditions = [eq(sales.tenantId, ctx.tenantId), isNull(sales.deletedAt)];
    if (filter.partyId !== null) conditions.push(eq(sales.partyId, filter.partyId));
    if (filter.fromDate !== null) conditions.push(sql`${sales.businessDate} >= ${filter.fromDate}`);
    if (filter.toDate !== null) conditions.push(sql`${sales.businessDate} <= ${filter.toDate}`);
    if (filter.unpaidOnly) conditions.push(sql`${DUE_MINOR} > 0`);
    // Phase 12.4 (§18). Reads the indexed column the origin trail writes, so
    // "show me what came in from the outage" is a partial-index lookup rather
    // than a scan of every invoice the shop has ever issued.
    if (filter.origin !== undefined && filter.origin !== 'ALL') {
      conditions.push(eq(sales.originMode, filter.origin));
    }
    if (filter.cursor !== null) conditions.push(sql`${sales.id} < ${filter.cursor}`);
    if (search !== '') {
      // One box, two questions (owner decision 2026-08-25): an invoice number
      // or a phone. A guest invoice is found by the phone written on it, which
      // is the whole point of keeping the snapshot.
      conditions.push(
        sql`(${sales.saleNumber} ILIKE ${`%${search}%`} OR ${sales.customerPhoneSnapshot} ILIKE ${`%${search}%`} OR ${sales.customerNameSnapshot} ILIKE ${`%${search}%`})`,
      );
    }
    return and(...conditions);
  }

  private async accountsByCode(
    tx: Tx,
    ctx: TenantContext,
    codes: readonly string[],
  ): Promise<Map<string, { name: string; type: 'CASH' | 'BANK' }>> {
    const ids = [...new Set(codes)]
      .map((code) => ({ code, id: code.slice(code.indexOf(':') + 1) }))
      .filter((entry) => entry.id !== '' && entry.id !== entry.code);
    if (ids.length === 0) return new Map();

    const rows = await txOf(tx)
      .select({ id: accounts.id, name: accounts.name, type: accounts.type })
      .from(accounts)
      .where(
        and(
          eq(accounts.tenantId, ctx.tenantId),
          inArray(
            accounts.id,
            ids.map((entry) => entry.id),
          ),
        ),
      );

    const byId = new Map(
      rows.map((row) => [row.id.trim(), { name: row.name, type: row.type as 'CASH' | 'BANK' }]),
    );
    return new Map(
      ids.flatMap((entry) => {
        const account = byId.get(entry.id);
        return account === undefined ? [] : [[entry.code, account] as const];
      }),
    );
  }

  private async insertJournal(
    tx: Tx,
    ctx: TenantContext,
    entryId: string,
    businessDate: string,
    entryMode: string,
    sourceType: string,
    sourceId: string,
    sourceNumber: string,
    lines: readonly {
      readonly id: string;
      readonly account: string;
      readonly amountMinor: number;
      readonly partyId: string | null;
    }[],
  ): Promise<void> {
    const db = txOf(tx);
    const now = this.clock.now();

    await db.insert(journalEntries).values({
      id: entryId,
      tenantId: ctx.tenantId,
      createdAt: now,
      createdBy: ctx.userId,
      businessDate,
      sourceDocumentType: sourceType,
      sourceDocumentId: sourceId,
      sourceNumber,
      entryMode,
    });
    await db.insert(journalLines).values(
      lines.map((line) => ({
        id: line.id,
        tenantId: ctx.tenantId,
        createdAt: now,
        createdBy: ctx.userId,
        journalEntryId: entryId,
        accountCode: line.account,
        amountMinor: line.amountMinor,
        partyId: line.partyId,
      })),
    );
  }
}

/** The settings without their derived flag, for writing. */
function omitHasLogo(
  settings: InvoiceSettingsRow,
): Omit<InvoiceSettingsRow, 'hasLogo'> {
  const copy: Record<string, unknown> = { ...settings };
  delete copy['hasLogo'];
  return copy as Omit<InvoiceSettingsRow, 'hasLogo'>;
}
