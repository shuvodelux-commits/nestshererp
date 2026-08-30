import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { PaySupplierService, TenantContext } from '@sher/core-application';
import type { SupplierDueResponse, SupplierPaymentResponse } from '@sher/core-contracts';
import {
  AppError, correctSupplierPaymentRequestSchema, ErrorCode, paySupplierRequestSchema,
  voidDocumentRequestSchema,
} from '@sher/core-contracts';

import { Ctx, TenantContextGuard } from '../auth/tenant-context.guard';
import { PAY_SUPPLIER_SERVICE } from './tokens';

/**
 * Paying a supplier (§5.9).
 *
 * One endpoint for both entry points: `Pay Supplier` sends no `purchaseId` and
 * settles the oldest bills first, `Pay this bill` sends one. A second route
 * would be a second way for the same money to move.
 */
@Controller('api/v1/suppliers')
@UseGuards(TenantContextGuard)
export class SupplierPaymentsController {
  constructor(@Inject(PAY_SUPPLIER_SERVICE) private readonly payments: PaySupplierService) {}

  @Get(':id/due')
  async due(
    @Param('id') id: string,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: SupplierDueResponse }> {
    if (id.length !== 26) throw new AppError(ErrorCode.NOT_FOUND, 'Supplier not found');
    return { data: await this.payments.due({ ctx, supplierPartyId: id }) };
  }

  @Post('payments')
  @HttpCode(201)
  async pay(
    @Body() body: unknown,
    @Headers('idempotency-key') operationId: string | undefined,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: SupplierPaymentResponse }> {
    const parsed = paySupplierRequestSchema.safeParse(body);
    if (!parsed.success || operationId === undefined || operationId.length !== 26) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid supplier payment request');
    }
    return { data: await this.payments.pay({ ctx, operationId, ...parsed.data }) };
  }

  /** Correcting a posted payment (Phase 9.2) — same number, new figures. */
  @Patch('payments/:id')
  async correct(
    @Param('id') id: string,
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: { ok: true } }> {
    const parsed = correctSupplierPaymentRequestSchema.safeParse(body);
    if (!parsed.success || id.length !== 26) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid correction');
    }
    await this.payments.correct({ ctx, paymentId: id, operationId: id, ...parsed.data });
    return { data: { ok: true } };
  }

  /** Cancelling a posted payment. A reason is required (owner rule). */
  @Post('payments/:id/void')
  async void(
    @Param('id') id: string,
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: { ok: true } }> {
    const parsed = voidDocumentRequestSchema.safeParse(body);
    if (!parsed.success || id.length !== 26) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'A cancellation needs the document version and a reason');
    }
    await this.payments.void({ ctx, paymentId: id, ...parsed.data });
    return { data: { ok: true } };
  }
}
