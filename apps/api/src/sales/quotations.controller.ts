import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import type { QuotationService, TenantContext } from '@sher/core-application';
import type { QuotationResponse } from '@sher/core-contracts';
import { AppError, createQuotationRequestSchema, ErrorCode } from '@sher/core-contracts';

import { Ctx, TenantContextGuard } from '../auth/tenant-context.guard';
import { QUOTATION_SERVICE } from './tokens';

/** §5.7's wholesale drafts. They reserve nothing and post nothing. */
@Controller('api/v1/quotations')
@UseGuards(TenantContextGuard)
export class QuotationsController {
  constructor(@Inject(QUOTATION_SERVICE) private readonly quotations: QuotationService) {}

  @Get()
  async list(
    @Query('kind') kind: string | undefined,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: readonly QuotationResponse[] }> {
    return { data: await this.quotations.list(ctx, kindOf(kind), 50) };
  }

  @Get(':id')
  async detail(
    @Param('id') id: string,
    @Query('kind') kind: string | undefined,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: QuotationResponse }> {
    if (id.length !== 26) throw new AppError(ErrorCode.NOT_FOUND, 'Not found');
    return { data: await this.quotations.detail(ctx, kindOf(kind), id) };
  }

  @Post()
  @HttpCode(201)
  async create(
    @Body() body: unknown,
    @Headers('idempotency-key') operationId: string | undefined,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: QuotationResponse }> {
    const parsed = createQuotationRequestSchema.safeParse(body);
    if (!parsed.success || operationId === undefined || operationId.length !== 26) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid quotation request');
    }
    return { data: await this.quotations.create({ ctx, operationId, ...parsed.data }) };
  }
}

function kindOf(kind: string | undefined): 'QUOTATION' | 'ORDER' {
  return kind === 'ORDER' ? 'ORDER' : 'QUOTATION';
}
