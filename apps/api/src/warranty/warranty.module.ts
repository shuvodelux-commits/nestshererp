import { Module } from '@nestjs/common';
import type {
  AccessControl,
  AuditWriter,
  ManageInventoryService,
  MoneyRepository,
  NumberingService,
  Outbox,
  PeriodGuard,
  ProductRepository,
  SerialRepository,
  SettingsRepository,
  UnitOfWork,
  WarrantyRepository,
} from '@sher/core-application';
import { SerialService, WarrantyService } from '@sher/core-application';
import type { Clock } from '@sher/shared-utils';

import {
  ACCESS_CONTROL,
  AUDIT_WRITER,
  CLOCK,
  MONEY_REPOSITORY,
  NUMBERING_SERVICE,
  OUTBOX,
  PERIOD_GUARD,
  PRODUCT_REPOSITORY,
  SERIAL_REPOSITORY,
  SETTINGS_REPOSITORY,
  UNIT_OF_WORK,
  WARRANTY_REPOSITORY,
} from '../infrastructure/tokens';
import { InventoryModule } from '../inventory/inventory.module';
import { MANAGE_INVENTORY_SERVICE } from '../inventory/tokens';
import { SerialsController, WarrantyController } from './warranty.controller';
import { SERIAL_SERVICE, WARRANTY_SERVICE } from './tokens';

/**
 * Phase 8 — serial numbers, and the claims that follow them (§5.19).
 *
 * `ManageInventoryService` is injected rather than a stock repository: a
 * warranty replacement leaves through the same use case the Stock Adjustment
 * dialog calls, which is what keeps §5.19's "warranty implements no accounting
 * of its own" literally true.
 */
@Module({
  // Imported for `ManageInventoryService`: a warranty replacement leaves through
  // the ordinary stock path rather than a second one written here.
  imports: [InventoryModule],
  controllers: [SerialsController, WarrantyController],
  providers: [
    {
      provide: SERIAL_SERVICE,
      useFactory: (
        uow: UnitOfWork,
        accessControl: AccessControl,
        serials: SerialRepository,
        settings: SettingsRepository,
        audit: AuditWriter,
        clock: Clock,
      ): SerialService => new SerialService(uow, accessControl, serials, settings, audit, clock),
      inject: [
        UNIT_OF_WORK,
        ACCESS_CONTROL,
        SERIAL_REPOSITORY,
        SETTINGS_REPOSITORY,
        AUDIT_WRITER,
        CLOCK,
      ],
    },
    {
      provide: WARRANTY_SERVICE,
      useFactory: (
        uow: UnitOfWork,
        accessControl: AccessControl,
        periods: PeriodGuard,
        claims: WarrantyRepository,
        serials: SerialRepository,
        products: ProductRepository,
        inventory: ManageInventoryService,
        money: MoneyRepository,
        settings: SettingsRepository,
        numbering: NumberingService,
        audit: AuditWriter,
        outbox: Outbox,
        clock: Clock,
      ): WarrantyService =>
        new WarrantyService(
          uow,
          accessControl,
          periods,
          claims,
          serials,
          products,
          inventory,
          money,
          settings,
          numbering,
          audit,
          outbox,
          clock,
        ),
      inject: [
        UNIT_OF_WORK,
        ACCESS_CONTROL,
        PERIOD_GUARD,
        WARRANTY_REPOSITORY,
        SERIAL_REPOSITORY,
        PRODUCT_REPOSITORY,
        MANAGE_INVENTORY_SERVICE,
        MONEY_REPOSITORY,
        SETTINGS_REPOSITORY,
        NUMBERING_SERVICE,
        AUDIT_WRITER,
        OUTBOX,
        CLOCK,
      ],
    },
  ],
})
export class WarrantyModule {}
