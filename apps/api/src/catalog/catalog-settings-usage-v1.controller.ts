import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import type {
  CatalogSettingsUsageV1Snapshot,
  ReadCatalogSettingsUsageV1Service,
  TenantContext,
} from '@sher/core-application';

import { Ctx, TenantContextGuard } from '../auth/tenant-context.guard';
import { READ_CATALOG_SETTINGS_USAGE_V1_SERVICE } from './tokens';

/**
 * Opt-in read-only catalog usage projection. No changes to the existing
 * GET /api/v1/catalog or GET /api/v1/catalog/metadata-v1 contracts.
 * The owner has NOT authorized Product Settings live UI activation.
 */
@Controller('api/v1/catalog/settings-usage-v1')
@UseGuards(TenantContextGuard)
export class CatalogSettingsUsageV1Controller {
  constructor(
    @Inject(READ_CATALOG_SETTINGS_USAGE_V1_SERVICE)
    private readonly service: ReadCatalogSettingsUsageV1Service,
  ) {}

  @Get()
  async read(@Ctx() ctx: TenantContext): Promise<{ data: CatalogSettingsUsageV1Snapshot }> {
    return { data: await this.service.read(ctx) };
  }
}
