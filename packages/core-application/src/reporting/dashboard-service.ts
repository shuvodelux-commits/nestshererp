import { Permission } from '@sher/core-contracts';
import type { DashboardResponse } from '@sher/core-contracts';
import { monthOf } from '@sher/shared-utils';
import type { Clock } from '@sher/shared-utils';

import type { TenantRepository } from '../auth/registration-repository';
import type { AccessControl } from '../ports/access-control';
import type { TenantContext } from '../ports/tenant-context';
import type { UnitOfWork } from '../ports/unit-of-work';
import type { ProfitTargetService } from './profit-target-service';
import type { ReportRepository } from './report-repository';

/**
 * The dashboard's fixed card set (§5.20, owner decision 2026-08-30).
 *
 * **A card the user may not see is absent from the response**, not sent and
 * hidden by the browser (UI-40, R-E8): the body is the boundary, and a cashier
 * reading the network tab must not find the shop's profit in it. There is no
 * arrangement screen and no stored preference — the set is fixed, and the
 * owner says if a card is missing.
 *
 * `todayProfitMinor` additionally obeys D-06: it is sent with
 * `profitProvisional` beside it whenever any sale in the day was costed
 * provisionally, and the screen marks it rather than presenting it as final.
 */
export class DashboardService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly access: AccessControl,
    private readonly reports: ReportRepository,
    private readonly tenants: TenantRepository,
    private readonly targets: ProfitTargetService,
    private readonly clock: Clock,
  ) {}

  async execute(ctx: TenantContext): Promise<DashboardResponse> {
    const businessDate = this.clock.businessDate(ctx.timezone);

    const body = await this.uow.run(ctx, async (tx) => {
      const held = await this.access.permissionsOf(tx, ctx);
      const businessName = (await this.tenants.findName(tx, ctx)) ?? '';
      const may = (code: string): boolean => held.includes(code);

      // Without the dashboard permission the screen still knows which shop it
      // is signed in to — the weakest possible read, and what slice 1.1 always
      // showed. Everything with a figure in it needs its own report code.
      if (!may(Permission.DASHBOARD_VIEW)) return { businessName, businessDate };

      const figures = await this.reports.dashboardFigures(tx, ctx, businessDate);
      const sales = may(Permission.REPORT_SALES_VIEW);
      const money = may(Permission.REPORT_MONEY_VIEW);
      const stock = may(Permission.REPORT_STOCK_VIEW);
      const profit = may(Permission.REPORT_PROFIT_VIEW);

      return {
        businessName,
        businessDate,
        ...(sales
          ? {
              todaySalesMinor: figures.todaySalesMinor,
              todaySaleCount: figures.todaySaleCount,
              recentSales: (await this.reports.recentSales(tx, ctx, 5)).map((sale) => ({
                id: sale.id,
                number: sale.number,
                customerName: sale.customerName,
                grandTotalMinor: sale.grandTotalMinor,
                createdAt: sale.createdAt.toISOString(),
              })),
            }
          : {}),
        ...(money
          ? {
              cashInHandMinor: figures.cashInHandMinor,
              bankBalanceMinor: figures.bankBalanceMinor,
              customerDueMinor: figures.customerDueMinor,
              supplierPayableMinor: figures.supplierPayableMinor,
            }
          : {}),
        ...(stock ? { lowStockCount: figures.lowStockCount } : {}),
        ...(stock && may(Permission.COST_VIEW) ? { stockValueMinor: figures.stockValueMinor } : {}),
        ...(profit
          ? {
              todayProfitMinor:
                figures.todaySalesMinor - figures.todayCogsMinor - figures.todayExpenseMinor,
              profitProvisional: figures.profitProvisional,
            }
          : {}),
      };
    });

    if (body.businessDate === undefined) return body;
    // The target reads its own month through its own service rather than being
    // recomputed here, so the card and the Reports screen can never disagree.
    try {
      const target = await this.targets.get(ctx, monthOf(businessDate));
      return { ...body, target };
    } catch {
      // No profit permission: the card is simply absent, like every other one.
      return body;
    }
  }
}
