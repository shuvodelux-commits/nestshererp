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
import type { TenantContext, VendorStockService } from '@sher/core-application';
import type {
  VendorSettlementResponse,
  VendorStockReceiptResponse,
} from '@sher/core-contracts';
import {
  AppError,
  ErrorCode,
  receiveVendorStockRequestSchema,
  returnVendorStockRequestSchema,
} from '@sher/core-contracts';

import { Ctx, TenantContextGuard } from '../auth/tenant-context.guard';
import { VENDOR_STOCK_SERVICE } from './tokens';

/**
 * Goods a vendor left to be sold on their behalf (§5.6 M07, DR13.10).
 *
 * Both writes take an `Idempotency-Key` even though neither posts a journal
 * entry: they move stock, and stock recorded twice is as wrong as money
 * recorded twice.
 */
@Controller('api/v1/vendor-stock')
@UseGuards(TenantContextGuard)
export class VendorStockController {
  constructor(@Inject(VENDOR_STOCK_SERVICE) private readonly vendors: VendorStockService) {}

  @Get()
  async list(
    @Query('vendorPartyId') vendorPartyId: string | undefined,
    @Query('limit') limit: string | undefined,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: readonly VendorStockReceiptResponse[] }> {
    const parsed = Number(limit ?? 100);
    return this.vendors.listReceipts({
      ctx,
      vendorPartyId: vendorPartyId === undefined || vendorPartyId === '' ? undefined : vendorPartyId,
      limit: Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 200 ? parsed : 100,
    });
  }

  /** `Received · Sold · Returned · Due · Paid · Balance` for one vendor. */
  @Get('settlement/:vendorPartyId')
  async settlement(
    @Param('vendorPartyId') vendorPartyId: string,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: VendorSettlementResponse }> {
    if (vendorPartyId.length !== 26) throw new AppError(ErrorCode.NOT_FOUND, 'Vendor not found');
    return { data: await this.vendors.settlement({ ctx, vendorPartyId }) };
  }

  @Post()
  @HttpCode(201)
  async receive(
    @Body() body: unknown,
    @Headers('idempotency-key') operationId: string | undefined,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: VendorStockReceiptResponse }> {
    const parsed = receiveVendorStockRequestSchema.safeParse(body);
    if (!parsed.success || operationId === undefined || operationId.length !== 26) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid vendor stock request');
    }
    return { data: await this.vendors.receive({ ctx, operationId, ...parsed.data }) };
  }

  @Post('returns')
  @HttpCode(201)
  async returnStock(
    @Body() body: unknown,
    @Headers('idempotency-key') operationId: string | undefined,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: VendorStockReceiptResponse }> {
    const parsed = returnVendorStockRequestSchema.safeParse(body);
    if (!parsed.success || operationId === undefined || operationId.length !== 26) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid vendor return request');
    }
    return { data: await this.vendors.returnStock({ ctx, operationId, ...parsed.data }) };
  }
}
