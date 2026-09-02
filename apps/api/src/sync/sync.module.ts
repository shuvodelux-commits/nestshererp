import { Module } from '@nestjs/common';
import type {
  AccessControl,
  AuditWriter,
  CashMovementService,
  CashSessionService,
  CreatePurchaseReturnService,
  CreatePurchaseService,
  CreateSaleService,
  CreateSalesReturnService,
  DeviceRepository,
  ManageExpensesService,
  ManageInventoryService,
  ManagePartiesService,
  ManageProductsService,
  PaySupplierService,
  ReceiveCustomerPaymentService,
  SyncRepository,
  SyncServices,
  UnitOfWork,
} from '@sher/core-application';
import { ReplayService, ResolveConflictService, SyncReadService } from '@sher/core-application';
import type { Clock } from '@sher/shared-utils';

import { CatalogModule } from '../catalog/catalog.module';
import { MANAGE_PRODUCTS_SERVICE } from '../catalog/tokens';
import { ExpensesModule } from '../expenses/expenses.module';
import { MANAGE_EXPENSES_SERVICE } from '../expenses/tokens';
import {
  ACCESS_CONTROL,
  AUDIT_WRITER,
  CLOCK,
  DEVICE_REPOSITORY,
  SYNC_REPOSITORY,
  UNIT_OF_WORK,
} from '../infrastructure/tokens';
import { InventoryModule } from '../inventory/inventory.module';
import { MANAGE_INVENTORY_SERVICE } from '../inventory/tokens';
import { MoneyModule } from '../money/money.module';
import { CASH_MOVEMENT_SERVICE, CASH_SESSION_SERVICE } from '../money/tokens';
import { PartiesModule } from '../parties/parties.module';
import { MANAGE_PARTIES_SERVICE } from '../parties/tokens';
import { PurchasingModule } from '../purchasing/purchasing.module';
import { CREATE_PURCHASE_SERVICE, PAY_SUPPLIER_SERVICE } from '../purchasing/tokens';
import { ReturnsModule } from '../returns/returns.module';
import { CREATE_PURCHASE_RETURN_SERVICE, CREATE_SALES_RETURN_SERVICE } from '../returns/tokens';
import { SalesModule } from '../sales/sales.module';
import { CREATE_SALE_SERVICE, RECEIVE_CUSTOMER_PAYMENT_SERVICE } from '../sales/tokens';
import { DeviceCodeResolver } from './device-code';
import { SyncController } from './sync.controller';
import { REPLAY_SERVICE, RESOLVE_CONFLICT_SERVICE, SYNC_READ_SERVICE } from './tokens';

/**
 * Phase 12.4 — the offline shop trades and comes back (§5.23).
 *
 * **This module owns no posting engine and must never grow one.** It imports
 * the modules that already own each kind of document and hands their services
 * to replay, so a sale that reaches the books a day late is written by exactly
 * the code that writes one at the counter. The long import list is the point:
 * every one of them is a writer this module refused to reimplement.
 */
const SYNC_SERVICE_TOKENS = [
  CREATE_SALE_SERVICE,
  RECEIVE_CUSTOMER_PAYMENT_SERVICE,
  CREATE_PURCHASE_SERVICE,
  PAY_SUPPLIER_SERVICE,
  CREATE_SALES_RETURN_SERVICE,
  CREATE_PURCHASE_RETURN_SERVICE,
  MANAGE_EXPENSES_SERVICE,
  CASH_MOVEMENT_SERVICE,
  CASH_SESSION_SERVICE,
  MANAGE_INVENTORY_SERVICE,
  MANAGE_PARTIES_SERVICE,
  MANAGE_PRODUCTS_SERVICE,
];

function servicesOf(
  sales: CreateSaleService,
  receipts: ReceiveCustomerPaymentService,
  purchases: CreatePurchaseService,
  supplierPayments: PaySupplierService,
  salesReturns: CreateSalesReturnService,
  purchaseReturns: CreatePurchaseReturnService,
  expenses: ManageExpensesService,
  cashMovements: CashMovementService,
  cashSessions: CashSessionService,
  inventory: ManageInventoryService,
  parties: ManagePartiesService,
  products: ManageProductsService,
): SyncServices {
  return {
    sales,
    receipts,
    purchases,
    supplierPayments,
    salesReturns,
    purchaseReturns,
    expenses,
    cashMovements,
    cashSessions,
    inventory,
    parties,
    products,
  };
}

@Module({
  imports: [
    SalesModule,
    PurchasingModule,
    ReturnsModule,
    ExpensesModule,
    MoneyModule,
    InventoryModule,
    PartiesModule,
    CatalogModule,
  ],
  controllers: [SyncController],
  providers: [
    DeviceCodeResolver,
    {
      provide: REPLAY_SERVICE,
      useFactory: (
        uow: UnitOfWork,
        sync: SyncRepository,
        devices: DeviceRepository,
        audit: AuditWriter,
        clock: Clock,
        ...services: [
          CreateSaleService,
          ReceiveCustomerPaymentService,
          CreatePurchaseService,
          PaySupplierService,
          CreateSalesReturnService,
          CreatePurchaseReturnService,
          ManageExpensesService,
          CashMovementService,
          CashSessionService,
          ManageInventoryService,
          ManagePartiesService,
          ManageProductsService,
        ]
      ): ReplayService =>
        new ReplayService(uow, sync, devices, servicesOf(...services), audit, clock),
      inject: [UNIT_OF_WORK, SYNC_REPOSITORY, DEVICE_REPOSITORY, AUDIT_WRITER, CLOCK, ...SYNC_SERVICE_TOKENS],
    },
    {
      provide: SYNC_READ_SERVICE,
      useFactory: (
        uow: UnitOfWork,
        access: AccessControl,
        sync: SyncRepository,
        devices: DeviceRepository,
        products: ManageProductsService,
        parties: ManagePartiesService,
        clock: Clock,
      ): SyncReadService => new SyncReadService(uow, access, sync, devices, products, parties, clock),
      inject: [
        UNIT_OF_WORK,
        ACCESS_CONTROL,
        SYNC_REPOSITORY,
        DEVICE_REPOSITORY,
        MANAGE_PRODUCTS_SERVICE,
        MANAGE_PARTIES_SERVICE,
        CLOCK,
      ],
    },
    {
      provide: RESOLVE_CONFLICT_SERVICE,
      useFactory: (
        uow: UnitOfWork,
        access: AccessControl,
        sync: SyncRepository,
        devices: DeviceRepository,
        audit: AuditWriter,
        clock: Clock,
        ...services: [
          CreateSaleService,
          ReceiveCustomerPaymentService,
          CreatePurchaseService,
          PaySupplierService,
          CreateSalesReturnService,
          CreatePurchaseReturnService,
          ManageExpensesService,
          CashMovementService,
          CashSessionService,
          ManageInventoryService,
          ManagePartiesService,
          ManageProductsService,
        ]
      ): ResolveConflictService =>
        new ResolveConflictService(uow, access, sync, devices, servicesOf(...services), audit, clock),
      inject: [
        UNIT_OF_WORK,
        ACCESS_CONTROL,
        SYNC_REPOSITORY,
        DEVICE_REPOSITORY,
        AUDIT_WRITER,
        CLOCK,
        ...SYNC_SERVICE_TOKENS,
      ],
    },
  ],
  exports: [DeviceCodeResolver],
})
export class SyncModule {}
