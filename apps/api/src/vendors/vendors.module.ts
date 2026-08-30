import { Module } from '@nestjs/common';
import type {
  AccessControl,
  AuditWriter,
  IdempotencyStore,
  InventoryRepository,
  NumberingService,
  Outbox,
  PartyRepository,
  PeriodGuard,
  SettingsRepository,
  UnitOfWork,
  VendorStockRepository,
} from '@sher/core-application';
import { VendorStockService } from '@sher/core-application';
import type { Clock } from '@sher/shared-utils';

import {
  ACCESS_CONTROL,
  AUDIT_WRITER,
  CLOCK,
  IDEMPOTENCY_STORE,
  INVENTORY_REPOSITORY,
  NUMBERING_SERVICE,
  OUTBOX,
  PARTY_REPOSITORY,
  PERIOD_GUARD,
  SETTINGS_REPOSITORY,
  UNIT_OF_WORK,
  VENDOR_STOCK_REPOSITORY,
} from '../infrastructure/tokens';
import { VendorStockController } from './vendors.controller';
import { VENDOR_STOCK_SERVICE } from './tokens';

/** Phase 8 — stock the shop holds but does not own (§5.6 M07, DR13.10). */
@Module({
  controllers: [VendorStockController],
  providers: [
    {
      provide: VENDOR_STOCK_SERVICE,
      useFactory: (
        uow: UnitOfWork,
        accessControl: AccessControl,
        idempotency: IdempotencyStore,
        periods: PeriodGuard,
        vendors: VendorStockRepository,
        parties: PartyRepository,
        inventory: InventoryRepository,
        settings: SettingsRepository,
        numbering: NumberingService,
        audit: AuditWriter,
        outbox: Outbox,
        clock: Clock,
      ): VendorStockService =>
        new VendorStockService(
          uow,
          accessControl,
          idempotency,
          periods,
          vendors,
          parties,
          inventory,
          settings,
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
        VENDOR_STOCK_REPOSITORY,
        PARTY_REPOSITORY,
        INVENTORY_REPOSITORY,
        SETTINGS_REPOSITORY,
        NUMBERING_SERVICE,
        AUDIT_WRITER,
        OUTBOX,
        CLOCK,
      ],
    },
  ],
})
export class VendorsModule {}
