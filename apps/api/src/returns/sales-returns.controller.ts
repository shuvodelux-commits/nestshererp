import {
  Body, Controller, Get, Headers, Inject, Param, Post, Query, UseGuards,
} from '@nestjs/common';
import type { CreateSalesReturnService, SalesReturnQueryService, TenantContext } from '@sher/core-application';
import type {
  ReturnableInvoiceResponse,
  SalesReturnListResponse,
  SalesReturnResponse,
} from '@sher/core-contracts';
import {
  AppError, createSalesReturnRequestSchema, ErrorCode, voidDocumentRequestSchema,
} from '@sher/core-contracts';

import { Ctx, TenantContextGuard } from '../auth/tenant-context.guard';
import { CREATE_SALES_RETURN_SERVICE, SALES_RETURN_QUERY_SERVICE } from './tokens';

/**
 * Customer returns (§5.11). Validate shape → build command → call use case →
 * map result (R-B5). Whether the goods may come back, what they are worth, how
 * much cash may leave the drawer and whose PIN can lift that limit are all
 * decided in the use case, never here.
 */
@Controller('api/v1/sales-returns')
@UseGuards(TenantContextGuard)
export class SalesReturnsController {
  constructor(
    @Inject(CREATE_SALES_RETURN_SERVICE) private readonly returns: CreateSalesReturnService,
    @Inject(SALES_RETURN_QUERY_SERVICE) private readonly query: SalesReturnQueryService,
  ) {}

  /**
   * What this invoice will still take back, and what the caller may refund.
   *
   * The modal asks once and computes everything else in the browser from the
   * answer, running the same domain function the posting service runs.
   */
  @Get('returnable/:saleId')
  async returnable(
    @Param('saleId') saleId: string,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: ReturnableInvoiceResponse }> {
    return { data: await this.query.returnable(ctx, saleId) };
  }

  @Get()
  async list(
    @Query() query: Record<string, string | undefined>,
    @Ctx() ctx: TenantContext,
  ): Promise<SalesReturnListResponse> {
    const limit = Number(query['limit'] ?? '20');
    return this.query.list(ctx, {
      search: query['search'] ?? null,
      partyId: query['partyId'] ?? null,
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
  ): Promise<{ data: SalesReturnResponse }> {
    const parsed = createSalesReturnRequestSchema.safeParse(body);
    if (!parsed.success) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid return');
    if (operationId === undefined || operationId.length !== 26) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'A return needs an operation id');
    }

    const request = parsed.data;
    return {
      data: await this.returns.create({
        ctx,
        operationId,
        saleId: request.saleId,
        lines: request.lines.map((line) => ({
          saleLineId: line.sourceLineId,
          qty: line.qty,
          serialUnitIds: line.serialUnitIds,
        })),
        reason: request.reason,
        note: request.note,
        refundMinor: request.refundMinor,
        refundAccountCode: request.refundAccountCode,
        approvalPin: request.approvalPin,
        customerName: request.customerName,
        customerPhone: request.customerPhone,
        customerAddress: request.customerAddress,
        customerGuardianName: request.customerGuardianName,
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
