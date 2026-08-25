import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { ManageProductsService, TenantContext } from '@sher/core-application';
import type {
  GeneratedBarcodeResponse,
  ProductListResponse,
  ProductResponse,
} from '@sher/core-contracts';
import {
  AppError,
  ErrorCode,
  productQuerySchema,
  saveProductImageRequestSchema,
  saveProductRequestSchema,
  setProductStatusRequestSchema,
  updateProductRequestSchema,
} from '@sher/core-contracts';

import { Response } from '@nestjs/common';
import type { Response as ExpressResponse } from 'express';

import { Ctx, TenantContextGuard } from '../auth/tenant-context.guard';
import { MANAGE_PRODUCTS_SERVICE } from './tokens';

/**
 * Products (Phase 2, §5.5).
 *
 * Validate shape → build command → call use case → map result (R-B5). Which
 * fields the caller may see, whether an offer may be set at all, and whether the
 * version is still current are decided in the use case — a controller cannot see
 * any of it.
 *
 * `Idempotency-Key` is the transport for `operation_id`: the same value under two
 * names (§5.26). The client generates it once per intent and reuses it on retry.
 */
@Controller('api/v1/products')
@UseGuards(TenantContextGuard)
export class ProductsController {
  constructor(@Inject(MANAGE_PRODUCTS_SERVICE) private readonly products: ManageProductsService) {}

  @Get()
  async list(
    @Query() query: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<ProductListResponse> {
    const parsed = productQuerySchema.safeParse(query);
    if (!parsed.success) throw invalidBody(parsed.error.issues);

    // The whole envelope, not just `data`: §5.26 puts `page` beside it, and the
    // summary tiles are counted by the same query as the rows.
    return this.products.list({ ctx, ...parsed.data });
  }

  @Get(':id')
  async get(
    @Param('id') id: string,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: ProductResponse }> {
    return { data: await this.products.get({ ctx, productId: id }) };
  }

  @Post()
  async create(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: ProductResponse }> {
    const parsed = saveProductRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);
    if (idempotencyKey === undefined || idempotencyKey.length !== 26) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Idempotency-Key header is required');
    }

    return {
      data: await this.products.create({
        ctx,
        operationId: idempotencyKey,
        input: { ...parsed.data },
      }),
    };
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: ProductResponse }> {
    const parsed = updateProductRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);

    const { version, ...input } = parsed.data;
    return { data: await this.products.update({ ctx, productId: id, version, input }) };
  }

  /** 200, not 201: this changes a product, it does not create one. */
  @Post(':id/status')
  @HttpCode(200)
  async setStatus(
    @Param('id') id: string,
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: ProductResponse }> {
    const parsed = setProductStatusRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);
    return { data: await this.products.setStatus({ ctx, productId: id, ...parsed.data }) };
  }

  @Post(':id/barcode')
  @HttpCode(200)
  async generateBarcode(
    @Param('id') id: string,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: GeneratedBarcodeResponse }> {
    return { data: await this.products.generateBarcode({ ctx, productId: id }) };
  }

  /**
   * Only ever succeeds for a product nothing refers to (§3.6). The refusal, and
   * the "deactivate it instead" that follows, are the use case's decision.
   */
  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string, @Ctx() ctx: TenantContext): Promise<void> {
    await this.products.deleteProduct({ ctx, productId: id });
  }

  /**
   * A product's thumbnail (owner decision 2026-08-25).
   *
   * The bytes are served rather than embedded in the product JSON: a POS grid
   * asks for a page of products constantly and would carry every picture with
   * every refresh. As an ordinary image URL the browser caches it, and a
   * product without one simply 404s and the tile draws its letters.
   */
  @Get(':id/image')
  async image(
    @Param('id') id: string,
    @Ctx() ctx: TenantContext,
    @Response() response: ExpressResponse,
  ): Promise<void> {
    if (id.length !== 26) throw new AppError(ErrorCode.NOT_FOUND, 'Product not found');
    const image = await this.products.image(ctx, id);
    response.setHeader('Content-Type', image.mime);
    // Private: it is one shop's own picture, and it changes when they replace it.
    response.setHeader('Cache-Control', 'private, max-age=300');
    response.end(Buffer.from(image.bytes));
  }

  @Post(':id/image')
  async saveImage(
    @Param('id') id: string,
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: ProductResponse }> {
    if (id.length !== 26) throw new AppError(ErrorCode.NOT_FOUND, 'Product not found');
    const parsed = saveProductImageRequestSchema.safeParse(body);
    if (!parsed.success) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid picture');
    return { data: await this.products.saveImage({ ctx, productId: id, image: parsed.data }) };
  }

  @Delete(':id/image')
  async removeImage(
    @Param('id') id: string,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: ProductResponse }> {
    if (id.length !== 26) throw new AppError(ErrorCode.NOT_FOUND, 'Product not found');
    return { data: await this.products.saveImage({ ctx, productId: id, image: null }) };
  }
}

/** Field names only — a validation message never echoes a value back. */
function invalidBody(issues: readonly { readonly path: readonly PropertyKey[] }[]): AppError {
  return new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid request body', {
    issues: issues.map((issue) => issue.path.join('.')).join(', '),
  });
}
