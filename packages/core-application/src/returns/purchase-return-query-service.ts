import { AppError, ErrorCode, Permission } from '@sher/core-contracts';
import type { PurchaseReturnListResponse, ReturnableBillResponse } from '@sher/core-contracts';

import type { AccessControl } from '../ports/access-control';
import type { TenantContext } from '../ports/tenant-context';
import type { UnitOfWork } from '../ports/unit-of-work';
import type { PurchaseReturnFilter, PurchaseReturnRepository } from './purchase-return-repository';
import { toPurchaseReturnResponse } from './purchase-return-view';

/**
 * Reading supplier returns: what a bill will still take back, and what has gone
 * back (Phase 7, §5.11).
 *
 * The modal asks `returnable` once and computes the rest in the browser through
 * the same domain function the posting service uses.
 */
export class PurchaseReturnQueryService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly access: AccessControl,
    private readonly returns: PurchaseReturnRepository,
  ) {}

  async returnable(ctx: TenantContext, purchaseId: string): Promise<ReturnableBillResponse> {
    return this.uow.run(ctx, async (tx) => {
      await this.access.require(tx, ctx, Permission.PURCHASE_RETURN_CREATE);

      const bill = await this.returns.findReturnableBill(tx, ctx, purchaseId);
      if (bill === null) throw new AppError(ErrorCode.NOT_FOUND, 'Purchase not found');

      return {
        purchaseId: bill.purchaseId,
        number: bill.number,
        businessDate: bill.businessDate,
        supplierName: bill.supplierName,
        supplierPartyId: bill.supplierPartyId,
        grandTotalMinor: bill.grandTotalMinor,
        outstandingMinor: bill.outstandingMinor,
        lines: bill.lines.map((line) => ({
          purchaseLineId: line.purchaseLineId,
          productId: line.productId,
          productName: line.productName,
          unitName: line.unitName,
          lotId: line.lotId,
          qtyReceived: line.qtyReceived,
          qtyReturned: line.qtyReturned,
          qtyReturnable: Math.max(line.qtyReceived - line.qtyReturned, 0),
          // What is actually on the shelf. The modal caps the box at the
          // smaller of the two, so nobody types a number the server will refuse.
          qtyRemainingInLot: line.qtyRemainingInLot,
          billedNetMinor: line.billedNetMinor,
          actualUnitCost: line.actualUnitCost,
        })),
      };
    });
  }

  async list(ctx: TenantContext, filter: PurchaseReturnFilter): Promise<PurchaseReturnListResponse> {
    return this.uow.run(ctx, async (tx) => {
      await this.access.require(tx, ctx, Permission.PURCHASE_RETURN_VIEW);
      const page = await this.returns.listReturns(tx, ctx, filter);
      return {
        returns: page.returns.map(toPurchaseReturnResponse),
        nextCursor: page.nextCursor,
        totalValueMinor: page.totalValueMinor,
        totalReceivedMinor: page.totalReceivedMinor,
      };
    });
  }
}
