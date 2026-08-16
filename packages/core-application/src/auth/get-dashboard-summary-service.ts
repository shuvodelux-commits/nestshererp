import { AppError, ErrorCode } from '@sher/core-contracts';
import type { DashboardSummaryResponse } from '@sher/core-contracts';

import type { TenantContext } from '../ports/tenant-context';
import type { UnitOfWork } from '../ports/unit-of-work';
import type { TenantRepository } from './registration-repository';

/**
 * What the dashboard can honestly show after slice 1.1: which business you are
 * signed in to. Sales, dues, payables and low stock are Phase 9 (slice 9.6) and
 * are not faked here — an ERP dashboard showing invented numbers is worse than
 * an empty one.
 *
 * No permission check: a signed-in user reading their own tenant's name is the
 * weakest possible read, and inventing a `dashboard.view` code now would mean
 * seeding it into every role before roles exist (slice 1.4). The real gating
 * lands with the cards that carry real figures.
 */
export class GetDashboardSummaryService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly tenants: TenantRepository,
  ) {}

  async execute(ctx: TenantContext): Promise<DashboardSummaryResponse> {
    return this.uow.run(ctx, async (tx) => {
      const name = await this.tenants.findName(tx, ctx);
      // A valid token for a tenant that no longer exists reads as not found,
      // never as a server error.
      if (name === null) throw new AppError(ErrorCode.NOT_FOUND, 'Business not found');
      return { businessName: name };
    });
  }
}
