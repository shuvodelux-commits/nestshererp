import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import type { LicenseStatusService, TenantContext } from '@sher/core-application';
import type { LicenseNotice, LicenseStatusResponse } from '@sher/core-contracts';

import { Ctx, TenantContextGuard } from '../auth/tenant-context.guard';
import { LICENSE_STATUS_SERVICE } from './tokens';

/**
 * What the licence says (Phase 10, §5.4, D-36).
 *
 * Two routes and no write path. Entitlement comes from the signed key file on
 * this machine, so there is nothing a client could send that would change what
 * either of them returns — which is also why restoring a backup cannot restore,
 * extend or bypass a licence.
 */
@Controller('api/v1/license')
@UseGuards(TenantContextGuard)
export class LicenseController {
  constructor(
    @Inject(LICENSE_STATUS_SERVICE) private readonly licenses: LicenseStatusService,
  ) {}

  /** Settings → Licence. Needs `license.term.view`. */
  @Get()
  async status(@Ctx() ctx: TenantContext): Promise<LicenseStatusResponse> {
    return this.licenses.status(ctx);
  }

  /**
   * The banner, for every signed-in user whatever their role.
   *
   * Ungated on purpose: a cashier whose sale will not save has to be told why
   * on the screen they are standing at, and putting that behind a permission
   * they do not hold would leave them looking at a failure with no explanation.
   */
  @Get('notice')
  async notice(@Ctx() ctx: TenantContext): Promise<LicenseNotice> {
    return this.licenses.notice(ctx);
  }
}
