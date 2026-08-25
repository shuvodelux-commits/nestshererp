import { AppError, ErrorCode, Permission } from '@sher/core-contracts';
import type { PurchaseListResponse, PurchaseResponse } from '@sher/core-contracts';
import type { Clock } from '@sher/shared-utils';

import type { AccessControl } from '../ports/access-control';
import type { TenantContext } from '../ports/tenant-context';
import type { UnitOfWork } from '../ports/unit-of-work';
import type { PurchaseFilter, PurchaseRepository } from './purchase-repository';
import { toPurchaseResponse } from './purchase-view';

/**
 * Reading purchases (§5.9). **READ ONLY** — nothing here posts.
 *
 * The tiles and the rows come from the same filter, so "unpaid total" is always
 * the total of the rows the shopkeeper is looking at rather than a second
 * number computed a second way. What is still owed on a bill is derived in SQL
 * from its own paid figure and its allocations; there is no stored outstanding
 * column to fall out of step (migration 0017).
 */

export interface PurchaseListCommand {
  readonly ctx: TenantContext;
  readonly search?: string | undefined;
  readonly supplierPartyId?: string | undefined;
  readonly fromDate?: string | undefined;
  readonly toDate?: string | undefined;
  readonly settlement?: 'ALL' | 'UNPAID' | 'PAID' | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export interface PurchaseDetailCommand {
  readonly ctx: TenantContext;
  readonly purchaseId: string;
}

const DEFAULT_LIMIT = 25;

export class PurchaseQueryService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly access: AccessControl,
    private readonly purchases: PurchaseRepository,
    private readonly clock: Clock,
  ) {}

  async list(command: PurchaseListCommand): Promise<PurchaseListResponse> {
    return this.uow.run(command.ctx, async (tx) => {
      const { ctx } = command;
      await this.access.require(tx, ctx, Permission.PURCHASE_VIEW);
      const showCost = (await this.access.permissionsOf(tx, ctx)).includes(Permission.COST_VIEW);

      const limit = command.limit ?? DEFAULT_LIMIT;
      const filter: PurchaseFilter = {
        search: command.search ?? null,
        supplierPartyId: command.supplierPartyId ?? null,
        fromDate: command.fromDate ?? null,
        toDate: command.toDate ?? null,
        settlement: command.settlement ?? 'ALL',
        cursor: command.cursor ?? null,
        // One more than asked for, so "is there another page" costs nothing
        // extra (§3.9 keyset paging; `OFFSET` is banned).
        limit: limit + 1,
      };

      const today = this.clock.businessDate(ctx.timezone);
      const rows = await this.purchases.listPurchases(tx, ctx, filter);
      const summary = await this.purchases.summarise(tx, ctx, filter, today);
      const page = rows.slice(0, limit);

      return {
        data: page.map((row) => ({
          id: row.id,
          number: row.number,
          supplierPartyId: row.supplierPartyId,
          supplierName: row.supplierName,
          supplierBillRef: row.supplierBillRef,
          businessDate: row.businessDate,
          dueDate: row.dueDate,
          status: row.status,
          lineCount: row.lineCount,
          overdue: row.dueDate !== null && row.dueDate < today && row.dueMinor > 0,
          ...(showCost
            ? {
                grandTotalMinor: row.grandTotalMinor,
                paidMinor: row.paidMinor,
                dueMinor: row.dueMinor,
              }
            : {}),
        })),
        page: { nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null },
        summary: {
          purchaseCount: summary.purchaseCount,
          ...(showCost
            ? {
                periodTotalMinor: summary.periodTotalMinor,
                unpaidTotalMinor: summary.unpaidTotalMinor,
                overdueTotalMinor: summary.overdueTotalMinor,
              }
            : {}),
        },
      };
    });
  }

  async detail(command: PurchaseDetailCommand): Promise<PurchaseResponse> {
    return this.uow.run(command.ctx, async (tx) => {
      const { ctx } = command;
      await this.access.require(tx, ctx, Permission.PURCHASE_VIEW);
      const detail = await this.purchases.findPurchaseById(tx, ctx, command.purchaseId);
      if (detail === null) throw new AppError(ErrorCode.NOT_FOUND, 'Purchase not found');
      const showCost = (await this.access.permissionsOf(tx, ctx)).includes(Permission.COST_VIEW);
      return toPurchaseResponse(detail, showCost);
    });
  }
}
