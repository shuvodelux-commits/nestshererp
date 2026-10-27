// Drizzle + PostgreSQL implementations of the ports in @sher/core-application.
// Nothing here contains a business rule (R-B6).
export { createDatabase, createPool, setTenantForTransaction } from './database';
export type { Database, DatabaseTransaction } from './database';
export { runMigrations } from './migrator';
export { PostgresUnitOfWork, txOf } from './unit-of-work';
// `SUPPORT_FORBIDDEN_PERMISSIONS` is exported so the ceiling can be held
// against the real permission catalogue by a test; it was unreachable, and
// therefore unchecked, while it was private.
export { PostgresAccessControl, SUPPORT_FORBIDDEN_PERMISSIONS } from './access-control';
export { PostgresPeriodGuard } from './period-guard';
export { PostgresAuditWriter } from './audit-writer';
export { PostgresIdempotencyStore } from './idempotency-store';
export { PostgresOutbox } from './outbox';
export { PostgresNumberingService } from './numbering-service';
export { PostgresNoteRepository } from './note-repository';
export { PostgresOtpRepository } from './otp-repository';
export {
  PostgresRoleRepository,
  PostgresTenantRepository,
  PostgresUserIdentifierRepository,
  PostgresUserRepository,
} from './registration-repository';
export * as schema from './schema';
export { PostgresSessionRepository } from './session-repository';
export {
  PostgresBusinessProfileRepository,
  PostgresSettingsRepository,
} from './settings-repository';
export { PostgresAuditQueryRepository } from './audit-query-repository';
export { PostgresCatalogRepository } from './catalog-repository';
export { PostgresProductRepository } from './product-repository';
export { PostgresPartyRepository } from './party-repository';
export { PostgresInventoryRepository } from './inventory-repository';
export { PostgresMoneyRepository } from './money-repository';
export { PostgresPurchaseRepository } from './purchase-repository';
export { PostgresSaleRepository } from './sale-repository';
export { PostgresExpenseRepository } from './expense-repository';
export { PostgresPeriodRepository } from './period-repository';
/* Phase 12.1 — registered browser profiles and the shop's offline writer. */
export { PostgresDeviceRepository } from './device-authorization-repository';
export { PostgresSyncRepository } from './sync-repository';
export { PostgresStockCountRepository } from './stock-count-repository';
export { PostgresPurchaseReturnRepository } from './purchase-return-repository';
export { PostgresSalesReturnRepository } from './sales-return-repository';
export { PostgresPurchasePlanRepository } from './purchase-plan-repository';
export { PostgresLandedCostRepository } from './landed-cost-repository';
export { PostgresSerialRepository } from './serial-repository';
export { PostgresWarrantyRepository } from './warranty-repository';
export { PostgresVendorStockRepository } from './vendor-stock-repository';
export { PostgresVendorWorkspaceRepository } from './vendor-workspace-repository';
export { PostgresReportRepository } from './report-repository';
export { PostgresDaybookRepository } from './daybook-repository';
export { PostgresDocumentReversalRepository } from './document-reversal-repository';
export { PostgresDocumentRedateRepository } from './document-redate-repository';
export { PostgresReconciliationRepository } from './reconciliation-repository';
export { PostgresBackupRepository } from './backup-repository';
export { PostgresManagementProfileRepository } from './management-profile-repository';
