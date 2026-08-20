// Drizzle + PostgreSQL implementations of the ports in @sher/core-application.
// Nothing here contains a business rule (R-B6).
export { createDatabase, createPool, setTenantForTransaction } from './database';
export type { Database, DatabaseTransaction } from './database';
export { runMigrations } from './migrator';
export { PostgresUnitOfWork, txOf } from './unit-of-work';
export { PostgresAccessControl } from './access-control';
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
