import { AppError, ErrorCode, Permission } from '@sher/core-contracts';
import type { PeriodListResponse, PeriodResponse } from '@sher/core-contracts';
import { Ulid } from '@sher/shared-utils';
import type { Clock } from '@sher/shared-utils';

import type { AccessControl } from '../ports/access-control';
import type { AuditWriter } from '../ports/audit-writer';
import type { TenantContext } from '../ports/tenant-context';
import type { UnitOfWork } from '../ports/unit-of-work';
import type { PeriodRepository, PeriodRow } from './period-repository';

/**
 * Closing an accounting month (§5.19, D-25, owner decision 2026-08-26).
 *
 * **Closed is final.** The owner chose a manual close with no unlock: a
 * correction posts in the month that is open, the way a closed book is handled
 * everywhere else. That is what makes `PERIOD_LOCKED` a guarantee rather than a
 * speed bump — and it is why this service has no reopen method at all, rather
 * than one behind a permission nobody holds.
 *
 * **The current month cannot be closed.** A shop closing the month it is
 * standing in would refuse its own next sale, which is not a decision anybody
 * means to make. February closes in March.
 */
export class ManagePeriodsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly access: AccessControl,
    private readonly periods: PeriodRepository,
    private readonly audit: AuditWriter,
    private readonly clock: Clock,
  ) {}

  async list(ctx: TenantContext): Promise<PeriodListResponse> {
    return this.uow.run(ctx, async (tx) => {
      // Reading which months are shut is not the same trust as shutting one:
      // anyone who may see the books may see this, and only `period.close`
      // changes it.
      await this.access.require(tx, ctx, Permission.SETTING_VIEW);
      const today = this.clock.businessDate(ctx.timezone);
      const rows = await this.periods.listPeriods(tx, ctx, 36);
      return { periods: rows.map((row) => toResponse(row, today)) };
    });
  }

  async close(command: {
    readonly ctx: TenantContext;
    readonly year: number;
    readonly month: number;
    readonly note: string | null;
  }): Promise<PeriodResponse> {
    return this.uow.run(command.ctx, async (tx) => {
      const { ctx } = command;
      await this.access.require(tx, ctx, Permission.PERIOD_CLOSE);

      const today = this.clock.businessDate(ctx.timezone);
      const period = `${String(command.year).padStart(4, '0')}-${String(command.month).padStart(2, '0')}`;
      if (period >= today.slice(0, 7)) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'A month can only be closed once it is over',
        );
      }

      const existing = await this.periods.findPeriod(tx, ctx, command.year, command.month);
      if (existing?.status === 'CLOSED') {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'That month is already closed');
      }

      await this.periods.close(tx, ctx, {
        id: Ulid.generate(this.clock),
        year: command.year,
        month: command.month,
        note: command.note,
      });

      await this.audit.append(tx, ctx, {
        entityType: 'period_lock',
        entityId: period,
        action: 'UPDATE',
        before: { status: 'OPEN' },
        // The trail carries what was frozen, because after this nothing can be
        // added to it and the count stops being recoverable by re-reading.
        after: {
          status: 'CLOSED',
          entryCount: String(existing?.entryCount ?? 0),
          note: command.note ?? '',
        },
        source: 'API',
      });

      const updated = await this.periods.findPeriod(tx, ctx, command.year, command.month);
      if (updated === null) throw new AppError(ErrorCode.INTERNAL_ERROR, 'The month did not close');
      return toResponse(updated, today);
    });
  }
}

function toResponse(row: PeriodRow, today: string): PeriodResponse {
  const period = `${String(row.year).padStart(4, '0')}-${String(row.month).padStart(2, '0')}`;
  return {
    period,
    year: row.year,
    month: row.month,
    status: row.status,
    entryCount: row.entryCount,
    closedAt: row.closedAt === null ? null : row.closedAt.toISOString(),
    closedByName: row.closedByName,
    isCurrent: period === today.slice(0, 7),
  };
}
