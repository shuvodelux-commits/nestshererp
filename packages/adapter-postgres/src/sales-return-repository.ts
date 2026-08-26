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
} from '@sher/core-application';
import { Ulid } from '@sher/shared-utils';
import type { Clock } from '@sher/shared-utils';
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';

import {
  accounts,
  inventoryLots,
  journalEntries,
  journalLines,
  lotConsumptions,
  parties,
  productCostState,
  products,
  roles,
  saleLines,
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
  - ${creditedMinor(sql`${sales.id}`)}
)::bigint`;

export class PostgresSalesReturnRepository implements SalesReturnRepository {
  constructor(private readonly clock: Clock) {}

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
        // `stock_movements.unit_cost` is taka at scale 4, as `actualUnitCost` is:
        // poisha per unit × 100, and the quantity is scale 3.
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
