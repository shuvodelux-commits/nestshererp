import { Module } from '@nestjs/common';
import type {
  AccessControl,
  AuditWriter,
  IdempotencyStore,
  MoneyRepository,
  NumberingService,
  PeriodGuard,
  SettingsRepository,
  UnitOfWork,
} from '@sher/core-application';
import {
  CashMovementService,
  CashSessionService,
  DailyCashService,
  ManageAccountsService,
} from '@sher/core-application';
import type { Clock } from '@sher/shared-utils';

import {
  ACCESS_CONTROL,
  AUDIT_WRITER,
  CLOCK,
  IDEMPOTENCY_STORE,
  MONEY_REPOSITORY,
  NUMBERING_SERVICE,
  PERIOD_GUARD,
  SETTINGS_REPOSITORY,
  UNIT_OF_WORK,
} from '../infrastructure/tokens';
import { AccountsController } from './accounts.controller';
import { CashSessionsController } from './cash-sessions.controller';
import {
  CASH_MOVEMENT_SERVICE,
  CASH_SESSION_SERVICE,
  DAILY_CASH_SERVICE,
  MANAGE_ACCOUNTS_SERVICE,
} from './tokens';

/** Phase 4 — money accounts, the business day, and what moves between them. */
@Module({
  controllers: [CashSessionsController, AccountsController],
  providers: [
    {
      provide: MANAGE_ACCOUNTS_SERVICE,
      useFactory: (
        uow: UnitOfWork,
        accessControl: AccessControl,
        money: MoneyRepository,
        settings: SettingsRepository,
        numbering: NumberingService,
        periods: PeriodGuard,
        idempotency: IdempotencyStore,
        audit: AuditWriter,
        clock: Clock,
      ): ManageAccountsService =>
        new ManageAccountsService(
          uow,
          accessControl,
          money,
          settings,
          numbering,
          periods,
          idempotency,
          audit,
          clock,
        ),
      inject: [
        UNIT_OF_WORK,
        ACCESS_CONTROL,
        MONEY_REPOSITORY,
        SETTINGS_REPOSITORY,
        NUMBERING_SERVICE,
        PERIOD_GUARD,
        IDEMPOTENCY_STORE,
        AUDIT_WRITER,
        CLOCK,
      ],
    },
    {
      provide: CASH_SESSION_SERVICE,
      useFactory: (
        uow: UnitOfWork,
        accessControl: AccessControl,
        money: MoneyRepository,
        settings: SettingsRepository,
        numbering: NumberingService,
        periods: PeriodGuard,
        idempotency: IdempotencyStore,
        audit: AuditWriter,
        clock: Clock,
      ): CashSessionService =>
        new CashSessionService(
          uow,
          accessControl,
          money,
          settings,
          numbering,
          periods,
          idempotency,
          audit,
          clock,
        ),
      inject: [
        UNIT_OF_WORK,
        ACCESS_CONTROL,
        MONEY_REPOSITORY,
        SETTINGS_REPOSITORY,
        NUMBERING_SERVICE,
        PERIOD_GUARD,
        IDEMPOTENCY_STORE,
        AUDIT_WRITER,
        CLOCK,
      ],
    },
    {
      provide: CASH_MOVEMENT_SERVICE,
      useFactory: (
        uow: UnitOfWork,
        accessControl: AccessControl,
        money: MoneyRepository,
        numbering: NumberingService,
        periods: PeriodGuard,
        idempotency: IdempotencyStore,
        audit: AuditWriter,
        clock: Clock,
      ): CashMovementService =>
        new CashMovementService(
          uow,
          accessControl,
          money,
          numbering,
          periods,
          idempotency,
          audit,
          clock,
        ),
      inject: [
        UNIT_OF_WORK,
        ACCESS_CONTROL,
        MONEY_REPOSITORY,
        NUMBERING_SERVICE,
        PERIOD_GUARD,
        IDEMPOTENCY_STORE,
        AUDIT_WRITER,
        CLOCK,
      ],
    },
    {
      provide: DAILY_CASH_SERVICE,
      useFactory: (
        uow: UnitOfWork,
        accessControl: AccessControl,
        money: MoneyRepository,
      ): DailyCashService => new DailyCashService(uow, accessControl, money),
      inject: [UNIT_OF_WORK, ACCESS_CONTROL, MONEY_REPOSITORY],
    },
  ],
  exports: [CASH_SESSION_SERVICE],
})
export class MoneyModule {}
