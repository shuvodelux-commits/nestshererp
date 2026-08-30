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
import type { SerialService, TenantContext, WarrantyService } from '@sher/core-application';
import type {
  ClaimCandidateResponse,
  SerialProgressResponse,
  SerialUnitResponse,
  WarrantyClaimListResponse,
  WarrantyClaimResponse,
} from '@sher/core-contracts';
import {
  AppError,
  ErrorCode,
  claimLookupQuerySchema,
  createWarrantyClaimRequestSchema,
  moveWarrantyClaimRequestSchema,
  recordSerialsRequestSchema,
  warrantyClaimListQuerySchema,
} from '@sher/core-contracts';

import { Ctx, TenantContextGuard } from '../auth/tenant-context.guard';
import { SERIAL_SERVICE, WARRANTY_SERVICE } from './tokens';

/** Serial numbers read off the goods (§5.19, D-18). Nothing here generates one. */
@Controller('api/v1/serials')
@UseGuards(TenantContextGuard)
export class SerialsController {
  constructor(@Inject(SERIAL_SERVICE) private readonly serials: SerialService) {}

  /**
   * Add scanned serials to a bill line.
   *
   * No `Idempotency-Key`: nothing financial happens, and a serial sent twice is
   * refused by name rather than replayed — "you have scanned that one already"
   * is the honest answer, not a silent success.
   */
  @Post()
  @HttpCode(201)
  async record(
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: SerialProgressResponse }> {
    const parsed = recordSerialsRequestSchema.safeParse(body);
    if (!parsed.success) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid serial list');
    return { data: await this.serials.record({ ctx, ...parsed.data }) };
  }

  /** What each line of a bill still owes in serials. */
  @Get('progress/:purchaseId')
  async progress(
    @Param('purchaseId') purchaseId: string,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: readonly SerialProgressResponse[] }> {
    if (purchaseId.length !== 26) throw new AppError(ErrorCode.NOT_FOUND, 'Purchase not found');
    return this.serials.progress({ ctx, purchaseId });
  }

  /** In-stock units of one product, for the till and for a replacement. */
  @Get('available/:productId')
  async available(
    @Param('productId') productId: string,
    @Query('limit') limit: string | undefined,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: readonly SerialUnitResponse[] }> {
    if (productId.length !== 26) throw new AppError(ErrorCode.NOT_FOUND, 'Product not found');
    const parsed = Number(limit ?? 100);
    return this.serials.available({
      ctx,
      productId,
      limit: Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 500 ? parsed : 100,
    });
  }
}

/** Warranty claims (§5.19). No money is decided here — the use case does that. */
@Controller('api/v1/warranty-claims')
@UseGuards(TenantContextGuard)
export class WarrantyController {
  constructor(@Inject(WARRANTY_SERVICE) private readonly warranty: WarrantyService) {}

  /** Serial first, then phone or invoice number, for goods with no serial. */
  @Get('lookup')
  async lookup(
    @Query() query: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: readonly ClaimCandidateResponse[] }> {
    const parsed = claimLookupQuerySchema.safeParse(query);
    if (!parsed.success) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid lookup');
    return this.warranty.lookup({ ctx, ...parsed.data });
  }

  @Get()
  async list(
    @Query() query: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<WarrantyClaimListResponse> {
    const parsed = warrantyClaimListQuerySchema.safeParse(query);
    if (!parsed.success) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid claim query');
    return this.warranty.list({ ctx, ...parsed.data });
  }

  @Get(':id')
  async detail(
    @Param('id') id: string,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: WarrantyClaimResponse }> {
    if (id.length !== 26) throw new AppError(ErrorCode.NOT_FOUND, 'Claim not found');
    return { data: await this.warranty.detail({ ctx, claimId: id }) };
  }

  @Post()
  @HttpCode(201)
  async create(
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: WarrantyClaimResponse }> {
    const parsed = createWarrantyClaimRequestSchema.safeParse(body);
    if (!parsed.success) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid claim');
    return { data: await this.warranty.create({ ctx, ...parsed.data }) };
  }

  /**
   * One step along the claim. Takes an `Idempotency-Key` because the settle
   * step can hand a unit out of own stock, which is a real stock movement and a
   * real charge to `WARRANTY_EXPENSE`.
   */
  @Post(':id/move')
  async move(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') operationId: string | undefined,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: WarrantyClaimResponse }> {
    const parsed = moveWarrantyClaimRequestSchema.safeParse(body);
    if (!parsed.success || operationId === undefined || operationId.length !== 26) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid request');
    }
    return {
      data: await this.warranty.move({ ctx, claimId: id, operationId, ...parsed.data }),
    };
  }
}
