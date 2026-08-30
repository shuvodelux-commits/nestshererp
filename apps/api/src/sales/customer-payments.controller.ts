import {
  Body, Controller, Get, Headers, HttpCode, Inject, Param, Patch, Post, UseGuards,
} from '@nestjs/common';
import type {
  ReceiveCustomerPaymentService,
  SaleQueryService,
  TenantContext,
} from '@sher/core-application';
import type { CustomerReceiptResponse, CustomerStandingResponse } from '@sher/core-contracts';
import {
  AppError, correctCustomerPaymentRequestSchema, ErrorCode,
  receiveCustomerPaymentRequestSchema, voidDocumentRequestSchema,
} from '@sher/core-contracts';

import { Ctx, TenantContextGuard } from '../auth/tenant-context.guard';
import { RECEIVE_CUSTOMER_PAYMENT_SERVICE, SALE_QUERY_SERVICE } from './tokens';

/**
 * Money received from a customer (§5.8), and what they currently owe.
 *
 * One endpoint for both entry points — the customer's hub and one invoice —
 * because they are one use case (owner decision 2026-08-25). Naming invoices in
 * `saleIds` is the only difference between them.
 */
@Controller('api/v1')
@UseGuards(TenantContextGuard)
export class CustomerPaymentsController {
  constructor(
    @Inject(RECEIVE_CUSTOMER_PAYMENT_SERVICE)
    private readonly receipts: ReceiveCustomerPaymentService,
    @Inject(SALE_QUERY_SERVICE) private readonly query: SaleQueryService,
  ) {}

  @Get('customers/:id/standing')
  async standing(
    @Param('id') id: string,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: CustomerStandingResponse }> {
    if (id.length !== 26) throw new AppError(ErrorCode.NOT_FOUND, 'Customer not found');
    return { data: await this.query.customerStanding(ctx, id) };
  }

  @Post('customer-payments')
  @HttpCode(201)
  async receive(
    @Body() body: unknown,
    @Headers('idempotency-key') operationId: string | undefined,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: CustomerReceiptResponse }> {
    const parsed = receiveCustomerPaymentRequestSchema.safeParse(body);
    if (!parsed.success || operationId === undefined || operationId.length !== 26) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid payment request');
    }
    return { data: await this.receipts.receive({ ctx, operationId, ...parsed.data }) };
  }

  /** Correcting a posted receipt (Phase 9.2) — same number, new figures. */
  @Patch('customer-payments/:id')
  async correct(
    @Param('id') id: string,
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: CustomerReceiptResponse }> {
    const parsed = correctCustomerPaymentRequestSchema.safeParse(body);
    if (!parsed.success || id.length !== 26) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid correction');
    }
    return {
      data: await this.receipts.correct({ ctx, receiptId: id, operationId: id, ...parsed.data }),
    };
  }

  /** Cancelling a posted receipt. A reason is required (owner rule). */
  @Post('customer-payments/:id/void')
  async void(
    @Param('id') id: string,
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: CustomerReceiptResponse }> {
    const parsed = voidDocumentRequestSchema.safeParse(body);
    if (!parsed.success || id.length !== 26) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'A cancellation needs the document version and a reason');
    }
    return {
      data: await this.receipts.void({ ctx, receiptId: id, ...parsed.data }),
    };
  }
}

