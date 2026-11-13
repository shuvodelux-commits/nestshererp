import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { PurchaseDraftResponse, PurchaseDraftService, TenantContext } from '@sher/core-application';
import {
  AppError,
  ErrorCode,
  createPurchaseDraftRequestSchema,
  updatePurchaseDraftRequestSchema,
  purchaseDraftVersionRequestSchema,
  purchaseDraftListQuerySchema,
} from '@sher/core-contracts';

import { Ctx, TenantContextGuard } from '../auth/tenant-context.guard';
import { PURCHASE_DRAFT_SERVICE } from './tokens';

const validId = (id: string): void => {
  if (id.length !== 26) throw new AppError(ErrorCode.NOT_FOUND, 'Draft not found');
};

/**
 * Registered before the existing /purchases/:id handler so /purchases/drafts
 * cannot be mistaken for a posted purchase id.
 */
@Controller('api/v1/purchases')
@UseGuards(TenantContextGuard)
export class PurchaseDraftsController {
  constructor(@Inject(PURCHASE_DRAFT_SERVICE) private readonly drafts: PurchaseDraftService) {}

  @Get('drafts')
  async list(@Query() query: unknown, @Ctx() ctx: TenantContext): Promise<{ data: readonly PurchaseDraftResponse[] }> {
    const parsed = purchaseDraftListQuerySchema.safeParse(query);
    if (!parsed.success) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid draft filter');
    return { data: await this.drafts.list(ctx, parsed.data.state) };
  }

  @Get('drafts/:id')
  async detail(@Param('id') id: string, @Ctx() ctx: TenantContext): Promise<{ data: PurchaseDraftResponse }> {
    validId(id);
    return { data: await this.drafts.detail(ctx, id) };
  }

  @Post('drafts')
  @HttpCode(201)
  async create(@Body() body: unknown, @Ctx() ctx: TenantContext): Promise<{ data: PurchaseDraftResponse }> {
    const parsed = createPurchaseDraftRequestSchema.safeParse(body);
    if (!parsed.success) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid purchase draft');
    return { data: await this.drafts.create(ctx, parsed.data) };
  }

  @Put('drafts/:id')
  async update(
    @Param('id') id: string, @Body() body: unknown, @Ctx() ctx: TenantContext,
  ): Promise<{ data: PurchaseDraftResponse }> {
    validId(id);
    const parsed = updatePurchaseDraftRequestSchema.safeParse(body);
    if (!parsed.success) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid purchase draft update');
    return { data: await this.drafts.update(ctx, id, parsed.data) };
  }

  @Delete('drafts/:id')
  async recycle(
    @Param('id') id: string, @Body() body: unknown, @Ctx() ctx: TenantContext,
  ): Promise<{ data: PurchaseDraftResponse }> {
    validId(id);
    const parsed = purchaseDraftVersionRequestSchema.safeParse(body);
    if (!parsed.success) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Draft version required');
    return { data: await this.drafts.recycle(ctx, id, parsed.data.expectedVersion) };
  }

  @Post('drafts/:id/restore')
  async restore(
    @Param('id') id: string, @Body() body: unknown, @Ctx() ctx: TenantContext,
  ): Promise<{ data: PurchaseDraftResponse }> {
    validId(id);
    const parsed = purchaseDraftVersionRequestSchema.safeParse(body);
    if (!parsed.success) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Draft version required');
    return { data: await this.drafts.restore(ctx, id, parsed.data.expectedVersion) };
  }
}
