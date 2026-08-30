import { Module } from '@nestjs/common';
import type {
  AccessControl, AuditWriter, DaybookRepository, MoneyRepository, PeriodGuard, UnitOfWork,
} from '@sher/core-application';
import {
  GetDaybookService, MarkDayReviewedService, PrintDaybookService,
} from '@sher/core-application';
import type { Clock } from '@sher/shared-utils';

import {
  ACCESS_CONTROL, AUDIT_WRITER, CLOCK, DAYBOOK_REPOSITORY, MONEY_REPOSITORY, PERIOD_GUARD,
  UNIT_OF_WORK,
} from '../infrastructure/tokens';
import { DaybookController } from './daybook.controller';
import { GET_DAYBOOK_SERVICE, MARK_DAY_REVIEWED_SERVICE, PRINT_DAYBOOK_SERVICE } from './tokens';

/**
 * The daybook module (§5.27, D-27).
 *
 * It is given the money repository so the day's cash summary is the **same**
 * session rows Daily Cash shows, and the period guard so a row inside a closed
 * month is drawn read-only (DR5). It is given no numbering service, no outbox
 * and no idempotency store, because it creates no business document — the two
 * things it does write, a review mark and a print record, are facts about the
 * reviewer and the paper, not about the shop's money.
 */
@Module({
  controllers: [DaybookController],
  providers: [
    {
      provide: GET_DAYBOOK_SERVICE,
      useFactory: (
        uow: UnitOfWork,
        access: AccessControl,
        daybook: DaybookRepository,
        money: MoneyRepository,
        periods: PeriodGuard,
      ) => new GetDaybookService(uow, access, daybook, money, periods),
      inject: [UNIT_OF_WORK, ACCESS_CONTROL, DAYBOOK_REPOSITORY, MONEY_REPOSITORY, PERIOD_GUARD],
    },
    {
      provide: MARK_DAY_REVIEWED_SERVICE,
      useFactory: (
        uow: UnitOfWork,
        access: AccessControl,
        daybook: DaybookRepository,
        audit: AuditWriter,
        clock: Clock,
      ) => new MarkDayReviewedService(uow, access, daybook, audit, clock),
      inject: [UNIT_OF_WORK, ACCESS_CONTROL, DAYBOOK_REPOSITORY, AUDIT_WRITER, CLOCK],
    },
    {
      provide: PRINT_DAYBOOK_SERVICE,
      useFactory: (
        uow: UnitOfWork,
        access: AccessControl,
        daybook: DaybookRepository,
        reader: GetDaybookService,
        audit: AuditWriter,
        clock: Clock,
      ) => new PrintDaybookService(uow, access, daybook, reader, audit, clock),
      inject: [
        UNIT_OF_WORK, ACCESS_CONTROL, DAYBOOK_REPOSITORY, GET_DAYBOOK_SERVICE, AUDIT_WRITER, CLOCK,
      ],
    },
  ],
})
export class DaybookModule {}
