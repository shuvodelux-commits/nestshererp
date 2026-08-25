import { Module } from '@nestjs/common';
import type { AccessControl, AuditWriter, IdempotencyStore, InventoryRepository, NumberingService, Outbox, PeriodGuard, ProductRepository, SettingsRepository, StockCountRepository, UnitOfWork } from '@sher/core-application';
import { ManageInventoryService, StockCountService } from '@sher/core-application';
import type { Clock } from '@sher/shared-utils';

import { ACCESS_CONTROL, AUDIT_WRITER, CLOCK, IDEMPOTENCY_STORE, INVENTORY_REPOSITORY, NUMBERING_SERVICE, OUTBOX, PERIOD_GUARD, PRODUCT_REPOSITORY, SETTINGS_REPOSITORY, STOCK_COUNT_REPOSITORY, UNIT_OF_WORK } from '../infrastructure/tokens';
import { InventoryController } from './inventory.controller';
import { InventoryLotsController } from './inventory-lots.controller';
import { InventoryValuationController } from './inventory-valuation.controller';
import { StockCountsController } from './stock-counts.controller';
import { MANAGE_INVENTORY_SERVICE, STOCK_COUNT_SERVICE } from './tokens';

@Module({
  controllers: [InventoryController, InventoryLotsController, InventoryValuationController, StockCountsController],
  providers: [{
    provide: MANAGE_INVENTORY_SERVICE,
    useFactory: (uow: UnitOfWork, access: AccessControl, idempotency: IdempotencyStore, periods: PeriodGuard, products: ProductRepository, inventory: InventoryRepository, numbering: NumberingService, audit: AuditWriter, outbox: Outbox, clock: Clock, settings: SettingsRepository) =>
      new ManageInventoryService(uow, access, idempotency, periods, products, inventory, numbering, audit, outbox, clock, settings),
    inject: [UNIT_OF_WORK, ACCESS_CONTROL, IDEMPOTENCY_STORE, PERIOD_GUARD, PRODUCT_REPOSITORY, INVENTORY_REPOSITORY, NUMBERING_SERVICE, AUDIT_WRITER, OUTBOX, CLOCK, SETTINGS_REPOSITORY],
  }, {
    /*
     * The count posts through ManageInventoryService rather than beside it, so
     * a counted difference obeys the costing and lot rules a typed adjustment
     * does — one writer, two entry points (§5.13).
     */
    provide: STOCK_COUNT_SERVICE,
    useFactory: (uow: UnitOfWork, access: AccessControl, idempotency: IdempotencyStore, periods: PeriodGuard, inventory: InventoryRepository, adjustments: ManageInventoryService, counts: StockCountRepository, numbering: NumberingService, audit: AuditWriter, outbox: Outbox, clock: Clock) =>
      new StockCountService(uow, access, idempotency, periods, inventory, adjustments, counts, numbering, audit, outbox, clock),
    inject: [UNIT_OF_WORK, ACCESS_CONTROL, IDEMPOTENCY_STORE, PERIOD_GUARD, INVENTORY_REPOSITORY, MANAGE_INVENTORY_SERVICE, STOCK_COUNT_REPOSITORY, NUMBERING_SERVICE, AUDIT_WRITER, OUTBOX, CLOCK],
  }],
  exports: [MANAGE_INVENTORY_SERVICE],
})
export class InventoryModule {}
