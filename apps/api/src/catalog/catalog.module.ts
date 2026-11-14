import { Module } from '@nestjs/common';
import type {
  AccessControl,
  AuditWriter,
  CatalogRepository,
  CatalogMetadataV1Repository,
  CatalogMetadataV1CreationRepository,
  CatalogMetadataV1FullEditRepository,
  IdempotencyStore,
  InventoryRepository,
  NumberingService,
  Outbox,
  ProductRepository,
  SettingsRepository,
  UnitOfWork,
} from '@sher/core-application';
import { CreateCatalogMetadataV1Service, EditCatalogMetadataV1Service, ManageCatalogMetadataV1Service, ManageCatalogService, ManageProductsService } from '@sher/core-application';
import type { Clock } from '@sher/shared-utils';

import {
  ACCESS_CONTROL,
  AUDIT_WRITER,
  CATALOG_REPOSITORY,
  CATALOG_METADATA_V1_REPOSITORY,
  CATALOG_METADATA_V1_CREATION_REPOSITORY,
  CATALOG_METADATA_V1_FULL_EDIT_REPOSITORY,
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
import { CatalogMetadataV1Controller } from './catalog-metadata-v1.controller';
import { ProductsController } from './products.controller';
import { CREATE_CATALOG_METADATA_V1_SERVICE, EDIT_CATALOG_METADATA_V1_SERVICE, MANAGE_CATALOG_METADATA_V1_SERVICE, MANAGE_CATALOG_SERVICE, MANAGE_PRODUCTS_SERVICE } from './tokens';

@Module({
  controllers: [CatalogController, CatalogMetadataV1Controller, ProductsController],
  providers: [
    {
      provide: CREATE_CATALOG_METADATA_V1_SERVICE,
      useFactory: (
        uow: UnitOfWork,
        accessControl: AccessControl,
        catalog: CatalogMetadataV1Repository,
        creation: CatalogMetadataV1CreationRepository,
        settings: SettingsRepository,
        audit: AuditWriter,
        outbox: Outbox,
        clock: Clock,
      ): CreateCatalogMetadataV1Service =>
        new CreateCatalogMetadataV1Service(
          uow, accessControl, catalog, creation, settings, audit, outbox, clock,
        ),
      inject: [
        UNIT_OF_WORK,
        ACCESS_CONTROL,
        CATALOG_METADATA_V1_REPOSITORY,
        CATALOG_METADATA_V1_CREATION_REPOSITORY,
        SETTINGS_REPOSITORY,
        AUDIT_WRITER,
        OUTBOX,
        CLOCK,
      ],
    },
    {
      provide: EDIT_CATALOG_METADATA_V1_SERVICE,
      useFactory: (
        uow: UnitOfWork,
        accessControl: AccessControl,
        catalog: CatalogMetadataV1Repository,
        fullEdit: CatalogMetadataV1FullEditRepository,
        settings: SettingsRepository,
        audit: AuditWriter,
        outbox: Outbox,
      ): EditCatalogMetadataV1Service =>
        new EditCatalogMetadataV1Service(uow, accessControl, catalog, fullEdit, settings, audit, outbox),
      inject: [
        UNIT_OF_WORK,
        ACCESS_CONTROL,
        CATALOG_METADATA_V1_REPOSITORY,
        CATALOG_METADATA_V1_FULL_EDIT_REPOSITORY,
        SETTINGS_REPOSITORY,
        AUDIT_WRITER,
        OUTBOX,
      ],
    },
    {
      provide: MANAGE_CATALOG_METADATA_V1_SERVICE,
      useFactory: (
        uow: UnitOfWork,
        accessControl: AccessControl,
        catalog: CatalogMetadataV1Repository,
        settings: SettingsRepository,
        audit: AuditWriter,
        outbox: Outbox,
      ): ManageCatalogMetadataV1Service =>
        new ManageCatalogMetadataV1Service(uow, accessControl, catalog, settings, audit, outbox),
      inject: [
        UNIT_OF_WORK,
        ACCESS_CONTROL,
        CATALOG_METADATA_V1_REPOSITORY,
        SETTINGS_REPOSITORY,
        AUDIT_WRITER,
        OUTBOX,
      ],
    },
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
