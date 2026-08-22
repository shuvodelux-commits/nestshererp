import { Body, Controller, Headers, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import type { ImportPreviewResponse, ImportResultResponse } from '@sher/core-contracts';
import { AppError, ErrorCode, importRequestSchema } from '@sher/core-contracts';
import type { ImportDataService, TenantContext } from '@sher/core-application';

import { Ctx, TenantContextGuard } from '../auth/tenant-context.guard';
import { IMPORT_DATA_SERVICE } from './tokens';

/**
 * The guided onboarding import (§5.6).
 *
 * `preview` is a POST because the file travels in the body, not because it
 * writes: it creates nothing and is the step §5.6 requires before posting.
 */
@Controller('api/v1/imports')
@UseGuards(TenantContextGuard)
export class ImportsController {
  constructor(@Inject(IMPORT_DATA_SERVICE) private readonly imports: ImportDataService) {}

  @Post('preview')
  @HttpCode(200)
  async preview(
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: ImportPreviewResponse }> {
    const parsed = importRequestSchema.safeParse(body);
    if (!parsed.success) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid import request');
    return { data: await this.imports.preview({ ctx, ...parsed.data }) };
  }

  /** The import operation id is the `Idempotency-Key`, as every other create's is. */
  @Post()
  @HttpCode(201)
  async commit(
    @Body() body: unknown,
    @Headers('idempotency-key') operationId: string | undefined,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: ImportResultResponse }> {
    const parsed = importRequestSchema.safeParse(body);
    if (!parsed.success || operationId === undefined || operationId.length !== 26) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid import request');
    }
    return { data: await this.imports.commit({ ctx, ...parsed.data, operationId }) };
  }
}
