import { Module } from '@nestjs/common';
import type {
  AccessControl,
  AuditWriter,
  CatalogRepository,
  IdempotencyStore,
  ManageInventoryService,
  ManagePartiesService,
  ManageProductsService,
  Outbox,
  PartyRepository,
  ProductRepository,
  UnitOfWork,
} from '@sher/core-application';
import { ImportDataService } from '@sher/core-application';
import type { Clock } from '@sher/shared-utils';

import { CatalogModule } from '../catalog/catalog.module';
import { MANAGE_PRODUCTS_SERVICE } from '../catalog/tokens';
import {
  ACCESS_CONTROL,
  AUDIT_WRITER,
  CATALOG_REPOSITORY,
  CLOCK,
  IDEMPOTENCY_STORE,
  OUTBOX,
  PARTY_REPOSITORY,
  PRODUCT_REPOSITORY,
  UNIT_OF_WORK,
} from '../infrastructure/tokens';
import { InventoryModule } from '../inventory/inventory.module';
import { MANAGE_INVENTORY_SERVICE } from '../inventory/tokens';
import { PartiesModule } from '../parties/parties.module';
import { MANAGE_PARTIES_SERVICE } from '../parties/tokens';
import { ImportsController } from './imports.controller';
import { IMPORT_DATA_SERVICE } from './tokens';

/**
 * The importer depends on the modules that own products, parties and stock, and
 * takes their services rather than building its own: one file's rows must reach
 * exactly the use cases the forms reach (A11, A14).
 */
@Module({
  imports: [CatalogModule, PartiesModule, InventoryModule],
  controllers: [ImportsController],
  providers: [
    {
      provide: IMPORT_DATA_SERVICE,
      useFactory: (
        uow: UnitOfWork,
        access: AccessControl,
        idempotency: IdempotencyStore,
        audit: AuditWriter,
        outbox: Outbox,
        clock: Clock,
        catalog: CatalogRepository,
        products: ProductRepository,
        parties: PartyRepository,
        productsService: ManageProductsService,
        partiesService: ManagePartiesService,
        inventoryService: ManageInventoryService,
      ): ImportDataService =>
        new ImportDataService(
          uow,
          access,
          idempotency,
          audit,
          outbox,
          clock,
          catalog,
          products,
          parties,
          productsService,
          partiesService,
          inventoryService,
        ),
      inject: [
        UNIT_OF_WORK,
        ACCESS_CONTROL,
        IDEMPOTENCY_STORE,
        AUDIT_WRITER,
        OUTBOX,
        CLOCK,
        CATALOG_REPOSITORY,
        PRODUCT_REPOSITORY,
        PARTY_REPOSITORY,
        MANAGE_PRODUCTS_SERVICE,
        MANAGE_PARTIES_SERVICE,
        MANAGE_INVENTORY_SERVICE,
      ],
    },
  ],
})
export class ImportsModule {}
