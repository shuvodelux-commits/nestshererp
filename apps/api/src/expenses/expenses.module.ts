import { Module } from '@nestjs/common';
import type {
  AccessControl,
  AuditWriter,
  DocumentReversalRepository,
  ExpenseRepository,
  IdempotencyStore,
  MoneyRepository,
  NumberingService,
  Outbox,
  PartyRepository,
  PeriodGuard,
  UnitOfWork,
} from '@sher/core-application';
import { ManageExpensesService } from '@sher/core-application';
import type { Clock } from '@sher/shared-utils';

import {
  ACCESS_CONTROL,
  AUDIT_WRITER,
  CLOCK,
  DOCUMENT_REVERSAL_REPOSITORY,
  EXPENSE_REPOSITORY,
  IDEMPOTENCY_STORE,
  MONEY_REPOSITORY,
  NUMBERING_SERVICE,
  OUTBOX,
  PARTY_REPOSITORY,
  PERIOD_GUARD,
  UNIT_OF_WORK,
} from '../infrastructure/tokens';
import { ExpensesController } from './expenses.controller';
import { MANAGE_EXPENSES_SERVICE } from './tokens';

/** Phase 7 — what the shop spends (§5.12). */
@Module({
  controllers: [ExpensesController],
  providers: [
    {
      provide: MANAGE_EXPENSES_SERVICE,
      useFactory: (
        uow: UnitOfWork,
        accessControl: AccessControl,
        idempotency: IdempotencyStore,
        periods: PeriodGuard,
        parties: PartyRepository,
        money: MoneyRepository,
        expenses: ExpenseRepository,
        reversals: DocumentReversalRepository,
        numbering: NumberingService,
        audit: AuditWriter,
        outbox: Outbox,
        clock: Clock,
      ): ManageExpensesService =>
        new ManageExpensesService(
          uow,
          accessControl,
          idempotency,
          periods,
          parties,
          money,
          expenses,
          reversals,
          numbering,
          audit,
          outbox,
          clock,
        ),
      inject: [
        UNIT_OF_WORK,
        ACCESS_CONTROL,
        IDEMPOTENCY_STORE,
        PERIOD_GUARD,
        PARTY_REPOSITORY,
        MONEY_REPOSITORY,
        EXPENSE_REPOSITORY,
        DOCUMENT_REVERSAL_REPOSITORY,
        NUMBERING_SERVICE,
        AUDIT_WRITER,
        OUTBOX,
        CLOCK,
      ],
    },
  ],
  exports: [MANAGE_EXPENSES_SERVICE],
})
export class ExpensesModule {}
