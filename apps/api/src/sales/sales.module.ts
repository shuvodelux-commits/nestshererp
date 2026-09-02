import { Module } from '@nestjs/common';
import type {
  AccessControl,
  AuditWriter,
  DocumentReversalRepository,
  IdempotencyStore,
  InventoryRepository,
  ManagePartiesService,
  MoneyRepository,
  NumberingService,
  Outbox,
  PartyRepository,
  PeriodGuard,
  ProductRepository,
  SaleRepository,
  SettingsRepository,
  SerialRepository,
  UnitOfWork,
  VendorStockRepository,
} from '@sher/core-application';
import {
  CancelSaleService,
  CreateSaleService,
  InvoicePresentationService,
  QuotationService,
  ReceiveCustomerPaymentService,
  SaleQueryService,
} from '@sher/core-application';
import type { Clock } from '@sher/shared-utils';

import {
  ACCESS_CONTROL,
  AUDIT_WRITER,
  DOCUMENT_REVERSAL_REPOSITORY,
  CLOCK,
  IDEMPOTENCY_STORE,
  INVENTORY_REPOSITORY,
  MONEY_REPOSITORY,
  NUMBERING_SERVICE,
  OUTBOX,
  PARTY_REPOSITORY,
  PERIOD_GUARD,
  PRODUCT_REPOSITORY,
  SALE_REPOSITORY,
  SETTINGS_REPOSITORY,
  SERIAL_REPOSITORY,
  UNIT_OF_WORK,
  VENDOR_STOCK_REPOSITORY,
} from '../infrastructure/tokens';
import { PartiesModule } from '../parties/parties.module';
import { MANAGE_PARTIES_SERVICE } from '../parties/tokens';
import { CustomerPaymentsController } from './customer-payments.controller';
import { QuotationsController } from './quotations.controller';
import { SalesController } from './sales.controller';
import {
  CANCEL_SALE_SERVICE,
  CREATE_SALE_SERVICE,
  INVOICE_PRESENTATION_SERVICE,
  QUOTATION_SERVICE,
  RECEIVE_CUSTOMER_PAYMENT_SERVICE,
  SALE_QUERY_SERVICE,
} from './tokens';

/**
 * Phase 6 — selling, receiving money for it, and what the invoice says (§5.7,
 * §5.8).
 *
 * `PartiesModule` is imported for one reason: a sale that leaves a due creates
 * the customer through the **same** service the party form calls, inside the
 * sale's own transaction (§5.8). There is one party writer (A11, A14).
 */
@Module({
  imports: [PartiesModule],
  controllers: [SalesController, CustomerPaymentsController, QuotationsController],
  providers: [
    {
      provide: CREATE_SALE_SERVICE,
      useFactory: (
        uow: UnitOfWork,
        accessControl: AccessControl,
        idempotency: IdempotencyStore,
        periods: PeriodGuard,
        parties: PartyRepository,
        partyService: ManagePartiesService,
        products: ProductRepository,
        inventory: InventoryRepository,
        serials: SerialRepository,
        vendorStock: VendorStockRepository,
        money: MoneyRepository,
        sales: SaleRepository,
        settings: SettingsRepository,
        numbering: NumberingService,
        audit: AuditWriter,
        outbox: Outbox,
        clock: Clock,
        cancellations: CancelSaleService,
      ): CreateSaleService =>
        new CreateSaleService(
          uow,
          accessControl,
          idempotency,
          periods,
          parties,
          partyService,
          products,
          inventory,
          serials,
          vendorStock,
          money,
          sales,
          settings,
          numbering,
          audit,
          outbox,
          clock,
          cancellations,
        ),
      inject: [
        UNIT_OF_WORK,
        ACCESS_CONTROL,
        IDEMPOTENCY_STORE,
        PERIOD_GUARD,
        PARTY_REPOSITORY,
        MANAGE_PARTIES_SERVICE,
        PRODUCT_REPOSITORY,
        INVENTORY_REPOSITORY,
        SERIAL_REPOSITORY,
        VENDOR_STOCK_REPOSITORY,
        MONEY_REPOSITORY,
        SALE_REPOSITORY,
        SETTINGS_REPOSITORY,
        NUMBERING_SERVICE,
        AUDIT_WRITER,
        OUTBOX,
        CLOCK,
        CANCEL_SALE_SERVICE,
      ],
    },
    {
      provide: RECEIVE_CUSTOMER_PAYMENT_SERVICE,
      useFactory: (
        uow: UnitOfWork,
        accessControl: AccessControl,
        idempotency: IdempotencyStore,
        periods: PeriodGuard,
        parties: PartyRepository,
        money: MoneyRepository,
        sales: SaleRepository,
        reversals: DocumentReversalRepository,
        numbering: NumberingService,
        audit: AuditWriter,
        outbox: Outbox,
        clock: Clock,
      ): ReceiveCustomerPaymentService =>
        new ReceiveCustomerPaymentService(
          uow,
          accessControl,
          idempotency,
          periods,
          parties,
          money,
          sales,
          reversals,
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
        PARTY_REPOSITORY,
        MONEY_REPOSITORY,
        SALE_REPOSITORY,
        DOCUMENT_REVERSAL_REPOSITORY,
        NUMBERING_SERVICE,
        AUDIT_WRITER,
        OUTBOX,
        CLOCK,
      ],
    },
    {
      provide: SALE_QUERY_SERVICE,
      useFactory: (
        uow: UnitOfWork,
        accessControl: AccessControl,
        sales: SaleRepository,
        parties: PartyRepository,
        settings: SettingsRepository,
        clock: Clock,
      ): SaleQueryService => new SaleQueryService(uow, accessControl, sales, parties, settings, clock),
      inject: [
        UNIT_OF_WORK,
        ACCESS_CONTROL,
        SALE_REPOSITORY,
        PARTY_REPOSITORY,
        SETTINGS_REPOSITORY,
        CLOCK,
      ],
    },
    {
      provide: INVOICE_PRESENTATION_SERVICE,
      useFactory: (
        uow: UnitOfWork,
        accessControl: AccessControl,
        sales: SaleRepository,
        audit: AuditWriter,
        clock: Clock,
      ): InvoicePresentationService =>
        new InvoicePresentationService(uow, accessControl, sales, audit, clock),
      inject: [UNIT_OF_WORK, ACCESS_CONTROL, SALE_REPOSITORY, AUDIT_WRITER, CLOCK],
    },
    {
      provide: CANCEL_SALE_SERVICE,
      useFactory: (
        uow: UnitOfWork,
        accessControl: AccessControl,
        periods: PeriodGuard,
        inventory: InventoryRepository,
        sales: SaleRepository,
        audit: AuditWriter,
        outbox: Outbox,
        clock: Clock,
      ): CancelSaleService =>
        new CancelSaleService(uow, accessControl, periods, inventory, sales, audit, outbox, clock),
      inject: [
        UNIT_OF_WORK,
        ACCESS_CONTROL,
        PERIOD_GUARD,
        INVENTORY_REPOSITORY,
        SALE_REPOSITORY,
        AUDIT_WRITER,
        OUTBOX,
        CLOCK,
      ],
    },
    {
      provide: QUOTATION_SERVICE,
      useFactory: (
        uow: UnitOfWork,
        accessControl: AccessControl,
        sales: SaleRepository,
        settings: SettingsRepository,
        numbering: NumberingService,
        audit: AuditWriter,
        clock: Clock,
      ): QuotationService =>
        new QuotationService(uow, accessControl, sales, settings, numbering, audit, clock),
      inject: [
        UNIT_OF_WORK,
        ACCESS_CONTROL,
        SALE_REPOSITORY,
        SETTINGS_REPOSITORY,
        NUMBERING_SERVICE,
        AUDIT_WRITER,
        CLOCK,
      ],
    },
  ],
  /*
   * Phase 8.3. The Vendor Workspace charges goods to a vendor and settles what
   * they owe — a sale and a customer receipt, posted by these very services
   * rather than by a vendor-shaped copy of them (§5.6 M07, A11, A14).
   */
  // Phase 12.4 adds the query service: the offline snapshot reads its twelve
  // months of sales through the same call the sales screen makes.
  exports: [CREATE_SALE_SERVICE, RECEIVE_CUSTOMER_PAYMENT_SERVICE, SALE_QUERY_SERVICE],
})
export class SalesModule {}
