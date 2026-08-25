import { Module } from '@nestjs/common';
import type { AccessControl, AuditWriter, PeriodRepository, UnitOfWork } from '@sher/core-application';
import { ManagePeriodsService } from '@sher/core-application';
import type { Clock } from '@sher/shared-utils';

import {
  ACCESS_CONTROL,
  AUDIT_WRITER,
  CLOCK,
  PERIOD_REPOSITORY,
  UNIT_OF_WORK,
} from '../infrastructure/tokens';
import { PeriodsController } from './periods.controller';
import { MANAGE_PERIODS_SERVICE } from './tokens';

/** Phase 7 — closing the books on a month (§5.19). */
@Module({
  controllers: [PeriodsController],
  providers: [
    {
      provide: MANAGE_PERIODS_SERVICE,
      useFactory: (
        uow: UnitOfWork,
        accessControl: AccessControl,
        periods: PeriodRepository,
        audit: AuditWriter,
        clock: Clock,
      ): ManagePeriodsService => new ManagePeriodsService(uow, accessControl, periods, audit, clock),
      inject: [UNIT_OF_WORK, ACCESS_CONTROL, PERIOD_REPOSITORY, AUDIT_WRITER, CLOCK],
    },
  ],
})
export class PeriodsModule {}
