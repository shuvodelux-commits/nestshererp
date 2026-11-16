import { Body, Controller, Get, Inject, Param, Patch, UseGuards } from '@nestjs/common';
import type {
  ManageCatalogLifecycleV1StatusService,
  ReadCatalogLifecycleV1Service,
  TenantContext,
} from '@sher/core-application';
import {
  AppError, ErrorCode,
  catalogLifecycleV1StatusRequestSchema,
  catalogLifecycleV1UnitRosterEnvelopeSchema,
  catalogLifecycleV1BrandRosterEnvelopeSchema,
  catalogLifecycleV1CategoryRosterEnvelopeSchema,
} from '@sher/core-contracts';

import { Ctx, TenantContextGuard } from '../auth/tenant-context.guard';
import { mapCatalogLifecycleV1Status } from './catalog-lifecycle-v1-status-response';
import type { LifecycleKind } from './catalog-lifecycle-v1-status-response';
import {
  READ_CATALOG_LIFECYCLE_V1_SERVICE,
  MANAGE_CATALOG_LIFECYCLE_V1_STATUS_SERVICE,
} from './tokens';

/**
 * MOD-002 P8b3-T1 #333: explicit opt-in authenticated catalog lifecycle API.
 *
 * The guard validates the signed JWT and supplies context; each application
 * service rechecks CURRENT tenant/user/role permissions inside its PostgreSQL
 * FORCE-RLS transaction. No tenant/user IDs or role claims are accepted from
 * request bodies. Legacy catalog and metadata routes are not modified.
 *
 * Roster GET cannot mutate; status PATCH uses CAS + Class-M audit/outbox.
 * Product Settings live React UI is NOT activated by mounting this controller.
 */
@Controller('api/v1/catalog/lifecycle-v1')
@UseGuards(TenantContextGuard)
export class CatalogLifecycleV1Controller {
  constructor(
    @Inject(READ_CATALOG_LIFECYCLE_V1_SERVICE)
    private readonly roster: ReadCatalogLifecycleV1Service,
    @Inject(MANAGE_CATALOG_LIFECYCLE_V1_STATUS_SERVICE)
    private readonly status: ManageCatalogLifecycleV1StatusService,
  ) {}

  @Get('units')
  async units(@Ctx() ctx: TenantContext) {
    return catalogLifecycleV1UnitRosterEnvelopeSchema.parse({
      data: await this.roster.read(ctx, 'unit'),
    });
  }

  @Get('brands')
  async brands(@Ctx() ctx: TenantContext) {
    return catalogLifecycleV1BrandRosterEnvelopeSchema.parse({
      data: await this.roster.read(ctx, 'brand'),
    });
  }

  @Get('categories')
  async categories(@Ctx() ctx: TenantContext) {
    return catalogLifecycleV1CategoryRosterEnvelopeSchema.parse({
      data: await this.roster.read(ctx, 'category'),
    });
  }

  @Patch('units/:id/status')
  async unitStatus(@Param('id') id: string, @Body() body: unknown, @Ctx() ctx: TenantContext) {
    return this.update('unit', id, body, ctx);
  }

  @Patch('brands/:id/status')
  async brandStatus(@Param('id') id: string, @Body() body: unknown, @Ctx() ctx: TenantContext) {
    return this.update('brand', id, body, ctx);
  }

  @Patch('categories/:id/status')
  async categoryStatus(@Param('id') id: string, @Body() body: unknown, @Ctx() ctx: TenantContext) {
    return this.update('category', id, body, ctx);
  }

  private async update(kind: LifecycleKind, id: string, body: unknown, ctx: TenantContext) {
    if (!/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(id)) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid catalog entry ID');
    }
    const parsed = catalogLifecycleV1StatusRequestSchema.safeParse(body);
    if (!parsed.success) {
      // Static validation message, never echo user-supplied metadata or IDs.
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid catalog lifecycle status request');
    }
    const result = await this.status.transition({
      ctx, kind, id,
      expectedVersion: parsed.data.expectedVersion,
      desiredState: parsed.data.desiredState,
    });
    return mapCatalogLifecycleV1Status(kind, id, result);
  }
}
