import type { MiddlewareConsumer, NestModule } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

import { AuditModule } from './audit/audit.module';
import { CatalogModule } from './catalog/catalog.module';
import { ImportsModule } from './imports/imports.module';
import { InventoryModule } from './inventory/inventory.module';
import { MoneyModule } from './money/money.module';
import { PartiesModule } from './parties/parties.module';
import { PurchasingModule } from './purchasing/purchasing.module';
import { ReturnsModule } from './returns/returns.module';
import { SalesModule } from './sales/sales.module';
import { DenialAuditInterceptor } from './common/denial-audit.interceptor';
import { ReadOnlyLicenseGuard } from './deployment/read-only.guard';
import { TraceIdMiddleware } from './common/trace-id.middleware';
import { HealthController } from './health/health.controller';
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
    ImportsModule,
    PurchasingModule,
    SalesModule,
    ReturnsModule,
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
