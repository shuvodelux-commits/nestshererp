import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import type { GlobalSearchService, TenantContext } from '@sher/core-application';
import type { GlobalSearchResponse } from '@sher/core-contracts';
import { AppError, ErrorCode, globalSearchQuerySchema } from '@sher/core-contracts';

import { Ctx, TenantContextGuard } from '../auth/tenant-context.guard';
import { GLOBAL_SEARCH_SERVICE } from './tokens';

/**
 * Global Search (Phase 18.1).
 *
 * One route, because the box is one box. Parse → call → return (R-B5); which
 * groups come back is the use case's decision, taken from the caller's own
 * permissions, and a caller who may read nothing searchable gets an empty
 * `groups` rather than a refusal — an empty palette is a true answer.
 */
@Controller('api/v1/search')
@UseGuards(TenantContextGuard)
export class SearchController {
  constructor(@Inject(GLOBAL_SEARCH_SERVICE) private readonly search: GlobalSearchService) {}

  @Get()
  async find(@Query() query: unknown, @Ctx() ctx: TenantContext): Promise<GlobalSearchResponse> {
    const parsed = globalSearchQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid search request', {
        issues: parsed.error.issues.map((issue) => issue.path.join('.')).join(', '),
      });
    }

    return { data: await this.search.search({ ctx, ...parsed.data }) };
  }
}
