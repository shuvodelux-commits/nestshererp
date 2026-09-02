import { Module } from '@nestjs/common';
import type {
  AccessControl,
  AuditWriter,
  DocumentReversalRepository,
  Outbox,
  IdempotencyStore,
  MoneyRepository,
  NumberingService,
  ReconciliationRepository,
  StatementExtractor,
  PeriodGuard,
  SettingsRepository,
  UnitOfWork,
} from '@sher/core-application';
import {
  CashMovementService,
  CashSessionService,
  DailyCashService,
  ImportStatementService,
  ManageAccountsService,
  MoneyMovementsService,
  ReconcileAccountService,
} from '@sher/core-application';
import type { Clock } from '@sher/shared-utils';

import {
  ACCESS_CONTROL,
  AUDIT_WRITER,
  CLOCK,
  DOCUMENT_REVERSAL_REPOSITORY,
  OUTBOX,
  IDEMPOTENCY_STORE,
  MONEY_REPOSITORY,
  NUMBERING_SERVICE,
  PERIOD_GUARD,
  RECONCILIATION_REPOSITORY,
  SETTINGS_REPOSITORY,
  STATEMENT_EXTRACTOR,
  UNIT_OF_WORK,
} from '../infrastructure/tokens';
import { AccountsController } from './accounts.controller';
import { CashSessionsController } from './cash-sessions.controller';
import { ReconciliationsController } from './reconciliations.controller';
import {
  CASH_MOVEMENT_SERVICE,
  CASH_SESSION_SERVICE,
  DAILY_CASH_SERVICE,
  IMPORT_STATEMENT_SERVICE,
  MANAGE_ACCOUNTS_SERVICE,
  MONEY_MOVEMENTS_SERVICE,
  RECONCILE_ACCOUNT_SERVICE,
} from './tokens';

/** Phase 4 — money accounts, the business day, and what moves between them. */
@Module({
  controllers: [CashSessionsController, AccountsController, ReconciliationsController],
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
        reversals: DocumentReversalRepository,
        outbox: Outbox,
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
          reversals,
          outbox,
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
        DOCUMENT_REVERSAL_REPOSITORY,
        OUTBOX,
        CLOCK,
      ],
    },
    {
      /*
       * Phase 11 (§5.17). Note what is **not** injected: no numbering, no
       * period guard, no posting service of any kind. Reconciliation compares
       * and links; every accounting change is made by the module that owns the
       * document, from the screen. The dependency list is the safety rule.
       */
      provide: RECONCILE_ACCOUNT_SERVICE,
      useFactory: (
        uow: UnitOfWork,
        accessControl: AccessControl,
        reconciliations: ReconciliationRepository,
        idempotency: IdempotencyStore,
        audit: AuditWriter,
        clock: Clock,
      ): ReconcileAccountService =>
        new ReconcileAccountService(uow, accessControl, reconciliations, idempotency, audit, clock),
      inject: [
        UNIT_OF_WORK,
        ACCESS_CONTROL,
        RECONCILIATION_REPOSITORY,
        IDEMPOTENCY_STORE,
        AUDIT_WRITER,
        CLOCK,
      ],
    },
    {
      provide: IMPORT_STATEMENT_SERVICE,
      useFactory: (
        uow: UnitOfWork,
        accessControl: AccessControl,
        reconciliations: ReconciliationRepository,
        extractor: StatementExtractor,
        workspaces: ReconcileAccountService,
        audit: AuditWriter,
        clock: Clock,
      ): ImportStatementService =>
        new ImportStatementService(
          uow,
          accessControl,
          reconciliations,
          extractor,
          workspaces,
          audit,
          clock,
        ),
      inject: [
        UNIT_OF_WORK,
        ACCESS_CONTROL,
        RECONCILIATION_REPOSITORY,
        STATEMENT_EXTRACTOR,
        RECONCILE_ACCOUNT_SERVICE,
        AUDIT_WRITER,
        CLOCK,
      ],
    },
    {
      /*
       * Finance module. Read-only, and the injection list says so: no
       * numbering, no period guard, no idempotency store — nothing it would
       * need to write. The Finance lists cannot become a second way to record
       * a movement, because this service has nothing to record one with.
       */
      provide: MONEY_MOVEMENTS_SERVICE,
      useFactory: (
        uow: UnitOfWork,
        accessControl: AccessControl,
        money: MoneyRepository,
        settings: SettingsRepository,
      ): MoneyMovementsService => new MoneyMovementsService(uow, accessControl, money, settings),
      inject: [UNIT_OF_WORK, ACCESS_CONTROL, MONEY_REPOSITORY, SETTINGS_REPOSITORY],
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
  exports: [CASH_SESSION_SERVICE, CASH_MOVEMENT_SERVICE],
})
export class MoneyModule {}
