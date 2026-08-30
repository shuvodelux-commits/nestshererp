import { targetProgress } from '@sher/core-domain';
import { AppError, ErrorCode, Permission } from '@sher/core-contracts';
import type { SetTargetRequest, TargetResponse } from '@sher/core-contracts';
import { daysInMonth, monthOf, monthRange, Ulid } from '@sher/shared-utils';
import type { Clock } from '@sher/shared-utils';

import type { AccessControl } from '../ports/access-control';
import type { AuditWriter } from '../ports/audit-writer';
import type { TenantContext } from '../ports/tenant-context';
import type { Tx, UnitOfWork } from '../ports/unit-of-work';
import type { ReportRepository } from './report-repository';

/**
 * The shop's monthly target, and where the month is heading (§5.20, O-10).
 *
 * **WRITE CLASS: M** (master data, R-D). Setting a target moves no money and
 * touches no stock: it is a number the owner typed about their own intentions,
 * so there is no period guard, no journal entry and no numbering — and a
 * target for a closed month is allowed, because closing the books does not
 * change what the shop had been aiming for.
 *
 * The projection is **never stored**. It is recomputed from the actual and the
 * days elapsed every time it is read, and it is labelled an estimate wherever
 * it is shown, because a stored estimate becomes indistinguishable from a
 * posted figure the moment somebody reads the row.
 */
export class ProfitTargetService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly access: AccessControl,
    private readonly reports: ReportRepository,
    private readonly audit: AuditWriter,
    private readonly clock: Clock,
  ) {}

  async get(ctx: TenantContext, month: string): Promise<TargetResponse> {
    return this.uow.run(ctx, async (tx) => {
      await this.access.require(tx, ctx, Permission.REPORT_PROFIT_VIEW);
      return this.progress(tx, ctx, month);
    });
  }

  async set(ctx: TenantContext, input: SetTargetRequest): Promise<TargetResponse> {
    return this.uow.run(ctx, async (tx) => {
      await this.access.require(tx, ctx, Permission.REPORT_TARGET_MANAGE);

      const existing = await this.reports.findTarget(tx, ctx, input.month);
      await this.reports.saveTarget(tx, ctx, {
        id: existing?.id ?? Ulid.generate(this.clock),
        month: input.month,
        basis: input.basis,
        amountMinor: input.amountMinor,
      });

      await this.audit.append(tx, ctx, {
        entityType: 'profit_target',
        entityId: input.month,
        action: existing === null ? 'CREATE' : 'UPDATE',
        before:
          existing === null
            ? null
            : { basis: existing.basis, amountMinor: String(existing.amountMinor) },
        after: { basis: input.basis, amountMinor: String(input.amountMinor) },
        source: 'API',
      });

      return this.progress(tx, ctx, input.month);
    });
  }

  private async progress(tx: Tx, ctx: TenantContext, month: string): Promise<TargetResponse> {
    if (!/^\d{4}-\d{2}$/.test(month)) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid month');
    }
    const stored = await this.reports.findTarget(tx, ctx, month);
    const basis = stored?.basis ?? 'PROFIT';
    const range = monthRange(month);
    const figures = await this.reports.profitFigures(tx, ctx, range);

    // Sales is measured net of returns, exactly as the Sales report measures
    // it, so a target and the report it is judged against cannot disagree.
    const netSales = figures.salesMinor - figures.returnsMinor;
    const actualMinor =
      basis === 'SALES' ? netSales : netSales - figures.cogsMinor - figures.expenseMinor - figures.otherMinor;

    const today = this.clock.businessDate(ctx.timezone);
    const total = daysInMonth(month);
    // A month already past has run its full course; the month in progress has
    // run as far as today; a future month has not started.
    const elapsedDays =
      monthOf(today) === month ? Number(today.slice(8, 10)) : today > range.to ? total : 0;

    return {
      month,
      basis,
      ...targetProgress({
        targetMinor: stored?.amountMinor ?? null,
        actualMinor,
        elapsedDays,
        daysInMonth: total,
      }),
    };
  }
}
