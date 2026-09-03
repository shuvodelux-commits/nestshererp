import {
  adjustStockRequestSchema,
  AppError,
  createPurchaseRequestSchema,
  createPurchaseReturnRequestSchema,
  createSaleRequestSchema,
  createSalesReturnRequestSchema,
  ErrorCode,
  paySupplierRequestSchema,
  receiveCustomerPaymentRequestSchema,
  recordCashMovementRequestSchema,
  recordExpenseRequestSchema,
  savePartyRequestSchema,
  saveProductRequestSchema,
  startDayRequestSchema,
  syncCloseDayPayloadSchema,
} from '@sher/core-contracts';
import type { SyncOpType } from '@sher/core-contracts';

import type { ManageProductsService } from '../catalog/manage-products-service';
import type { ManageExpensesService } from '../expenses/manage-expenses-service';
import type { ManageInventoryService } from '../inventory/manage-inventory-service';
import type { CashMovementService } from '../money/cash-movement-service';
import type { CashSessionService } from '../money/cash-session-service';
import type { ManagePartiesService } from '../parties/manage-parties-service';
import type { CreatePurchaseService } from '../purchasing/create-purchase-service';
import type { PaySupplierService } from '../purchasing/pay-supplier-service';
import type { TenantContext } from '../ports/tenant-context';
import type { CreatePurchaseReturnService } from '../returns/create-purchase-return-service';
import type { CreateSalesReturnService } from '../returns/create-sales-return-service';
import type { CreateSaleService } from '../sales/create-sale-service';
import type { ReceiveCustomerPaymentService } from '../sales/receive-payment-service';

/**
 * How a queued command becomes a posted document (§6, §27 of the owner's
 * specification for Phase 12.4).
 *
 * **This file is the whole reason there is one posting implementation and not
 * two.** Every entry does exactly what the matching online controller does:
 * parse the body with the endpoint's own schema, then call the endpoint's own
 * application service with the operation id the device generated. Nothing here
 * writes a row, opens a transaction, computes a total or decides a rule. If a
 * sale posted through this path could differ from a sale posted at the counter,
 * it would be because the service differs from itself.
 *
 * Three consequences, all of them load-bearing:
 *
 * 1. **Idempotency is inherited.** Ten of these services already look their
 *    `operationId` up before doing anything and return the document they wrote
 *    the first time (R-C10). Replaying an accepted operation therefore performs
 *    zero further stock, money or journal effects — not because sync is careful,
 *    but because the online API had to be.
 * 2. **Every rule is re-checked at replay time.** Permission, period, entity
 *    validity, settings and every business rule are checked by the service, on
 *    the server's live state, at the moment of replay. A permission taken away
 *    during the outage refuses the operation exactly as it would refuse the
 *    same person online (SY-06, SY-07).
 * 3. **No operation is ever partly posted.** Each service opens one transaction
 *    and does its whole document in it, so a refusal rolls the document back
 *    entirely. Replay deliberately does **not** wrap that in a transaction of
 *    its own — a second, outer transaction would be a second connection, and
 *    the one thing worse than a refused document is half of one.
 */

/**
 * Just enough of a zod schema to parse with.
 *
 * Written structurally rather than importing zod, because `core-application`
 * does not depend on it and must not start: the validation library belongs to
 * the contracts package and to the edges that speak HTTP (R-B3).
 */
interface Parser<T> {
  safeParse(
    value: unknown,
  ):
    | { success: true; data: T }
    | { success: false; error: { issues: readonly { path: readonly (string | number)[]; message: string }[] } };
}

/** Everything replay is allowed to call. Nothing else is reachable from sync. */
export interface SyncServices {
  readonly sales: CreateSaleService;
  readonly receipts: ReceiveCustomerPaymentService;
  readonly purchases: CreatePurchaseService;
  readonly supplierPayments: PaySupplierService;
  readonly salesReturns: CreateSalesReturnService;
  readonly purchaseReturns: CreatePurchaseReturnService;
  readonly expenses: ManageExpensesService;
  readonly cashMovements: CashMovementService;
  readonly cashSessions: CashSessionService;
  readonly inventory: ManageInventoryService;
  readonly parties: ManagePartiesService;
  readonly products: ManageProductsService;
}

/** What a replayed operation produced, in the two terms sync records. */
export interface ReplayResult {
  readonly documentId: string;
  readonly documentNumber: string | null;
  /**
   * The customer-facing money the server arrived at, for the comparison §5
   * requires. Absent for the operations that show a customer nothing.
   */
  readonly digest: Record<string, number> | null;
}

/**
 * Runs one command through the service that owns it.
 *
 * `payload` arrives as `unknown` and is parsed here by the operation's own
 * schema, so a body the server cannot understand is one refused operation with
 * a reason a person can read — never a whole batch rejected at the door, and
 * never a partly-understood command handed to a service.
 */
export async function replayOperation(
  services: SyncServices,
  ctx: TenantContext,
  type: SyncOpType,
  operationId: string,
  rawPayload: unknown,
  options: { readonly documentNumber?: string | null } = {},
): Promise<ReplayResult> {
  /**
   * Parsing happens **inside** each branch, with the endpoint's own schema
   * named directly. A single parse up front would leave every branch holding a
   * union it had to cast its way out of, and a cast is exactly how a command
   * reaches a service in a shape the service never agreed to.
   */
  const read = <T>(schema: Parser<T>): T => {
    const parsed = schema.safeParse(rawPayload);
    if (!parsed.success) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        `This ${label(type)} is not in a shape the shop’s books accept: ${describe(parsed.error.issues)}`,
      );
    }
    return parsed.data;
  };

  switch (type) {
    case 'SALE_CREATE': {
      const body = read(createSaleRequestSchema);
      const sale = await services.sales.create({
        ...body,
        ctx,
        operationId,
        /*
         * The number is the one the machine printed and the customer walked out
         * with (§8). Passing it through is the only way "synchronization never
         * renumbers a sale" can be true; the service reserves it against that
         * device's own counter so the server can never hand it out again.
         */
        ...(options.documentNumber === undefined || options.documentNumber === null
          ? {}
          : { saleNumber: options.documentNumber }),
      });
      return {
        documentId: sale.id,
        documentNumber: sale.number,
        digest: {
          itemsTotalMinor: sale.itemsTotalMinor,
          discountMinor: sale.discountMinor,
          grandTotalMinor: sale.grandTotalMinor,
          paidMinor: sale.paidMinor,
        },
      };
    }

    case 'CUSTOMER_RECEIPT_RECORD': {
      const body = read(receiveCustomerPaymentRequestSchema);
      const receipt = await services.receipts.receive({ ...body, ctx, operationId });
      return {
        documentId: receipt.id,
        documentNumber: receipt.number,
        digest: { paidMinor: receipt.amountMinor },
      };
    }

    case 'PURCHASE_CREATE': {
      const body = read(createPurchaseRequestSchema);
      const purchase = await services.purchases.create({ ...body, ctx, operationId });
      return {
        documentId: purchase.id,
        documentNumber: purchase.number,
        digest: { grandTotalMinor: purchase.grandTotalMinor ?? 0 },
      };
    }

    case 'SUPPLIER_PAYMENT_RECORD': {
      const body = read(paySupplierRequestSchema);
      const payment = await services.supplierPayments.pay({ ...body, ctx, operationId });
      return {
        documentId: payment.id,
        documentNumber: payment.number,
        digest: { paidMinor: payment.amountMinor },
      };
    }

    case 'SALES_RETURN_CREATE': {
      const body = read(createSalesReturnRequestSchema);
      const ret = await services.salesReturns.create({
        ctx,
        operationId,
        saleId: body.saleId,
        // The line the goods came back on is named by the sale's own line id,
        // exactly as the counter names it (`sourceLineId` on the wire).
        lines: body.lines.map((line) => ({
          saleLineId: line.sourceLineId,
          qty: line.qty,
          serialUnitIds: line.serialUnitIds,
        })),
        reason: body.reason,
        note: body.note,
        refundMinor: body.refundMinor,
        refundAccountCode: body.refundAccountCode,
        approvalPin: body.approvalPin,
        customerName: body.customerName,
        customerPhone: body.customerPhone,
        customerAddress: body.customerAddress,
        customerGuardianName: body.customerGuardianName,
        ...(body.businessDate === undefined ? {} : { businessDate: body.businessDate }),
        backdateReason: body.backdateReason,
      });
      return {
        documentId: ret.id,
        documentNumber: ret.number,
        digest: { grandTotalMinor: ret.returnValueMinor, paidMinor: ret.refundMinor },
      };
    }

    case 'PURCHASE_RETURN_CREATE': {
      const body = read(createPurchaseReturnRequestSchema);
      const ret = await services.purchaseReturns.create({
        ctx,
        operationId,
        purchaseId: body.purchaseId,
        lines: body.lines.map((line) => ({ purchaseLineId: line.sourceLineId, qty: line.qty })),
        reason: body.reason,
        note: body.note,
        receivedMinor: body.receivedMinor,
        receiptAccountCode: body.receiptAccountCode,
        ...(body.businessDate === undefined ? {} : { businessDate: body.businessDate }),
        backdateReason: body.backdateReason,
      });
      return {
        documentId: ret.id,
        documentNumber: ret.number,
        digest: { grandTotalMinor: ret.returnValueMinor },
      };
    }

    case 'EXPENSE_RECORD': {
      const body = read(recordExpenseRequestSchema);
      const expense = await services.expenses.record({
        ctx,
        operationId,
        categoryId: body.categoryId,
        amountMinor: body.amountMinor,
        accountCode: body.accountCode,
        payeePartyId: body.payeePartyId,
        note: body.note,
        ...(body.businessDate === undefined ? {} : { businessDate: body.businessDate }),
        backdateReason: body.backdateReason,
      });
      return {
        documentId: expense.id,
        documentNumber: expense.number,
        digest: { grandTotalMinor: expense.amountMinor },
      };
    }

    case 'CASH_MOVEMENT_RECORD': {
      const body = read(recordCashMovementRequestSchema);
      const movement = await services.cashMovements.record({ ...body, ctx, operationId });
      return { documentId: movement.id, documentNumber: null, digest: null };
    }

    case 'STOCK_ADJUST': {
      const body = read(adjustStockRequestSchema);
      const adjustment = await services.inventory.adjustStock({
        ...body,
        ctx,
        operationId,
        // The trail says where the change came from, and a document that
        // arrived through sync did not come from a screen (§5.22).
        source: 'SYNC',
      });
      return { documentId: adjustment.id, documentNumber: null, digest: null };
    }

    case 'CASH_DAY_OPEN': {
      const body = read(startDayRequestSchema);
      const session = await services.cashSessions.startDay({ ...body, ctx, operationId });
      return { documentId: session.id, documentNumber: null, digest: null };
    }

    case 'CASH_DAY_CLOSE': {
      const body = read(syncCloseDayPayloadSchema);
      const session = await services.cashSessions.closeDay({
        ctx,
        operationId,
        sessionId: body.sessionId,
        countedClosingMinor: body.countedClosingMinor,
        reason: body.reason,
      });
      /*
       * The cashier's own count is the figure that must survive. The server
       * works out what the drawer should have held from its own postings, and
       * where the two differ the difference is surfaced rather than the count
       * being overwritten (§12).
       */
      return {
        documentId: session.id,
        documentNumber: null,
        digest: { paidMinor: body.countedClosingMinor },
      };
    }

    case 'PARTY_CREATE': {
      const party = await services.parties.create({
        ctx,
        operationId,
        input: read(savePartyRequestSchema),
      });
      return { documentId: party.id, documentNumber: null, digest: null };
    }

    case 'PRODUCT_CREATE': {
      const product = await services.products.create({
        ctx,
        operationId,
        input: read(saveProductRequestSchema),
      });
      return { documentId: product.id, documentNumber: null, digest: null };
    }
  }
}

/** The words a shopkeeper would use for each kind of queued work. */
export function label(type: SyncOpType): string {
  switch (type) {
    case 'SALE_CREATE':
      return 'sale';
    case 'CUSTOMER_RECEIPT_RECORD':
      return 'customer payment';
    case 'PURCHASE_CREATE':
      return 'purchase';
    case 'SUPPLIER_PAYMENT_RECORD':
      return 'supplier payment';
    case 'SALES_RETURN_CREATE':
      return 'customer return';
    case 'PURCHASE_RETURN_CREATE':
      return 'supplier return';
    case 'EXPENSE_RECORD':
      return 'expense';
    case 'CASH_MOVEMENT_RECORD':
      return 'money movement';
    case 'STOCK_ADJUST':
      return 'stock adjustment';
    case 'CASH_DAY_OPEN':
      return 'day opening';
    case 'CASH_DAY_CLOSE':
      return 'day closing';
    case 'PARTY_CREATE':
      return 'new customer or supplier';
    case 'PRODUCT_CREATE':
      return 'new product';
  }
}

function describe(issues: readonly { path: readonly (string | number)[]; message: string }[]): string {
  const first = issues[0];
  if (first === undefined) return 'the body could not be read';
  const where = first.path.join('.');
  return where === '' ? first.message : `${where} — ${first.message}`;
}
