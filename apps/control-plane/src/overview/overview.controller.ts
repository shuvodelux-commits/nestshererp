import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';

import type { AuditService } from '../audit/audit.service';
import { OperatorGuard, RequirePermission } from '../operators/operator.guard';
import type { OverviewService } from './overview.service';
import { AUDIT_SERVICE, OVERVIEW_SERVICE } from '../tokens';

@Controller('api/control')
@UseGuards(OperatorGuard)
export class OverviewController {
  constructor(
    @Inject(OVERVIEW_SERVICE) private readonly overview: OverviewService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
  ) {}

  @Get('overview')
  @RequirePermission('installation.view')
  async summary(): Promise<unknown> {
    return this.overview.summary();
  }

  @Get('audit')
  @RequirePermission('audit.view')
  async auditLog(
    @Query('tenantId') tenantId?: string,
    @Query('operatorId') operatorId?: string,
    @Query('action') action?: string,
  ): Promise<unknown> {
    return {
      events: await this.audit.list({
        ...(tenantId === undefined ? {} : { tenantId }),
        ...(operatorId === undefined ? {} : { operatorId }),
        ...(action === undefined ? {} : { action }),
        limit: 200,
      }),
    };
  }
}
