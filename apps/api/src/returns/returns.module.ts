import { Module } from '@nestjs/common';
import type {
  AccessControl,
  AuditWriter,
  IdempotencyStore,
  InventoryRepository,
  MoneyRepository,
  NumberingService,
  Outbox,
  PasswordHasher,
  PeriodGuard,
  SalesReturnRepository,
  UnitOfWork,
} from '@sher/core-application';
import { CreateSalesReturnService, SalesReturnQueryService } from '@sher/core-application';
import type { Clock } from '@sher/shared-utils';

import {
  ACCESS_CONTROL,
  AUDIT_WRITER,
  CLOCK,
  IDEMPOTENCY_STORE,
  INVENTORY_REPOSITORY,
  MONEY_REPOSITORY,
  NUMBERING_SERVICE,
  OUTBOX,
  PASSWORD_HASHER,
  PERIOD_GUARD,
  SALES_RETURN_REPOSITORY,
  UNIT_OF_WORK,
} from '../infrastructure/tokens';
import { SalesReturnsController } from './sales-returns.controller';
import { CREATE_SALES_RETURN_SERVICE, SALES_RETURN_QUERY_SERVICE } from './tokens';

/**
 * Phase 7 — corrections and adjustments, starting with goods coming back.
 *
 * `PASSWORD_HASHER` is here for one reason: a refund over the taker's role
 * limit is unlocked by a senior person's PIN, checked against the same hash
 * their login checks (owner decision 2026-08-26). There is one hasher.
 */
@Module({
  controllers: [SalesReturnsController],
  providers: [
    {
      provide: CREATE_SALES_RETURN_SERVICE,
      useFactory: (
        uow: UnitOfWork,
        accessControl: AccessControl,
        idempotency: IdempotencyStore,
        periods: PeriodGuard,
        inventory: InventoryRepository,
        money: MoneyRepository,
        returns: SalesReturnRepository,
        numbering: NumberingService,
        hasher: PasswordHasher,
        audit: AuditWriter,
        outbox: Outbox,
        clock: Clock,
      ): CreateSalesReturnService =>
        new CreateSalesReturnService(
          uow,
          accessControl,
          idempotency,
          periods,
          inventory,
          money,
          returns,
          numbering,
          hasher,
          audit,
          outbox,
          clock,
        ),
      inject: [
        UNIT_OF_WORK,
        ACCESS_CONTROL,
        IDEMPOTENCY_STORE,
        PERIOD_GUARD,
        INVENTORY_REPOSITORY,
        MONEY_REPOSITORY,
        SALES_RETURN_REPOSITORY,
        NUMBERING_SERVICE,
        PASSWORD_HASHER,
        AUDIT_WRITER,
        OUTBOX,
        CLOCK,
      ],
    },
    {
      provide: SALES_RETURN_QUERY_SERVICE,
      useFactory: (
        uow: UnitOfWork,
        accessControl: AccessControl,
        returns: SalesReturnRepository,
        clock: Clock,
      ): SalesReturnQueryService => new SalesReturnQueryService(uow, accessControl, returns, clock),
      inject: [UNIT_OF_WORK, ACCESS_CONTROL, SALES_RETURN_REPOSITORY, CLOCK],
    },
  ],
})
export class ReturnsModule {}
