import { Module } from '@nestjs/common';
import type {
  AccessControl,
  AuditWriter,
  DocumentRedateRepository,
  DocumentReversalRepository,
  MoneyRepository,
  Outbox,
  PasswordHasher,
  PeriodGuard,
  UnitOfWork,
  UserRepository,
} from '@sher/core-application';
import { ChangeTransactionDateService } from '@sher/core-application';
import type { Clock } from '@sher/shared-utils';

import {
  ACCESS_CONTROL,
  AUDIT_WRITER,
  CLOCK,
  DOCUMENT_REDATE_REPOSITORY,
  DOCUMENT_REVERSAL_REPOSITORY,
  MONEY_REPOSITORY,
  OUTBOX,
  PASSWORD_HASHER,
  PERIOD_GUARD,
  UNIT_OF_WORK,
  USER_REPOSITORY,
} from '../infrastructure/tokens';
import { CorrectionsController } from './corrections.controller';
import { CHANGE_TRANSACTION_DATE_SERVICE } from './tokens';

/**
 * Phase 11.2 — the corrections that belong to no single module.
 *
 * Change Transaction Date is the first of them, and the reason this module
 * exists: the action is offered by Daybook, by four ledgers and by the
 * reconciliation screen, and putting it inside any one of those would have made
 * the other five callers of a module they have nothing to do with (UI-72).
 *
 * The dependency list is the safety statement, as it is for reconciliation next
 * door. There is **no numbering service** — a re-dated document keeps its own
 * number — and no repository that can reach a stock movement or a cost layer.
 * What it can write is the four money vouchers and the journal, through two
 * ports that each know exactly four tables.
 */
@Module({
  controllers: [CorrectionsController],
  providers: [
    {
      provide: CHANGE_TRANSACTION_DATE_SERVICE,
      useFactory: (
        uow: UnitOfWork,
        accessControl: AccessControl,
        periods: PeriodGuard,
        reversals: DocumentReversalRepository,
        redates: DocumentRedateRepository,
        money: MoneyRepository,
        users: UserRepository,
        hasher: PasswordHasher,
        audit: AuditWriter,
        outbox: Outbox,
        clock: Clock,
      ): ChangeTransactionDateService =>
        new ChangeTransactionDateService(
          uow,
          accessControl,
          periods,
          reversals,
          redates,
          money,
          users,
          hasher,
          audit,
          outbox,
          clock,
        ),
      inject: [
        UNIT_OF_WORK,
        ACCESS_CONTROL,
        PERIOD_GUARD,
        DOCUMENT_REVERSAL_REPOSITORY,
        DOCUMENT_REDATE_REPOSITORY,
        MONEY_REPOSITORY,
        USER_REPOSITORY,
        PASSWORD_HASHER,
        AUDIT_WRITER,
        OUTBOX,
        CLOCK,
      ],
    },
  ],
})
export class CorrectionsModule {}
