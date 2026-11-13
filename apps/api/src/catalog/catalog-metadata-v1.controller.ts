import { Body, Controller, Get, Inject, Param, Patch, UseGuards } from '@nestjs/common';
import type { ManageCatalogMetadataV1Service, TenantContext } from '@sher/core-application';
import {
  AppError,
  ErrorCode,
  patchCatalogMetadataV1BrandRequestSchema,
  patchCatalogMetadataV1CategoryRequestSchema,
  patchCatalogMetadataV1UnitRequestSchema,
} from '@sher/core-contracts';
import type { CatalogMetadataV1Response } from '@sher/core-contracts';

import { Ctx, TenantContextGuard } from '../auth/tenant-context.guard';
import { MANAGE_CATALOG_METADATA_V1_SERVICE } from './tokens';

/**
 * HisabIQ MOD-002 T02A: opt-in catalog metadata endpoints.
 *
 * These routes are intentionally separate from GET /api/v1/catalog and from
 * its strict name-only create/rename/remove routes. All requests use the
 * established authenticated tenant guard and the same Class M application
 * service, permissions, unit of work, audit and outbox.
 *
 * Metadata-only edits never rename the English catalog key or reparent a
 * category. Unit symbols are display labels, not unit identities/factors.
 * Metadata-v1 create is NOT implemented here: the existing name-only create
 * route remains the supported path until a separately scoped create service
 * exists.
 */
@Controller('api/v1/catalog/metadata-v1')
@UseGuards(TenantContextGuard)
export class CatalogMetadataV1Controller {
  constructor(
    @Inject(MANAGE_CATALOG_METADATA_V1_SERVICE)
    private readonly metadata: ManageCatalogMetadataV1Service,
  ) {}

  @Get()
  async list(@Ctx() ctx: TenantContext): Promise<{ data: CatalogMetadataV1Response }> {
    return { data: await this.metadata.list({ ctx }) };
  }

  @Patch('units/:id')
  async patchUnit(
    @Param('id') id: string,
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: CatalogMetadataV1Response }> {
    const input = patchCatalogMetadataV1UnitRequestSchema.safeParse(body);
    if (!input.success) throw invalidBody(input.error.issues);
    return { data: await this.metadata.patchUnit({ ctx, id, input: input.data }) };
  }

  @Patch('brands/:id')
  async patchBrand(
    @Param('id') id: string,
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: CatalogMetadataV1Response }> {
    const input = patchCatalogMetadataV1BrandRequestSchema.safeParse(body);
    if (!input.success) throw invalidBody(input.error.issues);
    return { data: await this.metadata.patchBrand({ ctx, id, input: input.data }) };
  }

  @Patch('categories/:id')
  async patchCategory(
    @Param('id') id: string,
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: CatalogMetadataV1Response }> {
    const input = patchCatalogMetadataV1CategoryRequestSchema.safeParse(body);
    if (!input.success) throw invalidBody(input.error.issues);
    return { data: await this.metadata.patchCategory({ ctx, id, input: input.data }) };
  }
}

/** Field paths only: never echo tenant-supplied Bangla text or symbols in errors. */
function invalidBody(issues: readonly { readonly path: readonly PropertyKey[] }[]): AppError {
  return new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid catalog metadata request', {
    issues: issues.map((issue) => issue.path.join('.')).join(', '),
  });
}
