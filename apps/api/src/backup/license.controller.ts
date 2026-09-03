import { Body, Controller, Get, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import type {
  LicenseInstallService,
  LicenseStatusService,
  TenantContext,
} from '@sher/core-application';
import { licenseInstallRequestSchema } from '@sher/core-contracts';
import type {
  LicenseInstallResponse,
  LicenseNotice,
  LicenseStatusResponse,
} from '@sher/core-contracts';

import { Ctx, TenantContextGuard } from '../auth/tenant-context.guard';
import { invalidBody } from '../money/accounts.controller';
import { LICENSE_INSTALL_SERVICE, LICENSE_STATUS_SERVICE } from './tokens';

/**
 * What the licence says, and how a new one gets here (§5.4, D-36, owner
 * decisions 2026-09-02).
 *
 * **The one write route takes a single string and decides nothing itself.**
 * Which business, which modules, how long — all of it is inside a payload
 * signed by the vendor's key, checked by the service before anything is
 * written. There is still no field a client can post that changes what a
 * licence grants, which is why restoring a backup cannot restore, extend or
 * bypass one (D-08).
 */
@Controller('api/v1/license')
@UseGuards(TenantContextGuard)
export class LicenseController {
  constructor(
    @Inject(LICENSE_STATUS_SERVICE) private readonly licenses: LicenseStatusService,
    @Inject(LICENSE_INSTALL_SERVICE) private readonly installs: LicenseInstallService,
  ) {}

  /**
   * Install or renew the licence. Needs `license.install`, the Owner's alone.
   *
   * Reachable while the licence has lapsed — the read-only guard lets this path
   * through on purpose, because it is the one action that ends READ_ONLY.
   */
  @Post()
  @HttpCode(200)
  async install(
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<LicenseInstallResponse> {
    const parsed = licenseInstallRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);

    return this.installs.install(ctx, parsed.data.key);
  }

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
