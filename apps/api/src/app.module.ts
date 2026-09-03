import type { MiddlewareConsumer, NestModule } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

import { AuditModule } from './audit/audit.module';
import { CatalogModule } from './catalog/catalog.module';
import { ImportsModule } from './imports/imports.module';
import { InventoryModule } from './inventory/inventory.module';
import { BackupModule } from './backup/backup.module';
import { MoneyModule } from './money/money.module';
import { PartiesModule } from './parties/parties.module';
import { PurchasingModule } from './purchasing/purchasing.module';
import { VendorsModule } from './vendors/vendors.module';
import { WarrantyModule } from './warranty/warranty.module';
import { DaybookModule } from './daybook/daybook.module';
import { CorrectionsModule } from './corrections/corrections.module';
import { ReportsModule } from './reports/reports.module';
import { ExpensesModule } from './expenses/expenses.module';
import { PeriodsModule } from './periods/periods.module';
import { DevicesModule } from './devices/devices.module';
import { SyncModule } from './sync/sync.module';
import { ReturnsModule } from './returns/returns.module';
import { SalesModule } from './sales/sales.module';
import { SearchModule } from './search/search.module';
import { DenialAuditInterceptor } from './common/denial-audit.interceptor';
import { ReadOnlyLicenseGuard } from './deployment/read-only.guard';
import { TraceIdMiddleware } from './common/trace-id.middleware';
import { HealthController } from './health/health.controller';
import { ManagementModule } from './management/management.module';
import { PersistenceModule } from './infrastructure/persistence.module';
import { NotesModule } from './notes/notes.module';
import { RegistrationModule } from './registration/registration.module';
import { SettingsModule } from './settings/settings.module';
import { UsersModule } from './users/users.module';

/**
 * The denial interceptor is registered globally rather than per controller:
 * §5.22 audits a refused mutation wherever it came from, and a module that
 * forgot to opt in would be a silent hole in the trail.
 */
@Module({
  imports: [
    PersistenceModule,
    NotesModule,
    RegistrationModule,
    UsersModule,
    SettingsModule,
    AuditModule,
    CatalogModule,
    InventoryModule,
    PartiesModule,
    MoneyModule,
    BackupModule,
    ImportsModule,
    PurchasingModule,
    WarrantyModule,
    VendorsModule,
    SalesModule,
    ReturnsModule,
    ExpensesModule,
    PeriodsModule,
    /* Phase 12.1 — offline devices and the D-24 gate (§5.23). */
    DevicesModule,
    SyncModule,
    ManagementModule,
    ReportsModule,
    DaybookModule,
    CorrectionsModule,
    /* Phase 18.1 — one box over products, parties and documents. */
    SearchModule,
  ],
  controllers: [HealthController],
  providers: [
    // D-36: an out-of-term deployment stops accepting new business writes. A
    // global guard because it is a property of the deployment, not of any one
    // endpoint — and a module that forgot to opt in would keep selling.
    { provide: APP_GUARD, useClass: ReadOnlyLicenseGuard },
    { provide: APP_INTERCEPTOR, useClass: DenialAuditInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Every request, including the ones that will 404 — a trace id on a
    // request that reached no route is exactly the one support needs.
    consumer.apply(TraceIdMiddleware).forRoutes('*');
  }
}
