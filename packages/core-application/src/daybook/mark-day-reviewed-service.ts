import { Permission } from '@sher/core-contracts';
import type { DayReview, MarkDayReviewedRequest } from '@sher/core-contracts';
import { Ulid } from '@sher/shared-utils';
import type { Clock } from '@sher/shared-utils';

import type { AccessControl } from '../ports/access-control';
import type { AuditWriter } from '../ports/audit-writer';
import type { TenantContext } from '../ports/tenant-context';
import type { UnitOfWork } from '../ports/unit-of-work';
import type { DaybookRepository } from './daybook-repository';

/**
 * "I have checked this day" (§5.27, owner decision 2026-08-30).
 *
 * **WRITE CLASS: M.** It changes no figure anywhere — no journal entry, no
 * stock movement, no document — so there is no period guard and no posting.
 * Marking a **closed** month's day checked is deliberately allowed: reviewing
 * the books after they are closed is normal, and refusing it would mean the
 * tick could never be applied to exactly the days most worth reviewing.
 *
 * One mark per day, replaced by a later look rather than queued behind it: a
 * day checked twice is still a day checked, and the useful fact is who looked
 * last and what they said.
 */
export class MarkDayReviewedService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly access: AccessControl,
    private readonly daybook: DaybookRepository,
    private readonly audit: AuditWriter,
    private readonly clock: Clock,
  ) {}

  async execute(ctx: TenantContext, input: MarkDayReviewedRequest): Promise<DayReview> {
    return this.uow.run(ctx, async (tx) => {
      await this.access.require(tx, ctx, Permission.DAYBOOK_REVIEW_MARK);

      const existing = await this.daybook.findReview(tx, ctx, input.businessDate);
      await this.daybook.saveReview(tx, ctx, {
        id: Ulid.generate(this.clock),
        businessDate: input.businessDate,
        note: input.note,
      });

      await this.audit.append(tx, ctx, {
        entityType: 'daybook_review',
        entityId: input.businessDate,
        action: existing === null ? 'CREATE' : 'UPDATE',
        before: existing === null ? null : { note: existing.note ?? '' },
        after: { note: input.note ?? '' },
        source: 'API',
      });

      const saved = await this.daybook.findReview(tx, ctx, input.businessDate);
      return {
        businessDate: input.businessDate,
        reviewedAt: (saved?.reviewedAt ?? this.clock.now()).toISOString(),
        reviewedByName: saved?.reviewedByName ?? '',
        note: saved?.note ?? null,
      };
    });
  }
}
