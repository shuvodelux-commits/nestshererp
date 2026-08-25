import { AppError, ErrorCode, Permission } from '@sher/core-contracts';
import type { ReturnableInvoiceResponse, SalesReturnListResponse } from '@sher/core-contracts';
import type { Clock } from '@sher/shared-utils';

import type { AccessControl } from '../ports/access-control';
import type { TenantContext } from '../ports/tenant-context';
import type { UnitOfWork } from '../ports/unit-of-work';
import type { SalesReturnFilter, SalesReturnRepository } from './sales-return-repository';
import { toSalesReturnResponse } from './sales-return-view';

/**
 * Reading returns: what an invoice will still take back, and what has come back
 * (Phase 7, §5.11).
 *
 * The modal asks `returnable` once when it opens and computes everything else in
 * the browser from that answer — the caps, the values and the refund all come
 * from the same rows the posting service will re-read, so what the shopkeeper
 * watches and what the server writes cannot drift.
 */
export class SalesReturnQueryService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly access: AccessControl,
    private readonly returns: SalesReturnRepository,
    private readonly clock: Clock,
  ) {}

  async returnable(ctx: TenantContext, saleId: string): Promise<ReturnableInvoiceResponse> {
    return this.uow.run(ctx, async (tx) => {
      await this.access.require(tx, ctx, Permission.SALES_RETURN_CREATE);

      const invoice = await this.returns.findReturnableInvoice(tx, ctx, saleId);
      if (invoice === null) throw new AppError(ErrorCode.NOT_FOUND, 'Invoice not found');

      const today = this.clock.businessDate(ctx.timezone);
      const caps = await this.returns.refundCapsOf(tx, ctx, ctx.userId);
      const usedTodayMinor = await this.returns.cashRefundedToday(tx, ctx, ctx.userId, today);

      return {
        saleId: invoice.saleId,
        number: invoice.number,
        businessDate: invoice.businessDate,
        customerName: invoice.customerName,
        partyId: invoice.partyId,
        isWalkIn: invoice.isWalkIn,
        grandTotalMinor: invoice.grandTotalMinor,
        dueMinor: invoice.dueMinor,
        lines: invoice.lines.map((line) => ({
          saleLineId: line.saleLineId,
          productId: line.productId,
          productName: line.productName,
          unitName: line.unitName,
          qtySold: line.qtySold,
          qtyReturned: line.qtyReturned,
          qtyReturnable: Math.max(line.qtySold - line.qtyReturned, 0),
          unitPriceMinor: line.unitPriceMinor,
          netAmountMinor: line.netAmountMinor,
          // Consignment stock was never the shop's, so it cannot come back
          // (INV-04). The line is still shown, because an invoice that hides a
          // line the customer is holding is worse than one that explains it.
          returnable: line.source === 'OWN_STOCK',
        })),
        refundLimit: {
          perReturnMinor: caps.perReturnMinor,
          perDayMinor: caps.perDayMinor,
          usedTodayMinor,
        },
      };
    });
  }

  async list(ctx: TenantContext, filter: SalesReturnFilter): Promise<SalesReturnListResponse> {
    return this.uow.run(ctx, async (tx) => {
      await this.access.require(tx, ctx, Permission.SALES_RETURN_VIEW);
      const page = await this.returns.listReturns(tx, ctx, filter);
      return {
        returns: page.returns.map(toSalesReturnResponse),
        nextCursor: page.nextCursor,
        totalValueMinor: page.totalValueMinor,
        totalRefundMinor: page.totalRefundMinor,
      };
    });
  }
}
