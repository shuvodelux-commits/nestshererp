import { Module } from '@nestjs/common';
import type {
  AccessControl,
  AuditWriter,
  IdempotencyStore,
  InventoryRepository,
  ManagePartiesService,
  MoneyRepository,
  PartyRepository,
  NumberingService,
  Outbox,
  PasswordHasher,
  PeriodGuard,
  PurchaseReturnRepository,
  SalesReturnRepository,
  UnitOfWork,
} from '@sher/core-application';
import {
  CreatePurchaseReturnService,
  CreateSalesReturnService,
  PurchaseReturnQueryService,
  SalesReturnQueryService,
} from '@sher/core-application';
import type { Clock } from '@sher/shared-utils';

import { PartiesModule } from '../parties/parties.module';
import { MANAGE_PARTIES_SERVICE } from '../parties/tokens';
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
  PARTY_REPOSITORY,
  PERIOD_GUARD,
  PURCHASE_RETURN_REPOSITORY,
  SALES_RETURN_REPOSITORY,
  UNIT_OF_WORK,
} from '../infrastructure/tokens';
import { PurchaseReturnsController } from './purchase-returns.controller';
import { SalesReturnsController } from './sales-returns.controller';
import {
  CREATE_PURCHASE_RETURN_SERVICE,
  CREATE_SALES_RETURN_SERVICE,
  PURCHASE_RETURN_QUERY_SERVICE,
  SALES_RETURN_QUERY_SERVICE,
} from './tokens';

/**
 * Phase 7 — corrections and adjustments, starting with goods coming back.
 *
 * `PASSWORD_HASHER` is here for one reason: a refund over the taker's role
 * limit is unlocked by a senior person's PIN, checked against the same hash
 * their login checks (owner decision 2026-08-26). There is one hasher.
 */
@Module({
  /*
   * Imported for one reason: a return that leaves credit on a guest sale
   * creates the customer through the **same** service the party form calls,
   * inside the return's own transaction (§5.8). There is one party writer.
   */
  imports: [PartiesModule],
  controllers: [SalesReturnsController, PurchaseReturnsController],
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
        parties: PartyRepository,
        partyService: ManagePartiesService,
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
          parties,
          partyService,
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
        PARTY_REPOSITORY,
        MANAGE_PARTIES_SERVICE,
        SALES_RETURN_REPOSITORY,
        NUMBERING_SERVICE,
        PASSWORD_HASHER,
        AUDIT_WRITER,
        OUTBOX,
        CLOCK,
      ],
    },
    {
      provide: CREATE_PURCHASE_RETURN_SERVICE,
      useFactory: (
        uow: UnitOfWork,
        accessControl: AccessControl,
        idempotency: IdempotencyStore,
        periods: PeriodGuard,
        inventory: InventoryRepository,
        money: MoneyRepository,
        returns: PurchaseReturnRepository,
        numbering: NumberingService,
        audit: AuditWriter,
        outbox: Outbox,
        clock: Clock,
      ): CreatePurchaseReturnService =>
        new CreatePurchaseReturnService(
          uow,
          accessControl,
          idempotency,
          periods,
          inventory,
          money,
          returns,
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
        INVENTORY_REPOSITORY,
        MONEY_REPOSITORY,
        PURCHASE_RETURN_REPOSITORY,
        NUMBERING_SERVICE,
        AUDIT_WRITER,
        OUTBOX,
        CLOCK,
      ],
    },
    {
      provide: PURCHASE_RETURN_QUERY_SERVICE,
      useFactory: (
        uow: UnitOfWork,
        accessControl: AccessControl,
        returns: PurchaseReturnRepository,
      ): PurchaseReturnQueryService => new PurchaseReturnQueryService(uow, accessControl, returns),
      inject: [UNIT_OF_WORK, ACCESS_CONTROL, PURCHASE_RETURN_REPOSITORY],
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
  // Phase 12.4: a return queued during an outage replays through the same
  // service the counter calls — the only thing that knows how to unwind a
  // sale's COGS through the lots it consumed.
  exports: [CREATE_SALES_RETURN_SERVICE, CREATE_PURCHASE_RETURN_SERVICE],
})
export class ReturnsModule {}
