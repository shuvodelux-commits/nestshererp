import { Module } from '@nestjs/common';
import type {
  AccessControl, AuditWriter, ReportRepository, TenantRepository, UnitOfWork,
} from '@sher/core-application';
import { DashboardService, ProfitTargetService, ReportQueryService } from '@sher/core-application';
import type { Clock } from '@sher/shared-utils';

import {
  ACCESS_CONTROL, AUDIT_WRITER, CLOCK, REPORT_REPOSITORY, TENANT_REPOSITORY, UNIT_OF_WORK,
} from '../infrastructure/tokens';
import { ReportsController } from './reports.controller';
import { TargetsController } from './targets.controller';
import { DASHBOARD_SERVICE, PROFIT_TARGET_SERVICE, REPORT_QUERY_SERVICE } from './tokens';

/**
 * The reporting module (§5.20).
 *
 * The three services are wired without a period guard, a numbering service, an
 * outbox or an idempotency store, because none of them posts a business
 * document — the target is master data and everything else is a read. What a
 * module is *given* is the clearest statement of what it is allowed to do.
 */
@Module({
  controllers: [ReportsController, TargetsController],
  providers: [
    {
      provide: REPORT_QUERY_SERVICE,
      useFactory: (uow: UnitOfWork, access: AccessControl, reports: ReportRepository) =>
        new ReportQueryService(uow, access, reports),
      inject: [UNIT_OF_WORK, ACCESS_CONTROL, REPORT_REPOSITORY],
    },
    {
      provide: PROFIT_TARGET_SERVICE,
      useFactory: (
        uow: UnitOfWork,
        access: AccessControl,
        reports: ReportRepository,
        audit: AuditWriter,
        clock: Clock,
      ) => new ProfitTargetService(uow, access, reports, audit, clock),
      inject: [UNIT_OF_WORK, ACCESS_CONTROL, REPORT_REPOSITORY, AUDIT_WRITER, CLOCK],
    },
    {
      provide: DASHBOARD_SERVICE,
      useFactory: (
        uow: UnitOfWork,
        access: AccessControl,
        reports: ReportRepository,
        tenants: TenantRepository,
        targets: ProfitTargetService,
        clock: Clock,
      ) => new DashboardService(uow, access, reports, tenants, targets, clock),
      inject: [
        UNIT_OF_WORK, ACCESS_CONTROL, REPORT_REPOSITORY, TENANT_REPOSITORY,
        PROFIT_TARGET_SERVICE, CLOCK,
      ],
    },
  ],
})
export class ReportsModule {}
