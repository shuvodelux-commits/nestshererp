import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { PaySupplierService, TenantContext } from '@sher/core-application';
import type { SupplierDueResponse, SupplierPaymentResponse } from '@sher/core-contracts';
import { AppError, ErrorCode, paySupplierRequestSchema } from '@sher/core-contracts';

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
}
