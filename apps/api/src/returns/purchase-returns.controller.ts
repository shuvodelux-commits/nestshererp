import {
  Body, Controller, Get, Headers, Inject, Param, Post, Query, UseGuards,
} from '@nestjs/common';
import type {
  CreatePurchaseReturnService,
  PurchaseReturnQueryService,
  TenantContext,
} from '@sher/core-application';
import type {
  PurchaseReturnListResponse,
  PurchaseReturnResponse,
  ReturnableBillResponse,
} from '@sher/core-contracts';
import {
  AppError, createPurchaseReturnRequestSchema, ErrorCode, voidDocumentRequestSchema,
} from '@sher/core-contracts';

import { Ctx, TenantContextGuard } from '../auth/tenant-context.guard';
import { CREATE_PURCHASE_RETURN_SERVICE, PURCHASE_RETURN_QUERY_SERVICE } from './tokens';

/**
 * Supplier returns (§5.11). Validate shape → build command → call use case →
 * map result (R-B5). Whether the goods are still on the shelf, what the
 * supplier credits and what the shop swallows in transport are all decided in
 * the use case.
 */
@Controller('api/v1/purchase-returns')
@UseGuards(TenantContextGuard)
export class PurchaseReturnsController {
  constructor(
    @Inject(CREATE_PURCHASE_RETURN_SERVICE) private readonly returns: CreatePurchaseReturnService,
    @Inject(PURCHASE_RETURN_QUERY_SERVICE) private readonly query: PurchaseReturnQueryService,
  ) {}

  @Get('returnable/:purchaseId')
  async returnable(
    @Param('purchaseId') purchaseId: string,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: ReturnableBillResponse }> {
    return { data: await this.query.returnable(ctx, purchaseId) };
  }

  @Get()
  async list(
    @Query() query: Record<string, string | undefined>,
    @Ctx() ctx: TenantContext,
  ): Promise<PurchaseReturnListResponse> {
    const limit = Number(query['limit'] ?? '20');
    return this.query.list(ctx, {
      search: query['search'] ?? null,
      supplierPartyId: query['supplierPartyId'] ?? null,
      fromDate: query['fromDate'] ?? null,
      toDate: query['toDate'] ?? null,
      cursor: query['cursor'] ?? null,
      limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 100) : 20,
    });
  }

  @Post()
  async create(
    @Body() body: unknown,
    @Headers('idempotency-key') operationId: string | undefined,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: PurchaseReturnResponse }> {
    const parsed = createPurchaseReturnRequestSchema.safeParse(body);
    if (!parsed.success) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid return');
    if (operationId === undefined || operationId.length !== 26) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'A return needs an operation id');
    }

    const request = parsed.data;
    return {
      data: await this.returns.create({
        ctx,
        operationId,
        purchaseId: request.purchaseId,
        lines: request.lines.map((line) => ({
          purchaseLineId: line.sourceLineId,
          qty: line.qty,
        })),
        reason: request.reason,
        note: request.note,
        receivedMinor: request.receivedMinor,
        receiptAccountCode: request.receiptAccountCode,
        businessDate: request.businessDate,
        backdateReason: request.backdateReason,
      }),
    };
  }

  /**
   * Cancelling a posted return (Phase 9.2). The goods move back, the money
   * moves back, and the document stays — marked cancelled, with its reason.
   */
  @Post(':id/void')
  async void(
    @Param('id') id: string,
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: { ok: true } }> {
    const parsed = voidDocumentRequestSchema.safeParse(body);
    if (!parsed.success || id.length !== 26) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'A cancellation needs the document version and a reason');
    }
    await this.returns.void({ ctx, returnId: id, ...parsed.data });
    return { data: { ok: true } };
  }
}
