import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import type { ListAuditEventsService, TenantContext } from '@sher/core-application';
import type { AuditListResponse } from '@sher/core-contracts';
import { AppError, auditQuerySchema, ErrorCode } from '@sher/core-contracts';

import { Ctx, TenantContextGuard } from '../auth/tenant-context.guard';
import { LIST_AUDIT_EVENTS_SERVICE } from './tokens';

/**
 * The audit trail (slice 1.6, §5.22). Read-only — there is no POST, PATCH or
 * DELETE here and there never will be: the table is append-only (R-C7) and
 * "audit logging cannot be disabled by configuration" (§5.26).
 */
@Controller('api/v1/audit-events')
@UseGuards(TenantContextGuard)
export class AuditController {
  constructor(
    @Inject(LIST_AUDIT_EVENTS_SERVICE) private readonly events: ListAuditEventsService,
  ) {}

  @Get()
  async list(
    @Query() query: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: AuditListResponse }> {
    const parsed = auditQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid filter', {
        issues: parsed.error.issues.map((issue) => issue.path.join('.')).join(', '),
      });
    }
    return { data: await this.events.list({ ctx, ...parsed.data }) };
  }
}
