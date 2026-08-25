import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type {
  CreatePurchaseService,
  PurchaseQueryService,
  TenantContext,
  VoidPurchaseService,
} from '@sher/core-application';
import type { PurchaseListResponse, PurchaseResponse } from '@sher/core-contracts';
import {
  AppError,
  createPurchaseRequestSchema,
  voidPurchaseRequestSchema,
  ErrorCode,
  purchaseListQuerySchema,
} from '@sher/core-contracts';

import { Ctx, TenantContextGuard } from '../auth/tenant-context.guard';
import { CREATE_PURCHASE_SERVICE, PURCHASE_QUERY_SERVICE, VOID_PURCHASE_SERVICE } from './tokens';

/**
 * Purchases (§5.9). Validate shape → build command → call use case → map result
 * (R-B5). Which supplier is valid, which account the money may leave, whether
 * the day is open and what the goods now cost are all decided in the use case.
 */
@Controller('api/v1/purchases')
@UseGuards(TenantContextGuard)
export class PurchasesController {
  constructor(
    @Inject(CREATE_PURCHASE_SERVICE) private readonly purchases: CreatePurchaseService,
    @Inject(PURCHASE_QUERY_SERVICE) private readonly query: PurchaseQueryService,
    @Inject(VOID_PURCHASE_SERVICE) private readonly voiding: VoidPurchaseService,
  ) {}

  @Get()
  async list(@Query() query: unknown, @Ctx() ctx: TenantContext): Promise<PurchaseListResponse> {
    const parsed = purchaseListQuerySchema.safeParse(query);
    if (!parsed.success) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid purchase query');
    return this.query.list({ ctx, ...parsed.data });
  }

  @Get(':id')
  async detail(
    @Param('id') id: string,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: PurchaseResponse }> {
    if (id.length !== 26) throw new AppError(ErrorCode.NOT_FOUND, 'Purchase not found');
    return { data: await this.query.detail({ ctx, purchaseId: id }) };
  }

  @Post()
  @HttpCode(201)
  async create(
    @Body() body: unknown,
    @Headers('idempotency-key') operationId: string | undefined,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: PurchaseResponse }> {
    const parsed = createPurchaseRequestSchema.safeParse(body);
    if (!parsed.success || operationId === undefined || operationId.length !== 26) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid purchase request');
    }
    return { data: await this.purchases.create({ ctx, operationId, ...parsed.data }) };
  }

  /**
   * Cancelling a posted bill (§2.5). A correction is not here: it is the create
   * endpoint with `correctionOf` set, because there is one purchase writer.
   */
  @Post(':id/void')
  async void(
    @Param('id') id: string,
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: PurchaseResponse }> {
    const parsed = voidPurchaseRequestSchema.safeParse(body);
    if (!parsed.success) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid request');
    return {
      data: await this.voiding.void({
        ctx,
        purchaseId: id,
        version: parsed.data.version,
        reason: parsed.data.reason,
      }),
    };
  }
}
