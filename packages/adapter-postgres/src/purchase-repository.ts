import type {
  NewPurchase,
  NewSupplierPayment,
  OpenBillRow,
  PurchaseDetail,
  PurchaseFilter,
  PurchaseListRowData,
  PurchaseRepository,
  PurchaseSummary,
  SupplierPaymentDetail,
  TenantContext,
  Tx,
} from '@sher/core-application';
import type { Clock } from '@sher/shared-utils';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';

import {
  accounts,
  inventoryLots,
  journalEntries,
  journalLines,
  parties,
  paymentAllocations,
  productCostState,
  products,
  purchaseLines,
  purchases,
  stockMovements,
  supplierPayments,
  units,
} from './schema';
import { txOf } from './unit-of-work';

/**
 * Purchases and supplier payments over PostgreSQL. No business rule lives here
 * (R-B6) — the service decides what a bill costs and what it settles; this
 * writes the rows and reads them back.
 *
 * **What is still owed is always computed**, never stored: `grand_total −
 * paid_minor − Σ allocations`, in the same statement as the row it belongs to,
 * so the list, the tiles, a bill's own screen and the Pay Supplier dialog are
 * four readings of one expression rather than four numbers that can drift
 * (migration 0017).
 */
function allocatedMinor(purchaseId: SQL): SQL<number> {
  return sql<number>`COALESCE((
    SELECT SUM(pa.amount_minor)
      FROM payment_allocations pa
     WHERE pa.purchase_id = ${purchaseId}
  ), 0)::bigint`;
}

const DUE_MINOR = sql<number>`(${purchases.grandTotalMinor} - ${purchases.paidMinor} - ${allocatedMinor(sql`${purchases.id}`)})`;

export class PostgresPurchaseRepository implements PurchaseRepository {
  constructor(private readonly clock: Clock) {}

  async insertPurchase(tx: Tx, ctx: TenantContext, purchase: NewPurchase): Promise<void> {
    const db = txOf(tx);
    const now = this.clock.now();

    await db.insert(purchases).values({
      id: purchase.id,
      tenantId: ctx.tenantId,
      purchaseNumber: purchase.number,
      supplierPartyId: purchase.supplierPartyId,
      supplierBillRef: purchase.supplierBillRef,
      locationId: purchase.locationId,
      dueDate: purchase.dueDate,
      itemsTotalMinor: purchase.itemsTotalMinor,
      discountMinor: purchase.discountMinor,
      extraCostMinor: purchase.extraCostMinor,
      grandTotalMinor: purchase.grandTotalMinor,
      paidMinor: purchase.paidMinor,
      paidAccountCode: purchase.paidAccountCode,
      sessionId: purchase.sessionId,
      notes: purchase.notes,
      businessDate: purchase.businessDate,
      entryMode: purchase.entryMode,
      status: 'POSTED',
      operationId: purchase.operationId,
      createdAt: now,
      updatedAt: now,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
      version: 1,
    });

    for (const line of purchase.lines) {
      // One lot per line: §5.9's "different purchase prices create separate
      // lots" is this insert, not a merge of like-priced rows.
      await db.insert(inventoryLots).values({
        id: line.lotId,
        tenantId: ctx.tenantId,
        productId: line.productId,
        locationId: line.locationId,
        ownerType: 'OWNED',
        vendorPartyId: null,
        supplierPartyId: purchase.supplierPartyId,
        sourceDocumentType: 'PURCHASE',
        sourceDocumentId: purchase.id,
        sourceNumber: purchase.number,
        qtyReceived: line.qty,
        qtyRemaining: line.qty,
        purchaseUnitCost: line.actualUnitCost,
        landedCostTotal: line.extraCostShareMinor - line.discountShareMinor,
        actualUnitCost: line.actualUnitCost,
        businessDate: purchase.businessDate,
        expiryDate: line.expiryDate,
        status: 'OPEN',
        createdAt: now,
        updatedAt: now,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
        version: 1,
      });

      await db.insert(stockMovements).values({
        id: line.movementId,
        tenantId: ctx.tenantId,
        createdAt: now,
        createdBy: ctx.userId,
        productId: line.productId,
        locationId: line.locationId,
        lotId: line.lotId,
        qty: line.qty,
        direction: 'IN',
        businessDate: purchase.businessDate,
        sourceDocumentType: 'PURCHASE',
        sourceDocumentId: purchase.id,
        sourceNumber: purchase.number,
        unitCost: line.actualUnitCost,
      });

      if (line.costState.exists) {
        await db
          .update(productCostState)
          .set({
            avgUnitCost: line.costState.avgUnitCost,
            qtyOnHand: line.costState.qtyOnHand,
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

      await db.insert(purchaseLines).values({
        id: line.id,
        tenantId: ctx.tenantId,
        purchaseId: purchase.id,
        lineNo: line.lineNo,
        productId: line.productId,
        qty: line.qty,
        unitPriceMinor: line.unitPriceMinor,
        lineTotalMinor: line.lineTotalMinor,
        discountShareMinor: line.discountShareMinor,
        extraCostShareMinor: line.extraCostShareMinor,
        actualUnitCost: line.actualUnitCost,
        expiryDate: line.expiryDate,
        lotId: line.lotId,
        movementId: line.movementId,
        createdAt: now,
        createdBy: ctx.userId,
      });
    }

    await this.insertJournal(
      tx,
      ctx,
      purchase.journalEntryId,
      purchase.businessDate,
      purchase.entryMode,
      'PURCHASE',
      purchase.id,
      purchase.number,
      purchase.journalLines,
    );
  }

  async findPurchaseIdByOperationId(
    tx: Tx,
    ctx: TenantContext,
    operationId: string,
  ): Promise<string | null> {
    const rows = await txOf(tx)
      .select({ id: purchases.id })
      .from(purchases)
      .where(
        and(
          eq(purchases.tenantId, ctx.tenantId),
          eq(purchases.operationId, operationId),
          isNull(purchases.deletedAt),
        ),
      )
      .limit(1);
    return rows[0]?.id.trim() ?? null;
  }

  async findPurchaseById(tx: Tx, ctx: TenantContext, id: string): Promise<PurchaseDetail | null> {
    const db = txOf(tx);
    const rows = await db
      .select({
        id: purchases.id,
        number: purchases.purchaseNumber,
        supplierPartyId: purchases.supplierPartyId,
        supplierName: parties.name,
        supplierBillRef: purchases.supplierBillRef,
        businessDate: purchases.businessDate,
        dueDate: purchases.dueDate,
        status: purchases.status,
        notes: purchases.notes,
        itemsTotalMinor: purchases.itemsTotalMinor,
        discountMinor: purchases.discountMinor,
        extraCostMinor: purchases.extraCostMinor,
        grandTotalMinor: purchases.grandTotalMinor,
        billPaidMinor: purchases.paidMinor,
        allocatedMinor: allocatedMinor(sql`${purchases.id}`),
        paidAccountCode: purchases.paidAccountCode,
        createdAt: purchases.createdAt,
      })
      .from(purchases)
      .innerJoin(
        parties,
        and(eq(parties.tenantId, ctx.tenantId), eq(parties.id, purchases.supplierPartyId)),
      )
      .where(
        and(eq(purchases.tenantId, ctx.tenantId), eq(purchases.id, id), isNull(purchases.deletedAt)),
      )
      .limit(1);

    const row = rows[0];
    if (row === undefined) return null;

    const lineRows = await db
      .select({
        id: purchaseLines.id,
        productId: purchaseLines.productId,
        productName: products.name,
        unitName: units.name,
        qty: purchaseLines.qty,
        unitPriceMinor: purchaseLines.unitPriceMinor,
        lineTotalMinor: purchaseLines.lineTotalMinor,
        discountShareMinor: purchaseLines.discountShareMinor,
        extraCostShareMinor: purchaseLines.extraCostShareMinor,
        actualUnitCost: purchaseLines.actualUnitCost,
        expiryDate: purchaseLines.expiryDate,
        lotId: purchaseLines.lotId,
      })
      .from(purchaseLines)
      .innerJoin(
        products,
        and(eq(products.tenantId, ctx.tenantId), eq(products.id, purchaseLines.productId)),
      )
      .innerJoin(units, and(eq(units.tenantId, ctx.tenantId), eq(units.id, products.baseUnitId)))
      .where(and(eq(purchaseLines.tenantId, ctx.tenantId), eq(purchaseLines.purchaseId, row.id)))
      .orderBy(purchaseLines.lineNo);

    const paymentRows = await db
      .select({
        id: supplierPayments.id,
        number: supplierPayments.paymentNumber,
        businessDate: supplierPayments.businessDate,
        accountCode: supplierPayments.accountCode,
        amountMinor: paymentAllocations.amountMinor,
      })
      .from(paymentAllocations)
      .innerJoin(
        supplierPayments,
        and(
          eq(supplierPayments.tenantId, ctx.tenantId),
          eq(supplierPayments.id, paymentAllocations.paymentId),
        ),
      )
      .where(
        and(
          eq(paymentAllocations.tenantId, ctx.tenantId),
          eq(paymentAllocations.purchaseId, row.id),
        ),
      )
      .orderBy(supplierPayments.businessDate, supplierPayments.id);

    const names = await this.accountNames(
      tx,
      ctx,
      [row.paidAccountCode, ...paymentRows.map((payment) => payment.accountCode)].filter(
        (code): code is string => code !== null,
      ),
    );
    const paidMinor = Number(row.billPaidMinor) + Number(row.allocatedMinor);

    return {
      id: row.id.trim(),
      number: row.number,
      supplierPartyId: row.supplierPartyId.trim(),
      supplierName: row.supplierName,
      supplierBillRef: row.supplierBillRef,
      businessDate: row.businessDate,
      dueDate: row.dueDate,
      status: row.status as 'POSTED' | 'VOIDED',
      notes: row.notes,
      itemsTotalMinor: Number(row.itemsTotalMinor),
      discountMinor: Number(row.discountMinor),
      extraCostMinor: Number(row.extraCostMinor),
      grandTotalMinor: Number(row.grandTotalMinor),
      paidMinor,
      dueMinor: Number(row.grandTotalMinor) - paidMinor,
      paidAccountCode: row.paidAccountCode,
      paidAccountName:
        row.paidAccountCode === null ? null : (names.get(row.paidAccountCode) ?? row.paidAccountCode),
      createdAt: row.createdAt,
      lines: lineRows.map((line) => ({
        id: line.id.trim(),
        productId: line.productId.trim(),
        productName: line.productName,
        unitName: line.unitName,
        qty: Number(line.qty),
        unitPriceMinor: Number(line.unitPriceMinor),
        lineTotalMinor: Number(line.lineTotalMinor),
        discountShareMinor: Number(line.discountShareMinor),
        extraCostShareMinor: Number(line.extraCostShareMinor),
        actualUnitCost: Number(line.actualUnitCost),
        expiryDate: line.expiryDate,
        lotId: line.lotId.trim(),
      })),
      payments: paymentRows.map((payment) => ({
        id: payment.id.trim(),
        number: payment.number,
        businessDate: payment.businessDate,
        accountName: names.get(payment.accountCode) ?? payment.accountCode,
        amountMinor: Number(payment.amountMinor),
      })),
    };
  }

  async listPurchases(
    tx: Tx,
    ctx: TenantContext,
    filter: PurchaseFilter,
  ): Promise<readonly PurchaseListRowData[]> {
    const rows = await txOf(tx)
      .select({
        id: purchases.id,
        number: purchases.purchaseNumber,
        supplierPartyId: purchases.supplierPartyId,
        supplierName: parties.name,
        supplierBillRef: purchases.supplierBillRef,
        businessDate: purchases.businessDate,
        dueDate: purchases.dueDate,
        status: purchases.status,
        lineCount: sql<number>`(SELECT count(*) FROM purchase_lines pl WHERE pl.purchase_id = ${purchases.id})::int`,
        grandTotalMinor: purchases.grandTotalMinor,
        dueMinor: DUE_MINOR,
      })
      .from(purchases)
      .innerJoin(
        parties,
        and(eq(parties.tenantId, ctx.tenantId), eq(parties.id, purchases.supplierPartyId)),
      )
      .where(and(...this.conditions(ctx, filter)))
      // Newest first, id as the tiebreak — which is also the cursor (§3.9).
      .orderBy(sql`${purchases.businessDate} DESC`, sql`${purchases.id} DESC`)
      .limit(filter.limit);

    return rows.map((row) => ({
      id: row.id.trim(),
      number: row.number,
      supplierPartyId: row.supplierPartyId.trim(),
      supplierName: row.supplierName,
      supplierBillRef: row.supplierBillRef,
      businessDate: row.businessDate,
      dueDate: row.dueDate,
      status: row.status as 'POSTED' | 'VOIDED',
      lineCount: Number(row.lineCount),
      grandTotalMinor: Number(row.grandTotalMinor),
      paidMinor: Number(row.grandTotalMinor) - Number(row.dueMinor),
      dueMinor: Number(row.dueMinor),
    }));
  }

  async summarise(
    tx: Tx,
    ctx: TenantContext,
    filter: PurchaseFilter,
    today: string,
  ): Promise<PurchaseSummary> {
    const rows = await txOf(tx)
      .select({
        purchaseCount: sql<number>`count(*)::int`,
        periodTotalMinor: sql<number>`COALESCE(SUM(${purchases.grandTotalMinor}), 0)::bigint`,
        unpaidTotalMinor: sql<number>`COALESCE(SUM(GREATEST(${DUE_MINOR}, 0)), 0)::bigint`,
        overdueTotalMinor: sql<number>`COALESCE(SUM(
          CASE WHEN ${purchases.dueDate} IS NOT NULL AND ${purchases.dueDate} < ${today}
               THEN GREATEST(${DUE_MINOR}, 0) ELSE 0 END
        ), 0)::bigint`,
      })
      .from(purchases)
      // Joined for the same reason the list is: the search filter reads the
      // supplier's name, and a tile computed without the join would fail the
      // moment somebody typed one.
      .innerJoin(
        parties,
        and(eq(parties.tenantId, ctx.tenantId), eq(parties.id, purchases.supplierPartyId)),
      )
      // The tiles count exactly the rows the table shows, minus paging.
      .where(and(...this.conditions(ctx, filter, false)));

    const row = rows[0];
    return {
      purchaseCount: Number(row?.purchaseCount ?? 0),
      periodTotalMinor: Number(row?.periodTotalMinor ?? 0),
      unpaidTotalMinor: Number(row?.unpaidTotalMinor ?? 0),
      overdueTotalMinor: Number(row?.overdueTotalMinor ?? 0),
    };
  }

  async listOpenBills(
    tx: Tx,
    ctx: TenantContext,
    supplierPartyId: string,
    purchaseId: string | null,
  ): Promise<readonly OpenBillRow[]> {
    const rows = await txOf(tx)
      .select({
        purchaseId: purchases.id,
        number: purchases.purchaseNumber,
        businessDate: purchases.businessDate,
        dueDate: purchases.dueDate,
        grandTotalMinor: purchases.grandTotalMinor,
        outstandingMinor: DUE_MINOR,
      })
      .from(purchases)
      .where(
        and(
          eq(purchases.tenantId, ctx.tenantId),
          eq(purchases.supplierPartyId, supplierPartyId),
          eq(purchases.status, 'POSTED'),
          isNull(purchases.deletedAt),
          sql`${DUE_MINOR} > 0`,
          ...(purchaseId === null ? [] : [eq(purchases.id, purchaseId)]),
        ),
      )
      // Oldest first: the supplier chasing a shopkeeper is chasing the oldest
      // bill, so that is the one a payment settles first.
      .orderBy(purchases.businessDate, purchases.id);

    return rows.map((row) => ({
      purchaseId: row.purchaseId.trim(),
      number: row.number,
      businessDate: row.businessDate,
      dueDate: row.dueDate,
      grandTotalMinor: Number(row.grandTotalMinor),
      outstandingMinor: Number(row.outstandingMinor),
    }));
  }

  async insertPayment(tx: Tx, ctx: TenantContext, payment: NewSupplierPayment): Promise<void> {
    const db = txOf(tx);
    const now = this.clock.now();

    await db.insert(supplierPayments).values({
      id: payment.id,
      tenantId: ctx.tenantId,
      paymentNumber: payment.number,
      supplierPartyId: payment.supplierPartyId,
      accountCode: payment.accountCode,
      amountMinor: payment.amountMinor,
      note: payment.note,
      sessionId: payment.sessionId,
      businessDate: payment.businessDate,
      entryMode: payment.entryMode,
      status: 'POSTED',
      operationId: payment.operationId,
      createdAt: now,
      updatedAt: now,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
      version: 1,
    });

    if (payment.allocations.length > 0) {
      await db.insert(paymentAllocations).values(
        payment.allocations.map((allocation) => ({
          id: allocation.id,
          tenantId: ctx.tenantId,
          paymentId: payment.id,
          purchaseId: allocation.purchaseId,
          amountMinor: allocation.amountMinor,
          createdAt: now,
          createdBy: ctx.userId,
        })),
      );
    }

    await this.insertJournal(
      tx,
      ctx,
      payment.journalEntryId,
      payment.businessDate,
      payment.entryMode,
      'SUPPLIER_PAYMENT',
      payment.id,
      payment.number,
      payment.journalLines,
    );
  }

  async findPaymentIdByOperationId(
    tx: Tx,
    ctx: TenantContext,
    operationId: string,
  ): Promise<string | null> {
    const rows = await txOf(tx)
      .select({ id: supplierPayments.id })
      .from(supplierPayments)
      .where(
        and(
          eq(supplierPayments.tenantId, ctx.tenantId),
          eq(supplierPayments.operationId, operationId),
          isNull(supplierPayments.deletedAt),
        ),
      )
      .limit(1);
    return rows[0]?.id.trim() ?? null;
  }

  async findPaymentById(
    tx: Tx,
    ctx: TenantContext,
    id: string,
  ): Promise<SupplierPaymentDetail | null> {
    const db = txOf(tx);
    const rows = await db
      .select({
        id: supplierPayments.id,
        number: supplierPayments.paymentNumber,
        supplierPartyId: supplierPayments.supplierPartyId,
        supplierName: parties.name,
        accountCode: supplierPayments.accountCode,
        amountMinor: supplierPayments.amountMinor,
        note: supplierPayments.note,
        businessDate: supplierPayments.businessDate,
        createdAt: supplierPayments.createdAt,
      })
      .from(supplierPayments)
      .innerJoin(
        parties,
        and(eq(parties.tenantId, ctx.tenantId), eq(parties.id, supplierPayments.supplierPartyId)),
      )
      .where(
        and(
          eq(supplierPayments.tenantId, ctx.tenantId),
          eq(supplierPayments.id, id),
          isNull(supplierPayments.deletedAt),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (row === undefined) return null;

    const allocations = await db
      .select({
        purchaseId: paymentAllocations.purchaseId,
        purchaseNumber: purchases.purchaseNumber,
        amountMinor: paymentAllocations.amountMinor,
      })
      .from(paymentAllocations)
      .innerJoin(
        purchases,
        and(eq(purchases.tenantId, ctx.tenantId), eq(purchases.id, paymentAllocations.purchaseId)),
      )
      .where(
        and(
          eq(paymentAllocations.tenantId, ctx.tenantId),
          eq(paymentAllocations.paymentId, row.id),
        ),
      )
      .orderBy(purchases.businessDate, purchases.id);

    return {
      id: row.id.trim(),
      number: row.number,
      supplierPartyId: row.supplierPartyId.trim(),
      supplierName: row.supplierName,
      accountCode: row.accountCode,
      amountMinor: Number(row.amountMinor),
      note: row.note,
      businessDate: row.businessDate,
      createdAt: row.createdAt,
      allocations: allocations.map((allocation) => ({
        purchaseId: allocation.purchaseId.trim(),
        purchaseNumber: allocation.purchaseNumber,
        amountMinor: Number(allocation.amountMinor),
      })),
    };
  }

  /** The filters the list and its tiles share. Paging is the only difference. */
  private conditions(ctx: TenantContext, filter: PurchaseFilter, paged = true): SQL[] {
    const settlement =
      filter.settlement === 'UNPAID'
        ? [sql`${DUE_MINOR} > 0`]
        : filter.settlement === 'PAID'
          ? [sql`${DUE_MINOR} <= 0`]
          : [];

    return [
      eq(purchases.tenantId, ctx.tenantId),
      isNull(purchases.deletedAt),
      ...(filter.supplierPartyId === null
        ? []
        : [eq(purchases.supplierPartyId, filter.supplierPartyId)]),
      ...(filter.fromDate === null ? [] : [sql`${purchases.businessDate} >= ${filter.fromDate}`]),
      ...(filter.toDate === null ? [] : [sql`${purchases.businessDate} <= ${filter.toDate}`]),
      ...settlement,
      ...(filter.search === null || filter.search === ''
        ? []
        : [
            sql`(${purchases.purchaseNumber} ILIKE ${`%${filter.search}%`}
               OR COALESCE(${purchases.supplierBillRef}, '') ILIKE ${`%${filter.search}%`}
               OR ${parties.name} ILIKE ${`%${filter.search}%`})`,
          ]),
      // Keyset paging on the same (business_date DESC, id DESC) the list orders
      // by: everything strictly after the cursor row.
      ...(!paged || filter.cursor === null
        ? []
        : [
            sql`(${purchases.businessDate}, ${purchases.id}) < (
              SELECT anchor.business_date, anchor.id FROM purchases anchor
               WHERE anchor.tenant_id = ${ctx.tenantId} AND anchor.id = ${filter.cursor}
            )`,
          ]),
    ];
  }

  private async accountNames(
    tx: Tx,
    ctx: TenantContext,
    codes: readonly string[],
  ): Promise<Map<string, string>> {
    const ids = [...new Set(codes)]
      .map((code) => ({ code, id: code.slice(code.indexOf(':') + 1) }))
      .filter((entry) => entry.id !== '' && entry.id !== entry.code);
    if (ids.length === 0) return new Map();

    const rows = await txOf(tx)
      .select({ id: accounts.id, name: accounts.name })
      .from(accounts)
      .where(
        and(
          eq(accounts.tenantId, ctx.tenantId),
          sql`${accounts.id} IN (${sql.join(
            ids.map((entry) => sql`${entry.id}`),
            sql`, `,
          )})`,
        ),
      );

    const byId = new Map(rows.map((row) => [row.id.trim(), row.name]));
    return new Map(
      ids.flatMap((entry) => {
        const name = byId.get(entry.id);
        return name === undefined ? [] : [[entry.code, name] as const];
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
