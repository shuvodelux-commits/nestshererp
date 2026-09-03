import type {
  ApprovalCandidate,
  LineConsumptionRow,
  NewSalesReturn,
  RefundCaps,
  ReturnableInvoiceRow,
  SalesReturnFilter,
  SalesReturnRepository,
  SalesReturnRow,
  TenantContext,
  Tx,
  SalesReturnForReversal,
  SalesReturnReversal,
} from '@sher/core-application';
import { Ulid } from '@sher/shared-utils';
import type { Clock } from '@sher/shared-utils';
import { and, gte, asc, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';

import {
  accounts,
  inventoryLots,
  inventoryUnits,
  journalEntries,
  journalLines,
  lotConsumptions,
  parties,
  productCostState,
  products,
  roles,
  saleLines,
  saleLineSourceAllocations,
  saleSourceAllocationReversals,
  sales,
  salesReturnLines,
  salesReturns,
  stockMovements,
  units,
  users,
} from './schema';
import { txOf } from './unit-of-work';

/**
 * Sales returns over PostgreSQL. No business rule lives here (R-B6) — the
 * service decides what may come back and what it is worth; this writes the rows
 * and reads them back.
 *
 * **How much of a line has already been returned is computed, never stored**:
 * `Σ sales_return_lines.qty` per sale line, in the same statement as the line it
 * caps. The same argument 0015 makes for a party balance and 0017 for a bill's
 * outstanding — a stored counter is a second answer, and the first path that
 * forgets to bump it lets a shop take back four of three.
 */
function returnedQty(saleLineId: SQL): SQL<number> {
  return sql<number>`COALESCE((
    SELECT SUM(srl.qty)
      FROM sales_return_lines srl
      JOIN sales_returns sr ON sr.id = srl.return_id
     WHERE srl.sale_line_id = ${saleLineId}
       AND sr.status = 'POSTED'
       AND sr.deleted_at IS NULL
  ), 0)::bigint`;
}

/**
 * What an invoice still owes, with returns taken off.
 *
 * A credit that cleared this invoice reduces what is owed on it, exactly as a
 * receipt allocation does; a refund does not, because that money was handed
 * back rather than applied. This is the same expression `sale-repository` uses,
 * extended with the third term — and it is deliberately repeated rather than
 * imported, because a query that reads its own tables is checkable on its own.
 */
function creditedMinor(saleId: SQL): SQL<number> {
  return sql<number>`COALESCE((
    SELECT SUM(sr.settled_minor)
      FROM sales_returns sr
     WHERE sr.sale_id = ${saleId}
       AND sr.status = 'POSTED'
       AND sr.deleted_at IS NULL
  ), 0)::bigint`;
}

const INVOICE_DUE_MINOR = sql<number>`(
  ${sales.grandTotalMinor} - ${sales.paidMinor}
  - COALESCE((SELECT SUM(ra.amount_minor) FROM receipt_allocations ra WHERE ra.sale_id = ${sales.id}), 0)
  - COALESCE((SELECT SUM(vrsa.amount_minor) FROM vendor_receivable_settlement_allocations vrsa WHERE vrsa.sale_id = ${sales.id}), 0)
  - ${creditedMinor(sql`${sales.id}`)}
)::bigint`;

export class PostgresSalesReturnRepository implements SalesReturnRepository {
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

  async findReturnableInvoice(
    tx: Tx,
    ctx: TenantContext,
    saleId: string,
  ): Promise<ReturnableInvoiceRow | null> {
    const db = txOf(tx);

    const heads = await db
      .select({
        id: sales.id,
        number: sales.saleNumber,
        businessDate: sales.businessDate,
        status: sales.status,
        partyId: sales.partyId,
        isWalkIn: parties.isSystemReserved,
        customerName: sales.customerNameSnapshot,
        customerPhone: sales.customerPhoneSnapshot,
        customerGuardianName: sales.customerGuardianNameSnapshot,
        customerAddress: sales.customerAddressSnapshot,
        locationId: sales.locationId,
        grandTotalMinor: sales.grandTotalMinor,
        dueMinor: INVOICE_DUE_MINOR,
      })
      .from(sales)
      .innerJoin(parties, eq(parties.id, sales.partyId))
      .where(and(eq(sales.tenantId, ctx.tenantId), eq(sales.id, saleId), isNull(sales.deletedAt)))
      .limit(1);

    const head = heads[0];
    if (head === undefined) return null;

    const lines = await db
      .select({
        saleLineId: saleLines.id,
        productId: saleLines.productId,
        productName: products.name,
        unitName: units.name,
        locationId: sales.locationId,
        qtySold: saleLines.qty,
        qtyReturned: returnedQty(sql`${saleLines.id}`),
        unitPriceMinor: saleLines.unitPriceMinor,
        netAmountMinor: saleLines.netAmountMinor,
        costMinor: saleLines.costMinor,
        source: saleLines.source,
      })
      .from(saleLines)
      .innerJoin(sales, eq(sales.id, saleLines.saleId))
      .innerJoin(products, eq(products.id, saleLines.productId))
      .innerJoin(units, eq(units.id, products.baseUnitId))
      .where(and(eq(saleLines.tenantId, ctx.tenantId), eq(saleLines.saleId, saleId)))
      .orderBy(asc(saleLines.lineNo));

    return {
      saleId: head.id.trim(),
      number: head.number,
      businessDate: head.businessDate,
      status: head.status === 'VOIDED' ? 'VOIDED' : 'POSTED',
      partyId: head.partyId.trim(),
      isWalkIn: head.isWalkIn,
      customerName: head.customerName,
      customerPhone: head.customerPhone,
      customerGuardianName: head.customerGuardianName,
      customerAddress: head.customerAddress,
      locationId: head.locationId.trim(),
      grandTotalMinor: Number(head.grandTotalMinor),
      dueMinor: Number(head.dueMinor),
      lines: lines.map((line) => ({
        saleLineId: line.saleLineId.trim(),
        productId: line.productId.trim(),
        productName: line.productName,
        unitName: line.unitName,
        locationId: line.locationId.trim(),
        qtySold: Number(line.qtySold),
        qtyReturned: Number(line.qtyReturned),
        unitPriceMinor: Number(line.unitPriceMinor),
        netAmountMinor: Number(line.netAmountMinor),
        costMinor: Number(line.costMinor),
        source: line.source === 'VENDOR_CONSIGNMENT' ? 'VENDOR_CONSIGNMENT' : 'OWN_STOCK',
      })),
    };
  }

  /**
   * Which lots each line took stock from, oldest consumption first.
   *
   * `lot_consumptions` is keyed by the movement, and a sale line carries its own
   * `movement_id`, so the join is exact: the goods go back into the lots that
   * particular line emptied, at the cost that line actually paid.
   */
  async lineConsumptions(
    tx: Tx,
    ctx: TenantContext,
    saleId: string,
  ): Promise<readonly LineConsumptionRow[]> {
    const rows = await txOf(tx)
      .select({
        saleLineId: saleLines.id,
        lotId: lotConsumptions.lotId,
        qty: lotConsumptions.qty,
        unitCostUsed: lotConsumptions.unitCostUsed,
      })
      .from(lotConsumptions)
      .innerJoin(saleLines, eq(saleLines.movementId, lotConsumptions.movementId))
      .where(
        and(
          eq(lotConsumptions.tenantId, ctx.tenantId),
          eq(saleLines.saleId, saleId),
          isNull(lotConsumptions.supersededBy),
        ),
      )
      .orderBy(asc(lotConsumptions.createdAt), asc(lotConsumptions.id));

    return rows.map((row) => ({
      saleLineId: row.saleLineId.trim(),
      lotId: row.lotId.trim(),
      qty: Number(row.qty),
      unitCostUsed: Number(row.unitCostUsed),
    }));
  }

  async sourceAllocations(tx: Tx, ctx: TenantContext, saleId: string) {
    const rows = await txOf(tx)
      .select({
        id: saleLineSourceAllocations.id,
        saleLineId: saleLineSourceAllocations.saleLineId,
        sourceType: saleLineSourceAllocations.sourceType,
        qty: saleLineSourceAllocations.qty,
        ownedLotId: saleLineSourceAllocations.ownedLotId,
        vendorPartyId: saleLineSourceAllocations.vendorPartyId,
        vendorLotId: saleLineSourceAllocations.vendorLotId,
        inventoryUnitId: saleLineSourceAllocations.inventoryUnitId,
        serialNo: inventoryUnits.serialNo,
        unitCostUsed: saleLineSourceAllocations.unitCostUsed,
        reversedQty: sql<number>`COALESCE((
          SELECT SUM(sar.qty)
            FROM sale_source_allocation_reversals sar
            JOIN sales_returns sr
              ON sr.tenant_id = sar.tenant_id AND sr.id = sar.source_document_id
           WHERE sar.tenant_id = ${ctx.tenantId}
             AND sar.source_allocation_id = ${saleLineSourceAllocations.id}
             AND sar.source_document_type = 'SALES_RETURN'
             AND sr.status = 'POSTED' AND sr.deleted_at IS NULL
        ), 0)::bigint`,
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
          eq(saleLineSourceAllocations.saleId, saleId),
        ),
      )
      .orderBy(asc(saleLineSourceAllocations.createdAt), asc(saleLineSourceAllocations.id));

    return rows.map((row) => ({
      id: row.id.trim(),
      saleLineId: row.saleLineId.trim(),
      sourceType: row.sourceType as 'OWNED' | 'VENDOR' | 'NEGATIVE',
      qty: Number(row.qty),
      reversedQty: Number(row.reversedQty),
      ownedLotId: row.ownedLotId?.trim() ?? null,
      vendorPartyId: row.vendorPartyId?.trim() ?? null,
      vendorLotId: row.vendorLotId?.trim() ?? null,
      inventoryUnitId: row.inventoryUnitId?.trim() ?? null,
      serialNo: row.serialNo,
      unitCostUsed: Number(row.unitCostUsed ?? 0),
    }));
  }

  /** What earlier returns already put back, so a lot cannot be overfilled. */
  async refillsSoFar(
    tx: Tx,
    ctx: TenantContext,
    saleId: string,
  ): Promise<readonly { readonly saleLineId: string; readonly lotId: string; readonly qty: number }[]> {
    const rows = await txOf(tx)
      .select({
        saleLineId: salesReturnLines.saleLineId,
        lotId: lotConsumptions.lotId,
        qty: lotConsumptions.qty,
      })
      .from(salesReturnLines)
      .innerJoin(salesReturns, eq(salesReturns.id, salesReturnLines.returnId))
      .innerJoin(lotConsumptions, eq(lotConsumptions.movementId, salesReturnLines.movementId))
      .where(
        and(
          eq(salesReturnLines.tenantId, ctx.tenantId),
          eq(salesReturns.saleId, saleId),
          eq(salesReturns.status, 'POSTED'),
          isNull(salesReturns.deletedAt),
        ),
      );

    return rows.map((row) => ({
      saleLineId: row.saleLineId.trim(),
      lotId: row.lotId.trim(),
      qty: Number(row.qty),
    }));
  }

  async cashRefundedToday(
    tx: Tx,
    ctx: TenantContext,
    userId: string,
    businessDate: string,
  ): Promise<number> {
    const rows = await txOf(tx)
      .select({ total: sql<number>`COALESCE(SUM(${salesReturns.refundMinor}), 0)::bigint` })
      .from(salesReturns)
      .where(
        and(
          eq(salesReturns.tenantId, ctx.tenantId),
          eq(salesReturns.createdBy, userId),
          eq(salesReturns.businessDate, businessDate),
          eq(salesReturns.status, 'POSTED'),
          isNull(salesReturns.deletedAt),
        ),
      );
    return Number(rows[0]?.total ?? 0);
  }

  async refundCapsOf(tx: Tx, ctx: TenantContext, userId: string): Promise<RefundCaps> {
    const rows = await txOf(tx)
      .select({
        perReturn: roles.cashRefundPerReturnMinor,
        perDay: roles.cashRefundPerDayMinor,
      })
      .from(users)
      .innerJoin(roles, eq(roles.id, users.roleId))
      .where(and(eq(users.tenantId, ctx.tenantId), eq(users.id, userId), isNull(users.deletedAt)))
      .limit(1);

    const row = rows[0];
    // No row is not "unlimited": a caller the query cannot find refunds nothing.
    if (row === undefined) return { perReturnMinor: 0, perDayMinor: 0 };
    return {
      perReturnMinor: row.perReturn === null ? null : Number(row.perReturn),
      perDayMinor: row.perDay === null ? null : Number(row.perDay),
    };
  }

  /**
   * Who could approve this refund: a live user whose **own** role would allow
   * it, both per return and for what they have already refunded today.
   *
   * Filtered here rather than in the service so a PIN is never compared against
   * somebody who could not have approved it — the comparison itself is the thing
   * that would leak who holds which limit.
   */
  async approvalCandidates(
    tx: Tx,
    ctx: TenantContext,
    refundMinor: number,
    businessDate: string,
  ): Promise<readonly ApprovalCandidate[]> {
    const spentToday = sql<number>`COALESCE((
      SELECT SUM(sr.refund_minor)
        FROM sales_returns sr
       WHERE sr.created_by = ${users.id}
         AND sr.business_date = ${businessDate}
         AND sr.status = 'POSTED'
         AND sr.deleted_at IS NULL
    ), 0)::bigint`;

    const rows = await txOf(tx)
      .select({ userId: users.id, displayName: users.displayName, pinHash: users.pinHash })
      .from(users)
      .innerJoin(roles, eq(roles.id, users.roleId))
      .where(
        and(
          eq(users.tenantId, ctx.tenantId),
          isNull(users.deletedAt),
          isNull(roles.deletedAt),
          sql`${users.pinHash} IS NOT NULL`,
          // Their own per-return cap must cover it …
          or(
            isNull(roles.cashRefundPerReturnMinor),
            sql`${roles.cashRefundPerReturnMinor} >= ${refundMinor}`,
          ),
          // … and so must what is left of their own day.
          or(
            isNull(roles.cashRefundPerDayMinor),
            sql`${roles.cashRefundPerDayMinor} >= ${spentToday} + ${refundMinor}`,
          ),
          // Somebody who may not take a return at all cannot approve one.
          sql`EXISTS (
            SELECT 1 FROM role_permissions rp
             WHERE rp.role_id = ${users.roleId}
               AND rp.permission_code = 'sales.return.create'
               AND rp.deleted_at IS NULL
          )`,
        ),
      );

    return rows.flatMap((row) =>
      row.pinHash === null
        ? []
        : [{ userId: row.userId.trim(), displayName: row.displayName, pinHash: row.pinHash }],
    );
  }

  /**
   * The whole return in one call: the document, its lines, the goods back into
   * their lots, the moving-average cache and one journal entry.
   *
   * Called inside the service's transaction — either all of it lands or none of
   * it does, which is what stops goods being back on the shelf with no refund
   * recorded against them.
   */
  async findReturnForReversal(
    tx: Tx,
    ctx: TenantContext,
    returnId: string,
  ): Promise<SalesReturnForReversal | null> {
    const db = txOf(tx);

    const head = await db.execute<{
      id: string; number: string; status: string; business_date: string; version: number;
      cogs_minor: string;
    }>(sql`
      SELECT r.id, r.return_number AS number, r.status, r.business_date::text AS business_date,
             r.version, r.cogs_minor::text AS cogs_minor
        FROM sales_returns r
       WHERE r.tenant_id = ${ctx.tenantId} AND r.id = ${returnId}
       LIMIT 1
    `);
    const row = head.rows[0];
    if (row === undefined) return null;

    const journal = await db.execute<{
      account_code: string; amount_minor: string; party_id: string | null;
    }>(sql`
      SELECT jl.account_code, jl.amount_minor::text AS amount_minor, jl.party_id
        FROM journal_lines jl
        JOIN journal_entries je ON je.tenant_id = jl.tenant_id AND je.id = jl.journal_entry_id
       WHERE jl.tenant_id = ${ctx.tenantId}
         AND je.source_document_id = ${returnId}
         AND je.source_document_type = 'SALES_RETURN'
       ORDER BY jl.id
    `);

    const lines = await db.execute<{
      sale_line_id: string; product_id: string; location_id: string; qty: string; cost_minor: string;
    }>(sql`
      SELECT l.sale_line_id, l.product_id, r.location_id, l.qty::text AS qty, l.cost_minor::text AS cost_minor
        FROM sales_return_lines l
        JOIN sales_returns r ON r.tenant_id = l.tenant_id AND r.id = l.return_id
       WHERE l.tenant_id = ${ctx.tenantId} AND l.return_id = ${returnId}
       ORDER BY l.line_no
    `);

    /*
     * What went back into which lot, and what is in that lot **now** — the
     * difference is what stops a cancellation from taking back goods that have
     * since been sold again.
     */
    const refills = await db.execute<{
      sale_line_id: string; product_id: string; lot_id: string; qty: string; lot_remaining: string;
    }>(sql`
      SELECT lc.lot_id, c.qty::text AS qty, il.qty_remaining::text AS lot_remaining,
             il.product_id, srl.sale_line_id
        FROM lot_consumptions c
        JOIN lot_consumptions lc ON lc.id = c.id
        JOIN inventory_lots il ON il.tenant_id = c.tenant_id AND il.id = c.lot_id
        JOIN sales_return_lines srl ON srl.tenant_id = c.tenant_id AND srl.movement_id = c.movement_id
       WHERE c.tenant_id = ${ctx.tenantId}
         AND c.document_type = 'SALES_RETURN'
         AND c.document_id = ${returnId}
    `);

    const origins = await db.execute<{
      sale_line_id: string; source_type: string; qty: string; owned_lot_id: string | null;
      vendor_lot_id: string | null; vendor_lot_remaining: string; inventory_unit_id: string | null;
      unit_cost_used: string;
      serial_previous_status: string | null; serial_sale_id: string | null;
      serial_sale_line_id: string | null; serial_customer_party_id: string | null;
      serial_sold_date: string | null; serial_customer_warranty_months: number | null;
    }>(sql`
      SELECT a.sale_line_id, a.source_type, r.qty::text, a.owned_lot_id, a.vendor_lot_id,
             COALESCE(vl.qty_remaining, 0)::text AS vendor_lot_remaining,
             a.inventory_unit_id, COALESCE(a.unit_cost_used, 0)::text AS unit_cost_used,
             r.serial_previous_status, r.serial_sale_id, r.serial_sale_line_id,
             r.serial_customer_party_id, r.serial_sold_date::text,
             r.serial_customer_warranty_months
        FROM sale_source_allocation_reversals r
        JOIN sale_line_source_allocations a
          ON a.tenant_id = r.tenant_id AND a.id = r.source_allocation_id
        LEFT JOIN inventory_lots vl
          ON vl.tenant_id = a.tenant_id AND vl.id = a.vendor_lot_id
       WHERE r.tenant_id = ${ctx.tenantId}
         AND r.source_document_type = 'SALES_RETURN'
         AND r.source_document_id = ${returnId}
       ORDER BY r.id
    `);

    const states = await db.execute<{
      id: string; product_id: string; location_id: string; qty_on_hand: string;
      avg_unit_cost: string;
    }>(sql`
      SELECT s.id, s.product_id, s.location_id, s.qty_on_hand::text AS qty_on_hand,
             s.avg_unit_cost::text AS avg_unit_cost
        FROM product_cost_state s
       WHERE s.tenant_id = ${ctx.tenantId}
         AND s.product_id IN (
           SELECT l.product_id FROM sales_return_lines l
            WHERE l.tenant_id = ${ctx.tenantId} AND l.return_id = ${returnId}
         )
    `);

    return {
      id: row.id.trim(),
      number: row.number,
      status: row.status,
      businessDate: row.business_date,
      version: row.version,
      cogsMinor: Number(row.cogs_minor),
      journalLines: journal.rows.map((line) => ({
        account: line.account_code,
        amountMinor: Number(line.amount_minor),
        partyId: line.party_id === null ? null : line.party_id.trim(),
      })),
      lines: lines.rows.map((line) => ({
        saleLineId: line.sale_line_id.trim(),
        productId: line.product_id.trim(),
        locationId: line.location_id.trim(),
        qty: Number(line.qty),
        costMinor: Number(line.cost_minor),
        refills: refills.rows
          .filter((refill) => refill.sale_line_id.trim() === line.sale_line_id.trim())
          .map((refill) => ({
            lotId: refill.lot_id.trim(),
            qty: Number(refill.qty),
            lotRemaining: Number(refill.lot_remaining),
          })),
      })),
      sourceOrigins: origins.rows.map((origin) => ({
        saleLineId: origin.sale_line_id.trim(),
        sourceType: origin.source_type as 'OWNED' | 'VENDOR' | 'NEGATIVE',
        qty: Number(origin.qty),
        ownedLotId: origin.owned_lot_id?.trim() ?? null,
        vendorLotId: origin.vendor_lot_id?.trim() ?? null,
        vendorLotRemaining: Number(origin.vendor_lot_remaining),
        inventoryUnitId: origin.inventory_unit_id?.trim() ?? null,
        unitCostUsed: Number(origin.unit_cost_used),
        serialPreviousStatus: origin.serial_previous_status,
        serialSaleId: origin.serial_sale_id?.trim() ?? null,
        serialSaleLineId: origin.serial_sale_line_id?.trim() ?? null,
        serialCustomerPartyId: origin.serial_customer_party_id?.trim() ?? null,
        serialSoldDate: origin.serial_sold_date,
        serialCustomerWarrantyMonths: origin.serial_customer_warranty_months,
      })),
      costStates: states.rows.map((state) => ({
        id: state.id.trim(),
        productId: state.product_id.trim(),
        locationId: state.location_id.trim(),
        qtyOnHand: Number(state.qty_on_hand),
        avgUnitCost: Number(state.avg_unit_cost),
      })),
    };
  }

  /**
   * Undoing one sales return: the goods leave the shelf again through the very
   * lots they were put back into, the refund or credit is reversed, and the
   * document stays, marked `VOIDED` with its reason (§2.5).
   */
  async reverseSalesReturn(
    tx: Tx,
    ctx: TenantContext,
    reversal: SalesReturnReversal,
  ): Promise<boolean> {
    const db = txOf(tx);
    const now = this.clock.now();

    const updated = await db
      .update(salesReturns)
      .set({
        status: 'VOIDED',
        voidReason: reversal.reason,
        updatedAt: now,
        updatedBy: ctx.userId,
        version: sql`${salesReturns.version} + 1`,
      })
      .where(
        and(
          eq(salesReturns.tenantId, ctx.tenantId),
          eq(salesReturns.id, reversal.returnId),
          eq(salesReturns.version, reversal.expectedVersion),
          eq(salesReturns.status, 'POSTED'),
        ),
      )
      .returning({ id: salesReturns.id, number: salesReturns.returnNumber });
    const saved = updated[0];
    if (saved === undefined) return false;

    for (const line of reversal.lines) {
      await db.insert(stockMovements).values({
        id: line.movementId,
        tenantId: ctx.tenantId,
        createdAt: now,
        createdBy: ctx.userId,
        productId: line.productId,
        locationId: line.locationId,
        lotId: null,
        qty: line.qty,
        direction: 'OUT',
        businessDate: reversal.businessDate,
        sourceDocumentType: 'SALES_RETURN_REVERSAL',
        sourceDocumentId: reversal.returnId,
        sourceNumber: saved.number,
        unitCost: line.qty === 0 ? 0 : Math.round((line.costMinor * 100_000) / line.qty),
      });

      for (const take of line.takeBack) {
        const taken = await db
          .update(inventoryLots)
          .set({
            qtyRemaining: sql`${inventoryLots.qtyRemaining} - ${take.qty}`,
            // A lot emptied again closes again (DR13.11).
            status: sql`CASE WHEN ${inventoryLots.qtyRemaining} - ${take.qty} <= 0 THEN 'CLOSED' ELSE 'OPEN' END`,
            updatedAt: now,
            updatedBy: ctx.userId,
            version: sql`${inventoryLots.version} + 1`,
          })
          .where(
            and(
              eq(inventoryLots.tenantId, ctx.tenantId),
              eq(inventoryLots.id, take.lotId),
              gte(inventoryLots.qtyRemaining, take.qty),
            ),
          )
          .returning({ id: inventoryLots.id });
        if (taken.length !== 1) {
          throw new Error('Returned owned stock moved before the return could be voided');
        }
      }
    }

    /*
     * The vendor's goods leave the vendor's lot again. Nothing is posted for
     * them: they were never the shop's stock and never entered its valuation —
     * the return's own `VENDOR_PAYABLE` line is undone with the rest of the
     * entry.
     */
    for (const take of reversal.vendorTakes) {
      const taken = await db
        .update(inventoryLots)
        .set({
          qtyRemaining: sql`${inventoryLots.qtyRemaining} - ${take.qty}`,
          updatedAt: now,
          updatedBy: ctx.userId,
          version: sql`${inventoryLots.version} + 1`,
        })
        .where(
          and(
            eq(inventoryLots.tenantId, ctx.tenantId),
            eq(inventoryLots.id, take.lotId),
            eq(inventoryLots.ownerType, 'VENDOR'),
            gte(inventoryLots.qtyRemaining, take.qty),
          ),
        )
        .returning({ id: inventoryLots.id });
      if (taken.length !== 1) {
        throw new Error('Returned vendor stock moved before the return could be voided');
      }
    }

    /*
     * A serial the return put back on the shelf goes back to the customer it
     * was sold to, with the sale, the date and the warranty it carried — read
     * from what was captured when the return took it back, never guessed.
     */
    for (const restore of reversal.serialRestores) {
      const restored = await db
        .update(inventoryUnits)
        .set({
          status: restore.status,
          saleId: restore.saleId,
          saleLineId: restore.saleLineId,
          customerPartyId: restore.customerPartyId,
          soldDate: restore.soldDate,
          customerWarrantyMonths: restore.customerWarrantyMonths,
          updatedAt: now,
          updatedBy: ctx.userId,
          version: sql`${inventoryUnits.version} + 1`,
        })
        .where(
          and(
            eq(inventoryUnits.tenantId, ctx.tenantId),
            eq(inventoryUnits.id, restore.unitId),
            eq(inventoryUnits.status, 'IN_STOCK'),
          ),
        )
        .returning({ id: inventoryUnits.id });
      if (restored.length !== 1) {
        throw new Error('Returned serial moved before the return could be voided');
      }
    }

    for (const state of reversal.costStates) {
      if (!state.exists) continue;
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
    }

    await db.insert(journalEntries).values({
      id: reversal.journalEntryId,
      tenantId: ctx.tenantId,
      createdAt: now,
      createdBy: ctx.userId,
      businessDate: reversal.businessDate,
      sourceDocumentType: 'SALES_RETURN_REVERSAL',
      sourceDocumentId: reversal.returnId,
      sourceNumber: saved.number,
      entryMode: reversal.entryMode,
    });
    await db.insert(journalLines).values(
      reversal.journalLines.map((line) => ({
        id: line.id,
        tenantId: ctx.tenantId,
        createdAt: now,
        createdBy: ctx.userId,
        journalEntryId: reversal.journalEntryId,
        accountCode: line.account,
        amountMinor: line.amountMinor,
        partyId: line.partyId,
      })),
    );

    return true;
  }

  async postSalesReturn(tx: Tx, ctx: TenantContext, draft: NewSalesReturn): Promise<void> {
    const db = txOf(tx);
    const now = this.clock.now();

    await db.insert(salesReturns).values({
      id: draft.id,
      tenantId: ctx.tenantId,
      returnNumber: draft.number,
      saleId: draft.saleId,
      partyId: draft.partyId,
      customerNameSnapshot: draft.customerName,
      locationId: draft.locationId,
      reason: draft.reason,
      note: draft.note,
      returnValueMinor: draft.returnValueMinor,
      refundMinor: draft.refundMinor,
      creditMinor: draft.creditMinor,
      settledMinor: draft.settledMinor,
      cogsMinor: draft.cogsMinor,
      refundAccountCode: draft.refundAccountCode,
      approvedBy: draft.approvedBy,
      businessDate: draft.businessDate,
      entryMode: draft.entryMode,
      backdateReason: draft.backdateReason,
      status: 'POSTED',
      operationId: draft.operationId,
      createdAt: now,
      updatedAt: now,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
      version: 1,
    });

    for (const line of draft.lines) {
      /*
       * One movement for the whole quantity that came back, whoever owns it —
       * the mirror of the sale's single OUT (§5.7). `stock_movements` is the
       * trail of goods over the counter, not of ownership: a vendor's
       * consignment came in on a receipt movement and left on the sale's, so it
       * comes back on this one. What only the shop's own goods may touch is the
       * valuation, and that moves through `costStates`.
       */
      await db.insert(stockMovements).values({
        id: line.movementId,
        tenantId: ctx.tenantId,
        createdAt: now,
        createdBy: ctx.userId,
        productId: line.productId,
        locationId: line.locationId,
        lotId: null,
        qty: line.qty,
        direction: 'IN',
        businessDate: draft.businessDate,
        sourceDocumentType: 'SALES_RETURN',
        sourceDocumentId: draft.id,
        sourceNumber: draft.number,
        unitCost: line.qty === 0 ? 0 : Math.round((line.costMinor * 100_000) / line.qty),
      });

      /*
       * The refill is written as a lot consumption of negative quantity — the
       * same rows the sale wrote, mirrored — so that "what has this lot given
       * out" and "what has come back into it" are one trail, and the next
       * return can see what this one already put back.
       */
      for (const refill of line.refills) {
        await db.insert(lotConsumptions).values({
          id: Ulid.generate(this.clock),
          tenantId: ctx.tenantId,
          createdAt: now,
          createdBy: ctx.userId,
          movementId: line.movementId,
          lotId: refill.lotId,
          qty: refill.qty,
          unitCostUsed: refill.unitCostUsed,
          documentType: 'SALES_RETURN',
          documentId: draft.id,
          businessDate: draft.businessDate,
          supersededBy: null,
        });

        await db
          .update(inventoryLots)
          .set({
            qtyRemaining: sql`${inventoryLots.qtyRemaining} + ${refill.qty}`,
            // A lot the sale emptied opens again with the goods back in it.
            status: 'OPEN',
            updatedAt: now,
            updatedBy: ctx.userId,
            version: sql`${inventoryLots.version} + 1`,
          })
          .where(and(eq(inventoryLots.tenantId, ctx.tenantId), eq(inventoryLots.id, refill.lotId)));
      }

      await db.insert(salesReturnLines).values({
        id: line.id,
        tenantId: ctx.tenantId,
        returnId: draft.id,
        lineNo: line.lineNo,
        saleLineId: line.saleLineId,
        productId: line.productId,
        qty: line.qty,
        valueMinor: line.valueMinor,
        costMinor: line.costMinor,
        movementId: line.movementId,
        createdAt: now,
        createdBy: ctx.userId,
      });

      for (const restoration of line.vendorRestorations) {
        await db
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
          );
      }

      for (const reversal of line.sourceReversals) {
        const snapshots = await db
          .select({
            status: inventoryUnits.status,
            saleId: inventoryUnits.saleId,
            saleLineId: inventoryUnits.saleLineId,
            customerPartyId: inventoryUnits.customerPartyId,
            soldDate: inventoryUnits.soldDate,
            customerWarrantyMonths: inventoryUnits.customerWarrantyMonths,
          })
          .from(saleLineSourceAllocations)
          .leftJoin(
            inventoryUnits,
            and(
              eq(inventoryUnits.tenantId, ctx.tenantId),
              eq(inventoryUnits.id, saleLineSourceAllocations.inventoryUnitId),
            ),
          )
          .where(
            and(
              eq(saleLineSourceAllocations.tenantId, ctx.tenantId),
              eq(saleLineSourceAllocations.id, reversal.sourceAllocationId),
            ),
          )
          .limit(1);
        const snapshot = snapshots[0];
        await db.insert(saleSourceAllocationReversals).values({
          id: reversal.id,
          tenantId: ctx.tenantId,
          sourceAllocationId: reversal.sourceAllocationId,
          sourceDocumentType: 'SALES_RETURN',
          sourceDocumentId: draft.id,
          qty: reversal.qty,
          serialPreviousStatus: snapshot?.status ?? null,
          serialSaleId: snapshot?.saleId ?? null,
          serialSaleLineId: snapshot?.saleLineId ?? null,
          serialCustomerPartyId: snapshot?.customerPartyId ?? null,
          serialSoldDate: snapshot?.soldDate ?? null,
          serialCustomerWarrantyMonths: snapshot?.customerWarrantyMonths ?? null,
          createdAt: now,
          createdBy: ctx.userId,
        });
      }

      if (line.serialUnitIds.length > 0) {
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
              inArray(inventoryUnits.id, [...line.serialUnitIds]),
              eq(inventoryUnits.saleId, draft.saleId),
              eq(inventoryUnits.status, 'SOLD'),
            ),
          )
          .returning({ id: inventoryUnits.id });
        if (restored.length !== line.serialUnitIds.length) {
          throw new Error('One or more sale serials are no longer available for this return');
        }
      }
    }

    for (const state of draft.costStates) {
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
          .where(and(eq(productCostState.tenantId, ctx.tenantId), eq(productCostState.id, state.id)));
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

    await db.insert(journalEntries).values({
      id: draft.journalEntryId,
      tenantId: ctx.tenantId,
      createdAt: now,
      createdBy: ctx.userId,
      businessDate: draft.businessDate,
      sourceDocumentType: 'SALES_RETURN',
      sourceDocumentId: draft.id,
      sourceNumber: draft.number,
      entryMode: draft.entryMode,
    });

    for (const line of draft.journalLines) {
      await db.insert(journalLines).values({
        id: line.id,
        tenantId: ctx.tenantId,
        createdAt: now,
        createdBy: ctx.userId,
        journalEntryId: draft.journalEntryId,
        accountCode: line.account,
        amountMinor: line.amountMinor,
        partyId: line.partyId,
      });
    }
  }

  async findReturnById(
    tx: Tx,
    ctx: TenantContext,
    returnId: string,
  ): Promise<SalesReturnRow | null> {
    const page = await this.readReturns(tx, ctx, [eq(salesReturns.id, returnId)], 1);
    return page[0] ?? null;
  }

  async findReturnIdByOperationId(
    tx: Tx,
    ctx: TenantContext,
    operationId: string,
  ): Promise<string | null> {
    const rows = await txOf(tx)
      .select({ id: salesReturns.id })
      .from(salesReturns)
      .where(and(eq(salesReturns.tenantId, ctx.tenantId), eq(salesReturns.operationId, operationId)))
      .limit(1);
    return rows[0]?.id.trim() ?? null;
  }

  async listReturns(
    tx: Tx,
    ctx: TenantContext,
    filter: SalesReturnFilter,
  ): Promise<{
    readonly returns: readonly SalesReturnRow[];
    readonly nextCursor: string | null;
    readonly totalValueMinor: number;
    readonly totalRefundMinor: number;
  }> {
    const conditions: SQL[] = [];
    if (filter.partyId !== null) conditions.push(eq(salesReturns.partyId, filter.partyId));
    if (filter.fromDate !== null) {
      conditions.push(sql`${salesReturns.businessDate} >= ${filter.fromDate}`);
    }
    if (filter.toDate !== null) {
      conditions.push(sql`${salesReturns.businessDate} <= ${filter.toDate}`);
    }
    if (filter.search !== null && filter.search.trim() !== '') {
      const term = `%${filter.search.trim().toLowerCase()}%`;
      conditions.push(
        sql`(LOWER(${salesReturns.returnNumber}) LIKE ${term}
          OR LOWER(${salesReturns.customerNameSnapshot}) LIKE ${term})`,
      );
    }
    if (filter.cursor !== null) conditions.push(lt(salesReturns.id, filter.cursor));

    const totals = await txOf(tx)
      .select({
        value: sql<number>`COALESCE(SUM(${salesReturns.returnValueMinor}), 0)::bigint`,
        refund: sql<number>`COALESCE(SUM(${salesReturns.refundMinor}), 0)::bigint`,
      })
      .from(salesReturns)
      .where(
        and(
          eq(salesReturns.tenantId, ctx.tenantId),
          eq(salesReturns.status, 'POSTED'),
          isNull(salesReturns.deletedAt),
          ...conditions.filter((condition) => condition !== undefined),
        ),
      );

    const rows = await this.readReturns(tx, ctx, conditions, filter.limit + 1);
    const hasMore = rows.length > filter.limit;
    const page = hasMore ? rows.slice(0, filter.limit) : rows;

    return {
      returns: page,
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
      totalValueMinor: Number(totals[0]?.value ?? 0),
      totalRefundMinor: Number(totals[0]?.refund ?? 0),
    };
  }

  /** One reader for the detail and the list, so both say the same thing. */
  private async readReturns(
    tx: Tx,
    ctx: TenantContext,
    conditions: readonly SQL[],
    limit: number,
  ): Promise<readonly SalesReturnRow[]> {
    const db = txOf(tx);
    const approver = users;

    const heads = await db
      .select({
        id: salesReturns.id,
        number: salesReturns.returnNumber,
        saleId: salesReturns.saleId,
        saleNumber: sales.saleNumber,
        partyId: salesReturns.partyId,
        customerName: salesReturns.customerNameSnapshot,
        businessDate: salesReturns.businessDate,
        reason: salesReturns.reason,
        note: salesReturns.note,
        returnValueMinor: salesReturns.returnValueMinor,
        refundMinor: salesReturns.refundMinor,
        creditMinor: salesReturns.creditMinor,
        refundAccountCode: salesReturns.refundAccountCode,
        refundAccountName: accounts.name,
        approvedByName: approver.displayName,
        createdAt: salesReturns.createdAt,
      })
      .from(salesReturns)
      .innerJoin(sales, eq(sales.id, salesReturns.saleId))
      .leftJoin(approver, eq(approver.id, salesReturns.approvedBy))
      .leftJoin(
        accounts,
        sql`${accounts.id} = SUBSTRING(${salesReturns.refundAccountCode} FROM POSITION(':' IN ${salesReturns.refundAccountCode}) + 1)`,
      )
      .where(
        and(
          eq(salesReturns.tenantId, ctx.tenantId),
          isNull(salesReturns.deletedAt),
          ...conditions,
        ),
      )
      .orderBy(desc(salesReturns.businessDate), desc(salesReturns.id))
      .limit(limit);

    if (heads.length === 0) return [];

    const ids = heads.map((head) => head.id.trim());
    const lines = await db
      .select({
        id: salesReturnLines.id,
        returnId: salesReturnLines.returnId,
        saleLineId: salesReturnLines.saleLineId,
        productId: salesReturnLines.productId,
        productName: products.name,
        unitName: units.name,
        qty: salesReturnLines.qty,
        valueMinor: salesReturnLines.valueMinor,
      })
      .from(salesReturnLines)
      .innerJoin(products, eq(products.id, salesReturnLines.productId))
      .innerJoin(units, eq(units.id, products.baseUnitId))
      .where(
        and(
          eq(salesReturnLines.tenantId, ctx.tenantId),
          inArray(salesReturnLines.returnId, ids),
        ),
      )
      .orderBy(asc(salesReturnLines.lineNo));

    return heads.map((head) => ({
      id: head.id.trim(),
      number: head.number,
      saleId: head.saleId.trim(),
      saleNumber: head.saleNumber,
      partyId: head.partyId.trim(),
      customerName: head.customerName,
      businessDate: head.businessDate,
      reason: head.reason,
      note: head.note,
      returnValueMinor: Number(head.returnValueMinor),
      refundMinor: Number(head.refundMinor),
      creditMinor: Number(head.creditMinor),
      refundAccountCode: head.refundAccountCode,
      refundAccountName: head.refundAccountName,
      approvedByName: head.approvedByName,
      createdAt: head.createdAt,
      lines: lines
        .filter((line) => line.returnId.trim() === head.id.trim())
        .map((line) => ({
          id: line.id.trim(),
          saleLineId: line.saleLineId.trim(),
          productId: line.productId.trim(),
          productName: line.productName,
          unitName: line.unitName,
          qty: Number(line.qty),
          valueMinor: Number(line.valueMinor),
        })),
    }));
  }
}
