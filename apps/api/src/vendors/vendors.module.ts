import { Module } from '@nestjs/common';
import type {
  AccessControl,
  AuditWriter,
  CreateSaleService,
  IdempotencyStore,
  InventoryRepository,
  MoneyRepository,
  NumberingService,
  Outbox,
  PartyRepository,
  PeriodGuard,
  ProductRepository,
  ReceiveCustomerPaymentService,
  SettingsRepository,
  UnitOfWork,
  VendorStockRepository,
  VendorWorkspaceRepository,
} from '@sher/core-application';
import {
  VendorIssueService,
  VendorMoneyService,
  VendorStockService,
  VendorWorkspaceService,
} from '@sher/core-application';
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
  PARTY_REPOSITORY,
  PERIOD_GUARD,
  PRODUCT_REPOSITORY,
  SETTINGS_REPOSITORY,
  UNIT_OF_WORK,
  VENDOR_STOCK_REPOSITORY,
  VENDOR_WORKSPACE_REPOSITORY,
} from '../infrastructure/tokens';
import { CREATE_SALE_SERVICE, RECEIVE_CUSTOMER_PAYMENT_SERVICE } from '../sales/tokens';
import { SalesModule } from '../sales/sales.module';
import { VendorStockController } from './vendors.controller';
import { VendorWorkspaceController } from './vendor-workspace.controller';
import {
  VENDOR_ISSUE_SERVICE,
  VENDOR_MONEY_SERVICE,
  VENDOR_STOCK_SERVICE,
  VENDOR_WORKSPACE_SERVICE,
} from './tokens';

/**
 * Phase 8 — stock the shop holds but does not own (§5.6 M07, DR13.10) — and
 * Phase 8.3, the vendor's own hub over it.
 *
 * `SalesModule` is imported for the same reason `PartiesModule` is imported
 * there: charging goods to a vendor is a **sale** and settling what they owe is
 * a **customer receipt**, so both go through the services that already own
 * those postings. There is one sale writer and one receipt writer in this
 * application, and the workspace is a caller of them (A11, A14, R-D).
 */
@Module({
  imports: [SalesModule],
  controllers: [VendorStockController, VendorWorkspaceController],
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
    {
      provide: VENDOR_WORKSPACE_SERVICE,
      useFactory: (
        uow: UnitOfWork,
        accessControl: AccessControl,
        workspace: VendorWorkspaceRepository,
        vendorStock: VendorStockRepository,
        parties: PartyRepository,
      ): VendorWorkspaceService =>
        new VendorWorkspaceService(uow, accessControl, workspace, vendorStock, parties),
      inject: [
        UNIT_OF_WORK,
        ACCESS_CONTROL,
        VENDOR_WORKSPACE_REPOSITORY,
        VENDOR_STOCK_REPOSITORY,
        PARTY_REPOSITORY,
      ],
    },
    {
      provide: VENDOR_MONEY_SERVICE,
      useFactory: (
        uow: UnitOfWork,
        accessControl: AccessControl,
        idempotency: IdempotencyStore,
        periods: PeriodGuard,
        workspace: VendorWorkspaceRepository,
        parties: PartyRepository,
        money: MoneyRepository,
        customerPayments: ReceiveCustomerPaymentService,
        numbering: NumberingService,
        audit: AuditWriter,
        outbox: Outbox,
        clock: Clock,
      ): VendorMoneyService =>
        new VendorMoneyService(
          uow,
          accessControl,
          idempotency,
          periods,
          workspace,
          parties,
          money,
          customerPayments,
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
        VENDOR_WORKSPACE_REPOSITORY,
        PARTY_REPOSITORY,
        MONEY_REPOSITORY,
        RECEIVE_CUSTOMER_PAYMENT_SERVICE,
        NUMBERING_SERVICE,
        AUDIT_WRITER,
        OUTBOX,
        CLOCK,
      ],
    },
    {
      provide: VENDOR_ISSUE_SERVICE,
      useFactory: (
        uow: UnitOfWork,
        accessControl: AccessControl,
        idempotency: IdempotencyStore,
        periods: PeriodGuard,
        workspace: VendorWorkspaceRepository,
        parties: PartyRepository,
        products: ProductRepository,
        inventory: InventoryRepository,
        settings: SettingsRepository,
        sales: CreateSaleService,
        numbering: NumberingService,
        audit: AuditWriter,
        outbox: Outbox,
        clock: Clock,
      ): VendorIssueService =>
        new VendorIssueService(
          uow,
          accessControl,
          idempotency,
          periods,
          workspace,
          parties,
          products,
          inventory,
          settings,
          sales,
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
        VENDOR_WORKSPACE_REPOSITORY,
        PARTY_REPOSITORY,
        PRODUCT_REPOSITORY,
        INVENTORY_REPOSITORY,
        SETTINGS_REPOSITORY,
        CREATE_SALE_SERVICE,
        NUMBERING_SERVICE,
        AUDIT_WRITER,
        OUTBOX,
        CLOCK,
      ],
    },
  ],
})
export class VendorsModule {}
