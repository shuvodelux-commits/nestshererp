import {
  Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, UseGuards,
} from '@nestjs/common';
import type {
  CostAdjustmentRow, InventoryOverviewResponse, OpeningStockResponse,
  StockAdjustmentResponse, StockAdjustmentRow,
} from '@sher/core-contracts';
import {
  adjustStockRequestSchema, AppError, ErrorCode, inventoryReportQuerySchema,
  recordOpeningStockRequestSchema,
  voidDocumentRequestSchema,
} from '@sher/core-contracts';
import type { ManageInventoryService, TenantContext } from '@sher/core-application';

import { Ctx, TenantContextGuard } from '../auth/tenant-context.guard';
import { MANAGE_INVENTORY_SERVICE } from './tokens';

@Controller('api/v1/inventory')
@UseGuards(TenantContextGuard)
export class InventoryController {
  constructor(@Inject(MANAGE_INVENTORY_SERVICE) private readonly inventory: ManageInventoryService) {}

  @Get()
  async overview(@Query() query: unknown, @Ctx() ctx: TenantContext): Promise<{ data: InventoryOverviewResponse }> {
    const parsed = inventoryReportQuerySchema.safeParse(query);
    if (!parsed.success) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid inventory query');
    return { data: await this.inventory.overview(ctx, parsed.data) };
  }

  @Get('adjustments')
  async adjustments(@Query() query: unknown, @Ctx() ctx: TenantContext): Promise<{ data: readonly StockAdjustmentRow[] }> {
    const parsed = inventoryReportQuerySchema.safeParse(query);
    if (!parsed.success) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid inventory query');
    return { data: await this.inventory.adjustments(ctx, parsed.data) };
  }

  @Get('cost-adjustments')
  async costAdjustments(@Query() query: unknown, @Ctx() ctx: TenantContext): Promise<{ data: readonly CostAdjustmentRow[] }> {
    const parsed = inventoryReportQuerySchema.safeParse(query);
    if (!parsed.success) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid inventory query');
    return { data: await this.inventory.costAdjustments(ctx, parsed.data) };
  }

  @Post('adjustments') @HttpCode(201)
  async adjust(@Body() body: unknown, @Headers('idempotency-key') operationId: string | undefined, @Ctx() ctx: TenantContext): Promise<{ data: StockAdjustmentResponse }> {
    const parsed = adjustStockRequestSchema.safeParse(body);
    if (!parsed.success || operationId === undefined || operationId.length !== 26) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid stock adjustment request');
    return { data: await this.inventory.adjustStock({ ctx, operationId, ...parsed.data, source: 'API' }) };
  }

  @Get('openings/:id')
  async openingDetail(@Param('id') id: string, @Ctx() ctx: TenantContext): Promise<{ data: OpeningStockResponse }> {
    if (id.length !== 26) throw new AppError(ErrorCode.NOT_FOUND, 'Opening stock not found');
    return { data: await this.inventory.opening(ctx, id) };
  }

  @Post('openings') @HttpCode(201)
  async opening(@Body() body: unknown, @Headers('idempotency-key') operationId: string | undefined, @Ctx() ctx: TenantContext): Promise<{ data: OpeningStockResponse }> {
    const parsed = recordOpeningStockRequestSchema.safeParse(body);
    if (!parsed.success || operationId === undefined || operationId.length !== 26) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid opening stock request');
    return { data: await this.inventory.recordOpening({ ctx, operationId, ...parsed.data, source: 'API' }) };
  }

  /**
   * Cancelling a stock change (Phase 9.2). The goods go back exactly where they
   * were and the document stays, marked cancelled with its reason.
   */
  @Post('adjustments/:id/void')
  async voidAdjustment(
    @Param('id') id: string,
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: { ok: true } }> {
    const parsed = voidDocumentRequestSchema.safeParse(body);
    if (!parsed.success || id.length !== 26) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'A cancellation needs the document version and a reason');
    }
    await this.inventory.voidAdjustment({ ctx, adjustmentId: id, ...parsed.data });
    return { data: { ok: true } };
  }
}
