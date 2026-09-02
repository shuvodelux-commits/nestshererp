import type {
  NewVendorIssueReturn,
  NewVendorMoneyDocument,
  NewVendorProductIssue,
  NewVendorProductSettlement,
  TenantContext,
  Tx,
  VendorAccountBalances,
  VendorActivityFilter,
  VendorActivityRowData,
  VendorMoneyDocumentRow,
  VendorProductIssueRow,
  VendorProductSettlementRow,
  VendorWorkspaceRepository,
} from '@sher/core-application';
import type { VendorActivityKind } from '@sher/core-contracts';
import type { Clock } from '@sher/shared-utils';
import { and, eq, sql } from 'drizzle-orm';

import {
  inventoryLots,
  journalEntries,
  journalLines,
  productCostState,
  stockMovements,
  vendorPayments,
  vendorProductIssueLots,
  vendorProductIssueReturns,
  vendorProductIssues,
  vendorProductSettlements,
  vendorReceivableSettlementAllocations,
  vendorReceipts,
} from './schema';
import { txOf } from './unit-of-work';

/**
 * The Vendor Workspace over PostgreSQL (Phase 8.3, §5.6 M07).
 *
 * No business rule lives here (R-B6): the services decide what may be paid,
 * what may be lent and what a return costs; this writes the rows and reads them
 * back.
 *
 * **Two facts this file is responsible for keeping true.** A temporary issue
 * takes goods off the shelf — so the lots are decremented and
 * `product_cost_state.qty_on_hand` moves with them, or the shop would go on
 * offering stock that is at a vendor's premises. And **no journal entry is
 * written for an issue or its return**, because nothing has been bought, sold
 * or owed: the goods are still the shop's, at the cost they left at.
 */

interface RawMoneyDocument extends Record<string, unknown> {
  id: string;
  number: string;
  vendor_party_id: string;
  intent: string;
  account_code: string;
  amount_minor: string;
  note: string | null;
  business_date: string;
}

function toMoneyDocument(row: RawMoneyDocument): VendorMoneyDocumentRow {
  return {
    id: row.id,
    number: row.number,
    vendorPartyId: row.vendor_party_id,
    intent: row.intent,
    accountCode: row.account_code,
    amountMinor: Number(row.amount_minor),
    note: row.note,
    businessDate: row.business_date,
  };
}

interface RawIssue extends Record<string, unknown> {
  id: string;
  issue_number: string;
  vendor_party_id: string;
  vendor_name: string;
  product_id: string;
  display_name: string;
  unit_name: string;
  location_id: string;
  qty: string;
  returned_qty: string;
  cost_minor: string;
  note: string | null;
  business_date: string;
  version: number;
}

const ISSUE_SELECT = sql`
  SELECT vpi.id, vpi.issue_number, vpi.vendor_party_id,
         COALESCE(v.name, '') AS vendor_name,
         vpi.product_id,
         CASE WHEN b.name IS NULL OR b.name = '' THEN p.name
              ELSE b.name || ' ' || p.name END AS display_name,
         u.name AS unit_name,
         vpi.location_id, vpi.qty::text, vpi.returned_qty::text, vpi.cost_minor::text,
         vpi.note, vpi.business_date::text, vpi.version
    FROM vendor_product_issues vpi
    JOIN products p ON p.id = vpi.product_id AND p.tenant_id = vpi.tenant_id
    JOIN units u ON u.id = p.base_unit_id AND u.tenant_id = p.tenant_id
    LEFT JOIN brands b ON b.id = p.brand_id AND b.tenant_id = p.tenant_id
    LEFT JOIN parties v ON v.id = vpi.vendor_party_id AND v.tenant_id = vpi.tenant_id
`;

function toIssue(row: RawIssue): VendorProductIssueRow {
  return {
    id: row.id,
    number: row.issue_number,
    vendorPartyId: row.vendor_party_id,
    vendorName: row.vendor_name,
    productId: row.product_id,
    displayName: row.display_name,
    unitName: row.unit_name,
    locationId: row.location_id,
    qty: Number(row.qty),
    returnedQty: Number(row.returned_qty),
    costMinor: Number(row.cost_minor),
    note: row.note,
    businessDate: row.business_date,
    version: row.version,
  };
}

export class PostgresVendorWorkspaceRepository implements VendorWorkspaceRepository {
  constructor(private readonly clock: Clock) {}

  async insertProductSettlement(
    tx: Tx,
    ctx: TenantContext,
    settlement: NewVendorProductSettlement,
  ): Promise<void> {
    const db = txOf(tx);
    const now = this.clock.now();
    await db.insert(journalEntries).values({
      id: settlement.journalEntryId,
      tenantId: ctx.tenantId,
      createdAt: now,
      createdBy: ctx.userId,
      businessDate: settlement.businessDate,
      sourceDocumentType: 'VENDOR_PRODUCT_SETTLEMENT',
      sourceDocumentId: settlement.id,
      sourceNumber: settlement.number,
      entryMode: settlement.entryMode,
    });
    await db.insert(journalLines).values(
      settlement.journalLines.map((line) => ({
        id: line.id,
        tenantId: ctx.tenantId,
        createdAt: now,
        createdBy: ctx.userId,
        journalEntryId: settlement.journalEntryId,
        accountCode: line.account,
        amountMinor: line.amountMinor,
        partyId: line.partyId,
      })),
    );
    await db.insert(vendorProductSettlements).values({
      id: settlement.id,
      tenantId: ctx.tenantId,
      settlementNumber: settlement.number,
      operationId: settlement.operationId,
      vendorPartyId: settlement.vendorPartyId,
      purchaseId: settlement.purchaseId,
      grossProductMinor: settlement.grossProductMinor,
      discountMinor: settlement.discountMinor,
      netProductMinor: settlement.netProductMinor,
      landedCostMinor: settlement.landedCostMinor,
      receivableBeforeMinor: settlement.receivableBeforeMinor,
      receivableAfterMinor: settlement.receivableAfterMinor,
      journalEntryId: settlement.journalEntryId,
      businessDate: settlement.businessDate,
      createdAt: now,
      createdBy: ctx.userId,
    });
    if (settlement.allocations.length > 0) {
      await db.insert(vendorReceivableSettlementAllocations).values(
        settlement.allocations.map((allocation) => ({
          id: allocation.id,
          tenantId: ctx.tenantId,
          settlementId: settlement.id,
          saleId: allocation.saleId,
          amountMinor: allocation.amountMinor,
          createdAt: now,
          createdBy: ctx.userId,
        })),
      );
    }
  }

  async findProductSettlementByOperationId(
    tx: Tx,
    ctx: TenantContext,
    operationId: string,
  ): Promise<VendorProductSettlementRow | null> {
    const db = txOf(tx);
    const heads = await db.execute<{
      id: string; number: string; vendor_party_id: string; purchase_id: string;
      purchase_number: string; gross_product_minor: string; discount_minor: string;
      net_product_minor: string; landed_cost_minor: string; receivable_before_minor: string;
      receivable_after_minor: string; business_date: string;
    }>(sql`
      SELECT vps.id, vps.settlement_number AS number, vps.vendor_party_id,
             vps.purchase_id, p.purchase_number, vps.gross_product_minor::text,
             vps.discount_minor::text, vps.net_product_minor::text,
             vps.landed_cost_minor::text, vps.receivable_before_minor::text,
             vps.receivable_after_minor::text, vps.business_date::text
        FROM vendor_product_settlements vps
        JOIN purchases p ON p.tenant_id = vps.tenant_id AND p.id = vps.purchase_id
       WHERE vps.tenant_id = ${ctx.tenantId} AND vps.operation_id = ${operationId}
       LIMIT 1
    `);
    const head = heads.rows[0];
    if (head === undefined) return null;
    const allocations = await db.execute<{
      id: string; sale_id: string; sale_number: string; amount_minor: string;
    }>(sql`
      SELECT a.id, a.sale_id, s.sale_number, a.amount_minor::text
        FROM vendor_receivable_settlement_allocations a
        JOIN sales s ON s.tenant_id = a.tenant_id AND s.id = a.sale_id
       WHERE a.tenant_id = ${ctx.tenantId} AND a.settlement_id = ${head.id}
       ORDER BY s.business_date, s.id
    `);
    return {
      id: head.id,
      number: head.number,
      vendorPartyId: head.vendor_party_id,
      purchaseId: head.purchase_id,
      purchaseNumber: head.purchase_number,
      grossProductMinor: Number(head.gross_product_minor),
      discountMinor: Number(head.discount_minor),
      netProductMinor: Number(head.net_product_minor),
      landedCostMinor: Number(head.landed_cost_minor),
      receivableBeforeMinor: Number(head.receivable_before_minor),
      receivableAfterMinor: Number(head.receivable_after_minor),
      businessDate: head.business_date,
      allocations: allocations.rows.map((row) => ({
        id: row.id,
        saleId: row.sale_id,
        saleNumber: row.sale_number,
        amountMinor: Number(row.amount_minor),
      })),
    };
  }

  /**
   * INV-06 in three sums.
   *
   * Positive is a debit throughout, so a payable — a credit balance — is
   * negated on the way out and the caller never has to think about the sign of
   * a liability. `AR` is included because goods charged to a vendor land there
   * like any other credit sale.
   */
  async accountBalances(
    tx: Tx,
    ctx: TenantContext,
    vendorPartyId: string,
  ): Promise<VendorAccountBalances> {
    const rows = await txOf(tx).execute<{ account_code: string; total: string }>(sql`
      SELECT account_code, SUM(amount_minor)::text AS total
        FROM journal_lines
       WHERE tenant_id = ${ctx.tenantId}
         AND party_id = ${vendorPartyId}
         AND account_code IN ('VENDOR_PAYABLE', 'VENDOR_ADVANCE', 'AR')
       GROUP BY account_code
    `);

    let payable = 0;
    let advance = 0;
    let receivable = 0;
    for (const row of rows.rows) {
      const total = Number(row.total);
      if (row.account_code === 'VENDOR_PAYABLE') payable = -total;
      else if (row.account_code === 'VENDOR_ADVANCE') advance = total;
      else receivable = total;
    }

    /*
     * A negative reading means the balance points the other way — an
     * over-refunded advance, say. It is shown as nothing owed rather than as a
     * negative figure a shopkeeper would read as a credit; the ledger itself
     * still carries the truth, and the statement is where it is investigated.
     */
    return {
      payableMinor: Math.max(payable, 0),
      advanceMinor: Math.max(advance, 0),
      receivableMinor: Math.max(receivable, 0),
    };
  }

  async insertPayment(
    tx: Tx,
    ctx: TenantContext,
    payment: NewVendorMoneyDocument,
  ): Promise<void> {
    const db = txOf(tx);
    const now = this.clock.now();

    await this.writeJournal(tx, ctx, payment, 'VENDOR_PAYMENT');
    await db.insert(vendorPayments).values({
      id: payment.id,
      tenantId: ctx.tenantId,
      paymentNumber: payment.number,
      vendorPartyId: payment.vendorPartyId,
      intent: payment.intent,
      amountMinor: payment.amountMinor,
      accountCode: payment.accountCode,
      cashSessionId: payment.sessionId,
      journalEntryId: payment.journalEntryId,
      note: payment.note,
      businessDate: payment.businessDate,
      operationId: payment.operationId,
      createdAt: now,
      updatedAt: now,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
      version: 1,
    });
  }

  async insertReceipt(
    tx: Tx,
    ctx: TenantContext,
    receipt: NewVendorMoneyDocument,
  ): Promise<void> {
    const db = txOf(tx);
    const now = this.clock.now();

    await this.writeJournal(tx, ctx, receipt, 'VENDOR_ADVANCE_REFUND');
    await db.insert(vendorReceipts).values({
      id: receipt.id,
      tenantId: ctx.tenantId,
      receiptNumber: receipt.number,
      vendorPartyId: receipt.vendorPartyId,
      intent: receipt.intent,
      amountMinor: receipt.amountMinor,
      accountCode: receipt.accountCode,
      cashSessionId: receipt.sessionId,
      journalEntryId: receipt.journalEntryId,
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

  private async writeJournal(
    tx: Tx,
    ctx: TenantContext,
    document: NewVendorMoneyDocument,
    sourceType: string,
  ): Promise<void> {
    const db = txOf(tx);
    const now = this.clock.now();

    await db.insert(journalEntries).values({
      id: document.journalEntryId,
      tenantId: ctx.tenantId,
      createdAt: now,
      createdBy: ctx.userId,
      businessDate: document.businessDate,
      sourceDocumentType: sourceType,
      sourceDocumentId: document.id,
      sourceNumber: document.number,
      entryMode: document.entryMode,
    });
    await db.insert(journalLines).values(
      document.journalLines.map((line) => ({
        id: line.id,
        tenantId: ctx.tenantId,
        createdAt: now,
        createdBy: ctx.userId,
        journalEntryId: document.journalEntryId,
        accountCode: line.account,
        amountMinor: line.amountMinor,
        partyId: line.partyId,
      })),
    );
  }

  async findPaymentIdByOperationId(
    tx: Tx,
    ctx: TenantContext,
    operationId: string,
  ): Promise<string | null> {
    const rows = await txOf(tx).execute<{ id: string }>(sql`
      SELECT id FROM vendor_payments
       WHERE tenant_id = ${ctx.tenantId} AND operation_id = ${operationId} LIMIT 1
    `);
    return rows.rows[0]?.id ?? null;
  }

  async findPaymentById(
    tx: Tx,
    ctx: TenantContext,
    id: string,
  ): Promise<VendorMoneyDocumentRow | null> {
    const rows = await txOf(tx).execute<RawMoneyDocument>(sql`
      SELECT id, payment_number AS number, vendor_party_id, intent, account_code,
             amount_minor::text, note, business_date::text
        FROM vendor_payments
       WHERE tenant_id = ${ctx.tenantId} AND id = ${id} LIMIT 1
    `);
    const row = rows.rows[0];
    return row === undefined ? null : toMoneyDocument(row);
  }

  async findReceiptIdByOperationId(
    tx: Tx,
    ctx: TenantContext,
    operationId: string,
  ): Promise<string | null> {
    const rows = await txOf(tx).execute<{ id: string }>(sql`
      SELECT id FROM vendor_receipts
       WHERE tenant_id = ${ctx.tenantId} AND operation_id = ${operationId} LIMIT 1
    `);
    return rows.rows[0]?.id ?? null;
  }

  async findReceiptById(
    tx: Tx,
    ctx: TenantContext,
    id: string,
  ): Promise<VendorMoneyDocumentRow | null> {
    const rows = await txOf(tx).execute<RawMoneyDocument>(sql`
      SELECT id, receipt_number AS number, vendor_party_id, intent, account_code,
             amount_minor::text, note, business_date::text
        FROM vendor_receipts
       WHERE tenant_id = ${ctx.tenantId} AND id = ${id} LIMIT 1
    `);
    const row = rows.rows[0];
    return row === undefined ? null : toMoneyDocument(row);
  }

  /**
   * The issue, the goods leaving the shelf, and where each unit came from —
   * one transaction, no journal entry.
   */
  async insertIssue(tx: Tx, ctx: TenantContext, issue: NewVendorProductIssue): Promise<void> {
    const db = txOf(tx);
    const now = this.clock.now();

    await db.insert(vendorProductIssues).values({
      id: issue.id,
      tenantId: ctx.tenantId,
      issueNumber: issue.number,
      vendorPartyId: issue.vendorPartyId,
      productId: issue.productId,
      locationId: issue.locationId,
      qty: issue.qty,
      returnedQty: 0,
      costMinor: issue.costMinor,
      movementId: issue.movementId,
      note: issue.note,
      businessDate: issue.businessDate,
      operationId: issue.operationId,
      createdAt: now,
      updatedAt: now,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
      version: 1,
    });

    for (const lot of issue.lots) {
      await db.insert(vendorProductIssueLots).values({
        id: lot.id,
        tenantId: ctx.tenantId,
        issueId: issue.id,
        lotId: lot.lotId,
        qty: lot.qty,
        unitCost: lot.unitCost,
        qtyOutstanding: lot.qty,
        createdAt: now,
        createdBy: ctx.userId,
      });

      await db
        .update(inventoryLots)
        .set({
          qtyRemaining: sql`${inventoryLots.qtyRemaining} - ${lot.qty}`,
          /*
           * A lot emptied by an issue is **not** closed. The goods are coming
           * back into it, and DR13.11's closed lot is one whose stock is gone
           * for good — closing it here would leave a return with nowhere to
           * restore to, and the cost would have to be invented.
           */
          updatedAt: now,
          updatedBy: ctx.userId,
          version: sql`${inventoryLots.version} + 1`,
        })
        .where(and(eq(inventoryLots.tenantId, ctx.tenantId), eq(inventoryLots.id, lot.lotId)));
    }

    /*
     * One movement for the issue, with no lot of its own: the provenance is in
     * `vendor_product_issue_lots`, which is finer than a movement row can be.
     */
    await db.insert(stockMovements).values({
      id: issue.movementId,
      tenantId: ctx.tenantId,
      createdAt: now,
      createdBy: ctx.userId,
      productId: issue.productId,
      locationId: issue.locationId,
      lotId: null,
      qty: issue.qty,
      direction: 'OUT',
      businessDate: issue.businessDate,
      sourceDocumentType: 'VENDOR_PRODUCT_ISSUE',
      sourceDocumentId: issue.id,
      sourceNumber: issue.number,
      unitCost: null,
    });

    await this.moveQtyOnHand(tx, ctx, issue.productId, -issue.qty);
  }

  async findIssueIdByOperationId(
    tx: Tx,
    ctx: TenantContext,
    operationId: string,
  ): Promise<string | null> {
    const rows = await txOf(tx).execute<{ id: string }>(sql`
      SELECT id FROM vendor_product_issues
       WHERE tenant_id = ${ctx.tenantId} AND operation_id = ${operationId} LIMIT 1
    `);
    return rows.rows[0]?.id ?? null;
  }

  async findIssueById(
    tx: Tx,
    ctx: TenantContext,
    id: string,
  ): Promise<VendorProductIssueRow | null> {
    const rows = await txOf(tx).execute<RawIssue>(sql`
      ${ISSUE_SELECT}
       WHERE vpi.tenant_id = ${ctx.tenantId} AND vpi.id = ${id}
       LIMIT 1
    `);
    const row = rows.rows[0];
    return row === undefined ? null : toIssue(row);
  }

  async listIssues(
    tx: Tx,
    ctx: TenantContext,
    options: { readonly vendorPartyId: string; readonly openOnly: boolean; readonly limit: number },
  ): Promise<readonly VendorProductIssueRow[]> {
    const rows = await txOf(tx).execute<RawIssue>(sql`
      ${ISSUE_SELECT}
       WHERE vpi.tenant_id = ${ctx.tenantId}
         AND vpi.vendor_party_id = ${options.vendorPartyId}
         ${options.openOnly ? sql`AND vpi.returned_qty < vpi.qty` : sql``}
       ORDER BY vpi.business_date DESC, vpi.id DESC
       LIMIT ${options.limit}
    `);
    return rows.rows.map(toIssue);
  }

  async listIssueLotsOutstanding(
    tx: Tx,
    ctx: TenantContext,
    issueId: string,
  ): Promise<
    readonly {
      readonly id: string;
      readonly lotId: string;
      readonly unitCost: number;
      readonly qtyOutstanding: number;
    }[]
  > {
    const rows = await txOf(tx).execute<{
      id: string;
      lot_id: string;
      unit_cost: string;
      qty_outstanding: string;
    }>(sql`
      SELECT id, lot_id, unit_cost::text, qty_outstanding::text
        FROM vendor_product_issue_lots
       WHERE tenant_id = ${ctx.tenantId} AND issue_id = ${issueId} AND qty_outstanding > 0
       ORDER BY id
    `);
    return rows.rows.map((row) => ({
      id: row.id,
      lotId: row.lot_id,
      unitCost: Number(row.unit_cost),
      qtyOutstanding: Number(row.qty_outstanding),
    }));
  }

  /** The goods back on the shelf, into the very lots they left. */
  async insertIssueReturn(
    tx: Tx,
    ctx: TenantContext,
    record: NewVendorIssueReturn,
  ): Promise<boolean> {
    const db = txOf(tx);
    const now = this.clock.now();

    const updated = await db.execute(sql`
      UPDATE vendor_product_issues
         SET returned_qty = ${record.returnedQtyAfter},
             updated_at = ${now}, updated_by = ${ctx.userId}, version = version + 1
       WHERE tenant_id = ${ctx.tenantId} AND id = ${record.issueId}
         AND version = ${record.issueVersion}
    `);
    if ((updated.rowCount ?? 0) === 0) return false;

    for (const restore of record.restores) {
      await db.execute(sql`
        UPDATE vendor_product_issue_lots
           SET qty_outstanding = ${restore.qtyOutstandingAfter}
         WHERE tenant_id = ${ctx.tenantId} AND id = ${restore.issueLotId}
      `);

      await db
        .update(inventoryLots)
        .set({
          qtyRemaining: sql`${inventoryLots.qtyRemaining} + ${restore.qty}`,
          /* Goods are back, so a lot closed in the meantime opens again. */
          status: 'OPEN',
          updatedAt: now,
          updatedBy: ctx.userId,
          version: sql`${inventoryLots.version} + 1`,
        })
        .where(and(eq(inventoryLots.tenantId, ctx.tenantId), eq(inventoryLots.id, restore.lotId)));
    }

    await db.insert(stockMovements).values({
      id: record.movementId,
      tenantId: ctx.tenantId,
      createdAt: now,
      createdBy: ctx.userId,
      productId: record.productId,
      locationId: record.locationId,
      lotId: null,
      qty: record.qty,
      direction: 'IN',
      businessDate: record.businessDate,
      sourceDocumentType: 'VENDOR_PRODUCT_ISSUE_RETURN',
      sourceDocumentId: record.id,
      sourceNumber: record.number,
      unitCost: null,
    });

    await db.insert(vendorProductIssueReturns).values({
      id: record.id,
      tenantId: ctx.tenantId,
      returnNumber: record.number,
      issueId: record.issueId,
      qty: record.qty,
      costMinor: record.costMinor,
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

    await this.moveQtyOnHand(tx, ctx, record.productId, record.qty);
    return true;
  }

  async findIssueReturnIdByOperationId(
    tx: Tx,
    ctx: TenantContext,
    operationId: string,
  ): Promise<string | null> {
    const rows = await txOf(tx).execute<{ id: string }>(sql`
      SELECT id FROM vendor_product_issue_returns
       WHERE tenant_id = ${ctx.tenantId} AND operation_id = ${operationId} LIMIT 1
    `);
    return rows.rows[0]?.id ?? null;
  }

  /**
   * The quantity cache follows the shelf.
   *
   * Only the quantity: the moving average does not change when stock merely
   * moves (DR13.5), and the goods come back at the cost they left at.
   */
  private async moveQtyOnHand(
    tx: Tx,
    ctx: TenantContext,
    productId: string,
    delta: number,
  ): Promise<void> {
    await txOf(tx)
      .update(productCostState)
      .set({
        qtyOnHand: sql`${productCostState.qtyOnHand} + ${delta}`,
        lastRecomputedAt: this.clock.now(),
        updatedAt: this.clock.now(),
        updatedBy: ctx.userId,
        version: sql`${productCostState.version} + 1`,
      })
      .where(
        and(eq(productCostState.tenantId, ctx.tenantId), eq(productCostState.productId, productId)),
      );
  }

  /**
   * Six kinds of document, read from the modules that own them and merged in
   * business-date order.
   *
   * A `UNION ALL` rather than an activity table: a sale's date and total belong
   * to the sale, and a copy here would be a second thing to keep in step with
   * it. The cost is one query per screen, over indexed vendor columns.
   */
  async listActivity(
    tx: Tx,
    ctx: TenantContext,
    filter: VendorActivityFilter,
  ): Promise<readonly VendorActivityRowData[]> {
    const wanted = (kind: VendorActivityKind): boolean =>
      filter.kinds.length === 0 || filter.kinds.includes(kind);

    const parts = [];

    if (wanted('VENDOR_STOCK')) {
      parts.push(sql`
        SELECT vsr.id, 'VENDOR_STOCK' AS kind, vsr.business_date::text AS business_date,
               vsr.receipt_number AS number,
               CASE WHEN b.name IS NULL OR b.name = '' THEN p.name
                    ELSE b.name || ' ' || p.name END AS description,
               vsr.qty::text AS qty,
               (vsr.qty * vsr.vendor_unit_cost / 10000)::bigint::text AS amount_minor,
               COALESCE(il.qty_remaining, 0)::text AS open_qty,
               CASE WHEN COALESCE(il.qty_remaining, 0) > 0 THEN 'Open' ELSE 'Closed' END AS status,
               'vendor_stock_receipt' AS source_type, vsr.id AS source_id
          FROM vendor_stock_receipts vsr
          JOIN products p ON p.id = vsr.product_id AND p.tenant_id = vsr.tenant_id
          LEFT JOIN brands b ON b.id = p.brand_id AND b.tenant_id = p.tenant_id
          LEFT JOIN inventory_lots il ON il.id = vsr.lot_id AND il.tenant_id = vsr.tenant_id
         WHERE vsr.tenant_id = ${ctx.tenantId} AND vsr.vendor_party_id = ${filter.vendorPartyId}
      `);
    }

    if (wanted('VENDOR_STOCK_RETURN')) {
      parts.push(sql`
        SELECT vst.id, 'VENDOR_STOCK_RETURN' AS kind, vst.business_date::text AS business_date,
               vst.return_number AS number,
               CASE WHEN b.name IS NULL OR b.name = '' THEN p.name
                    ELSE b.name || ' ' || p.name END AS description,
               vst.qty::text AS qty, NULL::text AS amount_minor, NULL::text AS open_qty,
               'Returned' AS status,
               'vendor_stock_return' AS source_type, vst.receipt_id AS source_id
          FROM vendor_stock_returns vst
          JOIN products p ON p.id = vst.product_id AND p.tenant_id = vst.tenant_id
          LEFT JOIN brands b ON b.id = p.brand_id AND b.tenant_id = p.tenant_id
         WHERE vst.tenant_id = ${ctx.tenantId} AND vst.vendor_party_id = ${filter.vendorPartyId}
      `);
    }

    if (wanted('GIVEN_TO_VENDOR')) {
      /* Temporary custody… */
      parts.push(sql`
        SELECT vpi.id, 'GIVEN_TO_VENDOR' AS kind, vpi.business_date::text AS business_date,
               vpi.issue_number AS number,
               (CASE WHEN b.name IS NULL OR b.name = '' THEN p.name
                     ELSE b.name || ' ' || p.name END) || ' — temporary issue' AS description,
               vpi.qty::text AS qty, NULL::text AS amount_minor,
               (vpi.qty - vpi.returned_qty)::text AS open_qty,
               CASE WHEN vpi.returned_qty >= vpi.qty THEN 'Settled' ELSE 'Out' END AS status,
               'vendor_product_issue' AS source_type, vpi.id AS source_id
          FROM vendor_product_issues vpi
          JOIN products p ON p.id = vpi.product_id AND p.tenant_id = vpi.tenant_id
          LEFT JOIN brands b ON b.id = p.brand_id AND b.tenant_id = p.tenant_id
         WHERE vpi.tenant_id = ${ctx.tenantId} AND vpi.vendor_party_id = ${filter.vendorPartyId}
      `);
      /* …and goods charged to them, which are ordinary invoices. */
      parts.push(sql`
        SELECT s.id, 'GIVEN_TO_VENDOR' AS kind, s.business_date::text AS business_date,
               s.sale_number AS number,
               'Charged to vendor' AS description,
               NULL::text AS qty, s.grand_total_minor::text AS amount_minor,
               NULL::text AS open_qty,
               s.status AS status,
               'sale' AS source_type, s.id AS source_id
          FROM sales s
         WHERE s.tenant_id = ${ctx.tenantId} AND s.party_id = ${filter.vendorPartyId}
           AND s.status <> 'VOIDED'
      `);
    }

    if (wanted('RECEIVED_BACK')) {
      parts.push(sql`
        SELECT vpr.id, 'RECEIVED_BACK' AS kind, vpr.business_date::text AS business_date,
               vpr.return_number AS number,
               (CASE WHEN b.name IS NULL OR b.name = '' THEN p.name
                     ELSE b.name || ' ' || p.name END) || ' — back from vendor' AS description,
               vpr.qty::text AS qty, NULL::text AS amount_minor, NULL::text AS open_qty,
               'Received' AS status,
               'vendor_product_issue' AS source_type, vpr.issue_id AS source_id
          FROM vendor_product_issue_returns vpr
          JOIN vendor_product_issues vpi ON vpi.id = vpr.issue_id AND vpi.tenant_id = vpr.tenant_id
          JOIN products p ON p.id = vpi.product_id AND p.tenant_id = vpi.tenant_id
          LEFT JOIN brands b ON b.id = p.brand_id AND b.tenant_id = p.tenant_id
         WHERE vpr.tenant_id = ${ctx.tenantId} AND vpi.vendor_party_id = ${filter.vendorPartyId}
      `);
    }

    if (wanted('PAYMENT')) {
      parts.push(sql`
        SELECT vp.id, 'PAYMENT' AS kind, vp.business_date::text AS business_date,
               vp.payment_number AS number,
               CASE WHEN vp.intent = 'ADVANCE' THEN 'Advance payment'
                    ELSE 'Settled payable' END AS description,
               NULL::text AS qty, vp.amount_minor::text AS amount_minor, NULL::text AS open_qty,
               'Paid' AS status,
               'vendor_payment' AS source_type, vp.id AS source_id
          FROM vendor_payments vp
         WHERE vp.tenant_id = ${ctx.tenantId} AND vp.vendor_party_id = ${filter.vendorPartyId}
      `);
    }

    if (wanted('RECEIPT')) {
      parts.push(sql`
        SELECT vr.id, 'RECEIPT' AS kind, vr.business_date::text AS business_date,
               vr.receipt_number AS number,
               'Advance refunded' AS description,
               NULL::text AS qty, vr.amount_minor::text AS amount_minor, NULL::text AS open_qty,
               'Received' AS status,
               'vendor_receipt' AS source_type, vr.id AS source_id
          FROM vendor_receipts vr
         WHERE vr.tenant_id = ${ctx.tenantId} AND vr.vendor_party_id = ${filter.vendorPartyId}
      `);
      /* Money settling goods charged to them is a customer receipt. */
      parts.push(sql`
        SELECT cr.id, 'RECEIPT' AS kind, cr.business_date::text AS business_date,
               cr.receipt_number AS number,
               'Settled receivable' AS description,
               NULL::text AS qty, cr.amount_minor::text AS amount_minor, NULL::text AS open_qty,
               cr.status AS status,
               'customer_receipt' AS source_type, cr.id AS source_id
          FROM customer_receipts cr
         WHERE cr.tenant_id = ${ctx.tenantId} AND cr.customer_party_id = ${filter.vendorPartyId}
      `);
    }

    if (wanted('PRODUCT_SETTLEMENT')) {
      parts.push(sql`
        SELECT vps.id, 'PRODUCT_SETTLEMENT' AS kind, vps.business_date::text AS business_date,
               vps.settlement_number AS number,
               'Products received against receivable' AS description,
               NULL::text AS qty, vps.net_product_minor::text AS amount_minor,
               NULL::text AS open_qty, 'Posted' AS status,
               'purchase' AS source_type, vps.purchase_id AS source_id
          FROM vendor_product_settlements vps
         WHERE vps.tenant_id = ${ctx.tenantId} AND vps.vendor_party_id = ${filter.vendorPartyId}
      `);
    }

    if (parts.length === 0) return [];

    const unioned = parts.reduce((left, right) => sql`${left} UNION ALL ${right}`);
    const rows = await txOf(tx).execute<{
      id: string;
      kind: string;
      business_date: string;
      number: string;
      description: string;
      qty: string | null;
      amount_minor: string | null;
      open_qty: string | null;
      status: string;
      source_type: string;
      source_id: string;
    }>(sql`
      SELECT * FROM (${unioned}) AS activity
       ORDER BY business_date DESC, id DESC
       LIMIT ${filter.limit}
    `);

    return rows.rows.map((row) => ({
      id: row.id,
      kind: row.kind as VendorActivityKind,
      businessDate: row.business_date,
      number: row.number,
      description: row.description,
      qty: row.qty === null ? null : Number(row.qty),
      amountMinor: row.amount_minor === null ? null : Number(row.amount_minor),
      openQty: row.open_qty === null ? null : Number(row.open_qty),
      status: row.status,
      sourceType: row.source_type,
      sourceId: row.source_id,
    }));
  }
}
