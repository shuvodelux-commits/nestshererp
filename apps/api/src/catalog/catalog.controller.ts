import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, UseGuards } from '@nestjs/common';
import type { ManageCatalogService, TenantContext } from '@sher/core-application';
import type { CatalogResponse, RemoveCatalogEntryResponse } from '@sher/core-contracts';
import {
  AppError,
  createCategoryRequestSchema,
  ErrorCode,
  renameCategoryRequestSchema,
  saveBrandRequestSchema,
  saveUnitRequestSchema,
} from '@sher/core-contracts';

import { Ctx, TenantContextGuard } from '../auth/tenant-context.guard';
import { MANAGE_CATALOG_SERVICE } from './tokens';

/**
 * Units, brands and categories (Phase 2, §5.5).
 *
 * Validate shape → call use case → map result (R-B5). Every write returns the
 * **whole catalog** rather than the one row it changed: the screen shows all
 * three lists at once, and a shopkeeper who has just renamed a category should
 * not have to trust that the other lists are still what they were.
 *
 * Removal is `POST /{id}/remove`, an explicit action (§5.26), not a DELETE:
 * whether the row is deleted or archived depends on what refers to it, and the
 * caller is told which happened.
 */
@Controller('api/v1/catalog')
@UseGuards(TenantContextGuard)
export class CatalogController {
  constructor(@Inject(MANAGE_CATALOG_SERVICE) private readonly catalog: ManageCatalogService) {}

  @Get()
  async list(@Ctx() ctx: TenantContext): Promise<{ data: CatalogResponse }> {
    return { data: await this.catalog.list({ ctx }) };
  }

  @Post('units')
  async createUnit(
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: CatalogResponse }> {
    const parsed = saveUnitRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);
    return { data: await this.catalog.createUnit({ ctx, ...parsed.data }) };
  }

  @Patch('units/:id')
  async renameUnit(
    @Param('id') id: string,
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: CatalogResponse }> {
    const parsed = saveUnitRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);
    return { data: await this.catalog.renameUnit({ ctx, id, ...parsed.data }) };
  }

  @Post('units/:id/remove')
  @HttpCode(200)
  async removeUnit(
    @Param('id') id: string,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: RemoveCatalogEntryResponse }> {
    return { data: await this.catalog.removeUnit({ ctx, id }) };
  }

  @Post('brands')
  async createBrand(
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: CatalogResponse }> {
    const parsed = saveBrandRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);
    return { data: await this.catalog.createBrand({ ctx, ...parsed.data }) };
  }

  @Patch('brands/:id')
  async renameBrand(
    @Param('id') id: string,
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: CatalogResponse }> {
    const parsed = saveBrandRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);
    return { data: await this.catalog.renameBrand({ ctx, id, ...parsed.data }) };
  }

  @Post('brands/:id/remove')
  @HttpCode(200)
  async removeBrand(
    @Param('id') id: string,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: RemoveCatalogEntryResponse }> {
    return { data: await this.catalog.removeBrand({ ctx, id }) };
  }

  @Post('categories')
  async createCategory(
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: CatalogResponse }> {
    const parsed = createCategoryRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);
    return { data: await this.catalog.createCategory({ ctx, ...parsed.data }) };
  }

  @Patch('categories/:id')
  async renameCategory(
    @Param('id') id: string,
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: CatalogResponse }> {
    const parsed = renameCategoryRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);
    return { data: await this.catalog.renameCategory({ ctx, id, ...parsed.data }) };
  }

  @Post('categories/:id/remove')
  @HttpCode(200)
  async removeCategory(
    @Param('id') id: string,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: RemoveCatalogEntryResponse }> {
    return { data: await this.catalog.removeCategory({ ctx, id }) };
  }
}

/** Field names only — a validation message never echoes a value back. */
function invalidBody(issues: readonly { readonly path: readonly PropertyKey[] }[]): AppError {
  return new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid request body', {
    issues: issues.map((issue) => issue.path.join('.')).join(', '),
  });
}
