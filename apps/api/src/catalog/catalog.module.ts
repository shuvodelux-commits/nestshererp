import { Module } from '@nestjs/common';
import type {
  AccessControl,
  AuditWriter,
  CatalogRepository,
  IdempotencyStore,
  InventoryRepository,
  NumberingService,
  Outbox,
  ProductRepository,
  SettingsRepository,
  UnitOfWork,
} from '@sher/core-application';
import { ManageCatalogService, ManageProductsService } from '@sher/core-application';
import type { Clock } from '@sher/shared-utils';

import {
  ACCESS_CONTROL,
  AUDIT_WRITER,
  CATALOG_REPOSITORY,
  CLOCK,
  IDEMPOTENCY_STORE,
  INVENTORY_REPOSITORY,
  NUMBERING_SERVICE,
  OUTBOX,
  PRODUCT_REPOSITORY,
  SETTINGS_REPOSITORY,
  UNIT_OF_WORK,
} from '../infrastructure/tokens';
import { CatalogController } from './catalog.controller';
import { ProductsController } from './products.controller';
import { MANAGE_CATALOG_SERVICE, MANAGE_PRODUCTS_SERVICE } from './tokens';

@Module({
  controllers: [CatalogController, ProductsController],
  providers: [
    {
      provide: MANAGE_CATALOG_SERVICE,
      useFactory: (
        uow: UnitOfWork,
        accessControl: AccessControl,
        catalog: CatalogRepository,
        products: ProductRepository,
        settings: SettingsRepository,
        audit: AuditWriter,
        outbox: Outbox,
        clock: Clock,
      ): ManageCatalogService =>
        new ManageCatalogService(
          uow,
          accessControl,
          catalog,
          products,
          settings,
          audit,
          outbox,
          clock,
        ),
      inject: [
        UNIT_OF_WORK,
        ACCESS_CONTROL,
        CATALOG_REPOSITORY,
        PRODUCT_REPOSITORY,
        SETTINGS_REPOSITORY,
        AUDIT_WRITER,
        OUTBOX,
        CLOCK,
      ],
    },
    {
      provide: MANAGE_PRODUCTS_SERVICE,
      useFactory: (
        uow: UnitOfWork,
        accessControl: AccessControl,
        products: ProductRepository,
        catalog: CatalogRepository,
        settings: SettingsRepository,
        idempotency: IdempotencyStore,
        numbering: NumberingService,
        audit: AuditWriter,
        outbox: Outbox,
        clock: Clock,
        inventory: InventoryRepository,
      ): ManageProductsService =>
        new ManageProductsService(
          uow,
          accessControl,
          products,
          catalog,
          settings,
          idempotency,
          numbering,
          audit,
          outbox,
          clock,
          inventory,
        ),
      inject: [
        UNIT_OF_WORK,
        ACCESS_CONTROL,
        PRODUCT_REPOSITORY,
        CATALOG_REPOSITORY,
        SETTINGS_REPOSITORY,
        IDEMPOTENCY_STORE,
        NUMBERING_SERVICE,
        AUDIT_WRITER,
        OUTBOX,
        CLOCK,
        INVENTORY_REPOSITORY,
      ],
    },
  ],
  exports: [MANAGE_PRODUCTS_SERVICE],
})
export class CatalogModule {}
