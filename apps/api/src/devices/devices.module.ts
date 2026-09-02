import { Module } from '@nestjs/common';
import type {
  AccessControl,
  AuditWriter,
  DeviceRepository,
  ManagePartiesService,
  ManageProductsService,
  PasswordHasher,
  SaleQueryService,
  UnitOfWork,
  UserRepository,
} from '@sher/core-application';
import { ManageDevicesService, OfflineStatusService, SnapshotService } from '@sher/core-application';
import type { Clock } from '@sher/shared-utils';

import { CatalogModule } from '../catalog/catalog.module';
import { MANAGE_PRODUCTS_SERVICE } from '../catalog/tokens';
import {
  ACCESS_CONTROL,
  AUDIT_WRITER,
  CLOCK,
  DEVICE_REPOSITORY,
  PASSWORD_HASHER,
  UNIT_OF_WORK,
  USER_REPOSITORY,
} from '../infrastructure/tokens';
import { PartiesModule } from '../parties/parties.module';
import { SalesModule } from '../sales/sales.module';
import { SALE_QUERY_SERVICE } from '../sales/tokens';
import { MANAGE_PARTIES_SERVICE } from '../parties/tokens';
import { DevicesController } from './devices.controller';
import { MANAGE_DEVICES_SERVICE, OFFLINE_STATUS_SERVICE, SNAPSHOT_SERVICE } from './tokens';

/**
 * Phase 12.1 — the offline foundation (§5.23, D-01, D-24), and Phase 12.3's
 * snapshot on top of it.
 *
 * Two services because there are two authorities: what this browser may say
 * about itself, and what an owner or manager may decide about every machine.
 *
 * The third, `SnapshotService`, owns no data at all — it **imports the product
 * and party list services** and calls exactly what the online screens call, so
 * the copy on the shop's machine cannot drift from the copy on the screen
 * (A11, R-D: one reader per thing read). That is why this module imports
 * `CatalogModule` and `PartiesModule` rather than reaching for their
 * repositories.
 */
@Module({
  // Phase 12.4 adds SalesModule: the snapshot's twelve months of sales are read
  // through the sales screen's own query service, never a second reader (A11).
  imports: [CatalogModule, PartiesModule, SalesModule],
  controllers: [DevicesController],
  providers: [
    {
      provide: OFFLINE_STATUS_SERVICE,
      useFactory: (
        uow: UnitOfWork,
        accessControl: AccessControl,
        devices: DeviceRepository,
        audit: AuditWriter,
        clock: Clock,
      ): OfflineStatusService =>
        new OfflineStatusService(uow, accessControl, devices, audit, clock),
      inject: [UNIT_OF_WORK, ACCESS_CONTROL, DEVICE_REPOSITORY, AUDIT_WRITER, CLOCK],
    },
    {
      provide: MANAGE_DEVICES_SERVICE,
      useFactory: (
        uow: UnitOfWork,
        accessControl: AccessControl,
        devices: DeviceRepository,
        users: UserRepository,
        hasher: PasswordHasher,
        audit: AuditWriter,
        clock: Clock,
      ): ManageDevicesService =>
        new ManageDevicesService(uow, accessControl, devices, users, hasher, audit, clock),
      inject: [
        UNIT_OF_WORK,
        ACCESS_CONTROL,
        DEVICE_REPOSITORY,
        USER_REPOSITORY,
        PASSWORD_HASHER,
        AUDIT_WRITER,
        CLOCK,
      ],
    },
    {
      provide: SNAPSHOT_SERVICE,
      useFactory: (
        uow: UnitOfWork,
        accessControl: AccessControl,
        devices: DeviceRepository,
        products: ManageProductsService,
        parties: ManagePartiesService,
        users: UserRepository,
        sales: SaleQueryService,
        clock: Clock,
      ): SnapshotService =>
        new SnapshotService(uow, accessControl, devices, products, parties, users, sales, clock),
      inject: [
        UNIT_OF_WORK,
        ACCESS_CONTROL,
        DEVICE_REPOSITORY,
        MANAGE_PRODUCTS_SERVICE,
        MANAGE_PARTIES_SERVICE,
        USER_REPOSITORY,
        SALE_QUERY_SERVICE,
        CLOCK,
      ],
    },
  ],
})
export class DevicesModule {}
