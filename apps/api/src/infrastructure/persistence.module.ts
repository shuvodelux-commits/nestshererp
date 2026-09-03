import { Global, Module } from '@nestjs/common';
import {
  createDatabase,
  createPool,
  PostgresAccessControl,
  PostgresBackupRepository,
  PostgresAuditQueryRepository,
  PostgresAuditWriter,
  PostgresBusinessProfileRepository,
  PostgresCatalogRepository,
  PostgresIdempotencyStore,
  PostgresInventoryRepository,
  PostgresNoteRepository,
  PostgresNumberingService,
  PostgresOtpRepository,
  PostgresMoneyRepository,
  PostgresPartyRepository,
  PostgresProductRepository,
  PostgresPurchaseRepository,
  PostgresSaleRepository,
  PostgresExpenseRepository,
  PostgresPeriodRepository,
  PostgresDeviceRepository,
  PostgresSyncRepository,
  PostgresStockCountRepository,
  PostgresPurchasePlanRepository,
  PostgresLandedCostRepository,
  PostgresSerialRepository,
  PostgresWarrantyRepository,
  PostgresVendorStockRepository,
  PostgresVendorWorkspaceRepository,
  PostgresReportRepository,
  PostgresDaybookRepository,
  PostgresReconciliationRepository,
  PostgresDocumentRedateRepository,
  PostgresDocumentReversalRepository,
  PostgresPurchaseReturnRepository,
  PostgresSalesReturnRepository,
  PostgresOutbox,
  PostgresPeriodGuard,
  PostgresRoleRepository,
  PostgresSessionRepository,
  PostgresSettingsRepository,
  PostgresTenantRepository,
  PostgresUnitOfWork,
  PostgresUserIdentifierRepository,
  PostgresUserRepository,
} from '@sher/adapter-postgres';
import type {
  BuildInfo,
  EntitlementProvider,
  GoogleVerifier,
  IdentityVerifier,
  LicenseKeyStore,
  LicenseVerifier,
} from '@sher/core-application';
import type { Clock } from '@sher/shared-utils';
import { SystemClock } from '@sher/shared-utils';
import type pg from 'pg';

import { DevIdentityVerifier } from '../auth/dev-identity-verifier';
import { PdfTextExtractor } from './pdf-text-extractor';
import { AesArchiveCodec } from './archive-codec';
import { DirectoryBackupFileStore } from './backup-file-store';
import { FileBackupSecretStore } from './backup-secret-store';
import { PgDumpTool } from './database-dump-tool';
import { loadBuildInfo, MIGRATIONS_DIRECTORY, PACKAGE_JSON_PATH } from './build-info';
import { NoOpIdentityVerifier } from '../auth/noop-identity-verifier';
import { Ed25519LicenseVerifier } from '../deployment/license-codec';
import { LicenseKeyEntitlementProvider } from '../deployment/license-entitlement-provider';
import { FileLicenseKeyStore } from '../deployment/license-key-store';
import { trustedLicenseKeys } from '../deployment/license-keys';
import { MachineLicenseState } from '../deployment/license-machine-state';
import { SubscriptionEntitlementProvider } from '../deployment/subscription-entitlement-provider';
import { GoogleIdTokenVerifier, UnconfiguredGoogleVerifier } from '../auth/google-verifier';
import { CryptoOtpCodeGenerator } from '../auth/otp-code-generator';
import { ScryptPasswordHasher } from '../auth/password-hasher';
import { JwtTokenIssuer } from '../auth/token-issuer';
import { loadConfig } from '../config';
import type { ApiConfig } from '../config';
import {
  ACCESS_CONTROL,
  API_CONFIG,
  AUDIT_QUERY_REPOSITORY,
  ENTITLEMENT_PROVIDER,
  LICENSE_KEY_STORE,
  LICENSE_MACHINE_STATE,
  LICENSE_VERIFIER,
  AUDIT_WRITER,
  BUSINESS_PROFILE_REPOSITORY,
  CATALOG_REPOSITORY,
  CLOCK,
  DATABASE_POOL,
  IDEMPOTENCY_STORE,
  INVENTORY_REPOSITORY,
  IDENTITY_VERIFIER,
  NOTE_REPOSITORY,
  NUMBERING_SERVICE,
  OTP_CODE_GENERATOR,
  OTP_REPOSITORY,
  OUTBOX,
  PASSWORD_HASHER,
  PERIOD_GUARD,
  MONEY_REPOSITORY,
  PURCHASE_REPOSITORY,
  SALE_REPOSITORY,
  SALES_RETURN_REPOSITORY,
  PURCHASE_RETURN_REPOSITORY,
  EXPENSE_REPOSITORY,
  STOCK_COUNT_REPOSITORY,
  PURCHASE_PLAN_REPOSITORY,
  LANDED_COST_REPOSITORY,
  SERIAL_REPOSITORY,
  WARRANTY_REPOSITORY,
  VENDOR_STOCK_REPOSITORY,
  VENDOR_WORKSPACE_REPOSITORY,
  PERIOD_REPOSITORY,
  DEVICE_REPOSITORY,
  SYNC_REPOSITORY,
  REPORT_REPOSITORY,
  DAYBOOK_REPOSITORY,
  RECONCILIATION_REPOSITORY,
  STATEMENT_EXTRACTOR,
  BACKUP_REPOSITORY,
  ARCHIVE_CODEC,
  BACKUP_FILE_STORE,
  BACKUP_SECRET_STORE,
  DATABASE_DUMP_TOOL,
  BUILD_INFO,
  DOCUMENT_REDATE_REPOSITORY,
  DOCUMENT_REVERSAL_REPOSITORY,
  PARTY_REPOSITORY,
  PRODUCT_REPOSITORY,
  ROLE_REPOSITORY,
  TENANT_REPOSITORY,
  TOKEN_ISSUER,
  GOOGLE_VERIFIER,
  SESSION_REPOSITORY,
  SETTINGS_REPOSITORY,
  UNIT_OF_WORK,
  USER_IDENTIFIER_REPOSITORY,
  USER_REPOSITORY,
} from './tokens';

/**
 * D-33's verifier, chosen by `IDENTITY_VERIFIER` (§4.4) rather than by
 * `NODE_ENV` — a deployment mode is configuration, not an environment guess.
 *
 * `otp` is the SaaS transport and is **not implemented**: it needs a chosen SMS
 * provider, an account and a sender id (§5.24, D-33), none of which exist yet.
 * It throws here rather than falling back to `dev`, because a silent fallback
 * would accept any code the caller invents. Boot validation refuses the
 * combination in production before this is ever reached.
 */
function selectIdentityVerifier(config: ApiConfig): IdentityVerifier {
  switch (config.identityVerifier) {
    case 'none':
      return new NoOpIdentityVerifier();
    case 'dev':
      return new DevIdentityVerifier();
    case 'otp':
      throw new Error(
        'IDENTITY_VERIFIER=otp is not implemented: no SMS/email transport has been chosen ' +
          '(D-33, §5.24). Use IDENTITY_VERIFIER=none for on-premise, or dev outside production.',
      );
  }
}

/**
 * D-35's entitlement source. On-premise answers from a signed licence file
 * validated offline; SaaS answers from the subscription, which is a permissive
 * stub until Phase 10 (§5.4).
 *
 * On-premise does **not** skip entitlement checks — it answers them from the
 * licence. That is why this is a provider choice and not an `if (isOnPrem)`.
 */
function selectEntitlementProvider(
  config: ApiConfig,
  keys: LicenseKeyStore,
  state: MachineLicenseState,
): EntitlementProvider {
  return config.entitlementSource === 'license'
    ? new LicenseKeyEntitlementProvider(keys, state)
    : new SubscriptionEntitlementProvider();
}

/**
 * The single wiring point between the application layer and PostgreSQL.
 *
 * Use cases depend on interfaces only; this module decides which implementation
 * satisfies them. Swapping in the SQLite WASM adapter in Phase 12 is a change
 * here and nowhere else (D-14).
 */
@Global()
@Module({
  providers: [
    { provide: API_CONFIG, useFactory: loadConfig },
    { provide: CLOCK, useFactory: (): Clock => new SystemClock() },
    {
      provide: DATABASE_POOL,
      useFactory: (config: ApiConfig): pg.Pool => createPool(config.databaseUrl),
      inject: [API_CONFIG],
    },
    {
      provide: UNIT_OF_WORK,
      useFactory: (pool: pg.Pool): PostgresUnitOfWork =>
        new PostgresUnitOfWork(createDatabase(pool)),
      inject: [DATABASE_POOL],
    },
    {
      provide: ACCESS_CONTROL,
      useFactory: (entitlements: EntitlementProvider, clock: Clock): PostgresAccessControl =>
        new PostgresAccessControl(entitlements, clock),
      inject: [ENTITLEMENT_PROVIDER, CLOCK],
    },
    { provide: PERIOD_GUARD, useFactory: (): PostgresPeriodGuard => new PostgresPeriodGuard() },
    {
      provide: AUDIT_WRITER,
      useFactory: (clock: Clock): PostgresAuditWriter => new PostgresAuditWriter(clock),
      inject: [CLOCK],
    },
    {
      provide: IDEMPOTENCY_STORE,
      useFactory: (clock: Clock): PostgresIdempotencyStore => new PostgresIdempotencyStore(clock),
      inject: [CLOCK],
    },
    {
      provide: OUTBOX,
      useFactory: (clock: Clock): PostgresOutbox => new PostgresOutbox(clock),
      inject: [CLOCK],
    },
    {
      provide: NUMBERING_SERVICE,
      useFactory: (clock: Clock): PostgresNumberingService => new PostgresNumberingService(clock),
      inject: [CLOCK],
    },
    {
      provide: NOTE_REPOSITORY,
      useFactory: (clock: Clock): PostgresNoteRepository => new PostgresNoteRepository(clock),
      inject: [CLOCK],
    },
    { provide: PASSWORD_HASHER, useFactory: (): ScryptPasswordHasher => new ScryptPasswordHasher() },
    {
      provide: OTP_CODE_GENERATOR,
      useFactory: (): CryptoOtpCodeGenerator => new CryptoOtpCodeGenerator(),
    },
    { provide: IDENTITY_VERIFIER, useFactory: selectIdentityVerifier, inject: [API_CONFIG] },
    /*
     * The licence, as three collaborators rather than one class (owner
     * decisions 2026-09-02): what this machine remembers, what verifies a key,
     * and where the key lives. The install use case needs the last two by
     * themselves, and the entitlement provider is then a small thing that only
     * decides which state the ladder is in.
     */
    {
      provide: LICENSE_MACHINE_STATE,
      useFactory: (config: ApiConfig): MachineLicenseState =>
        new MachineLicenseState(config.licenseStatePath),
      inject: [API_CONFIG],
    },
    {
      provide: LICENSE_VERIFIER,
      useFactory: (config: ApiConfig): Ed25519LicenseVerifier =>
        new Ed25519LicenseVerifier(trustedLicenseKeys(config)),
      inject: [API_CONFIG],
    },
    {
      provide: LICENSE_KEY_STORE,
      useFactory: (
        config: ApiConfig,
        verifier: LicenseVerifier,
        state: MachineLicenseState,
        clock: Clock,
      ): FileLicenseKeyStore =>
        new FileLicenseKeyStore(config.licenseKeyPath, verifier, state, clock),
      inject: [API_CONFIG, LICENSE_VERIFIER, LICENSE_MACHINE_STATE, CLOCK],
    },
    {
      provide: ENTITLEMENT_PROVIDER,
      useFactory: selectEntitlementProvider,
      inject: [API_CONFIG, LICENSE_KEY_STORE, LICENSE_MACHINE_STATE],
    },
    {
      provide: TOKEN_ISSUER,
      useFactory: (config: ApiConfig, clock: Clock): JwtTokenIssuer =>
        new JwtTokenIssuer(config.jwtSecret, clock),
      inject: [API_CONFIG, CLOCK],
    },
    {
      provide: OTP_REPOSITORY,
      useFactory: (clock: Clock): PostgresOtpRepository => new PostgresOtpRepository(clock),
      inject: [CLOCK],
    },
    {
      provide: TENANT_REPOSITORY,
      useFactory: (clock: Clock): PostgresTenantRepository => new PostgresTenantRepository(clock),
      inject: [CLOCK],
    },
    {
      provide: ROLE_REPOSITORY,
      useFactory: (clock: Clock): PostgresRoleRepository => new PostgresRoleRepository(clock),
      inject: [CLOCK],
    },
    {
      provide: USER_REPOSITORY,
      useFactory: (clock: Clock): PostgresUserRepository => new PostgresUserRepository(clock),
      inject: [CLOCK],
    },
    {
      provide: USER_IDENTIFIER_REPOSITORY,
      useFactory: (clock: Clock): PostgresUserIdentifierRepository =>
        new PostgresUserIdentifierRepository(clock),
      inject: [CLOCK],
    },
    {
      provide: SESSION_REPOSITORY,
      useFactory: (clock: Clock): PostgresSessionRepository => new PostgresSessionRepository(clock),
      inject: [CLOCK],
    },
    {
      provide: GOOGLE_VERIFIER,
      useFactory: (config: ApiConfig, clock: Clock): GoogleVerifier =>
        config.googleClientId === ''
          ? new UnconfiguredGoogleVerifier()
          : new GoogleIdTokenVerifier(config.googleClientId, clock),
      inject: [API_CONFIG, CLOCK],
    },
    {
      provide: SETTINGS_REPOSITORY,
      useFactory: (clock: Clock): PostgresSettingsRepository =>
        new PostgresSettingsRepository(clock),
      inject: [CLOCK],
    },
    {
      provide: BUSINESS_PROFILE_REPOSITORY,
      useFactory: (clock: Clock): PostgresBusinessProfileRepository =>
        new PostgresBusinessProfileRepository(clock),
      inject: [CLOCK],
    },
    {
      provide: AUDIT_QUERY_REPOSITORY,
      useFactory: (): PostgresAuditQueryRepository => new PostgresAuditQueryRepository(),
    },
    {
      provide: CATALOG_REPOSITORY,
      useFactory: (clock: Clock): PostgresCatalogRepository => new PostgresCatalogRepository(clock),
      inject: [CLOCK],
    },
    {
      provide: PRODUCT_REPOSITORY,
      useFactory: (clock: Clock): PostgresProductRepository => new PostgresProductRepository(clock),
      inject: [CLOCK],
    },
    {
      provide: PARTY_REPOSITORY,
      useFactory: (clock: Clock): PostgresPartyRepository => new PostgresPartyRepository(clock),
      inject: [CLOCK],
    },
    {
      provide: MONEY_REPOSITORY,
      useFactory: (clock: Clock): PostgresMoneyRepository => new PostgresMoneyRepository(clock),
      inject: [CLOCK],
    },
    {
      provide: INVENTORY_REPOSITORY,
      useFactory: (clock: Clock): PostgresInventoryRepository => new PostgresInventoryRepository(clock),
      inject: [CLOCK],
    },
    {
      provide: PURCHASE_REPOSITORY,
      useFactory: (clock: Clock): PostgresPurchaseRepository => new PostgresPurchaseRepository(clock),
      inject: [CLOCK],
    },
    {
      provide: SALE_REPOSITORY,
      useFactory: (clock: Clock): PostgresSaleRepository => new PostgresSaleRepository(clock),
      inject: [CLOCK],
    },
    {
      provide: DOCUMENT_REVERSAL_REPOSITORY,
      useFactory: (clock: Clock): PostgresDocumentReversalRepository =>
        new PostgresDocumentReversalRepository(clock),
      inject: [CLOCK],
    },
    {
      /*
       * Phase 11.2. The sibling of the reversal repository above, and kept
       * apart from it on purpose: that one undoes a document, this one puts it
       * back on another day, and nothing that only cancels should be able to
       * reach a re-post.
       */
      provide: DOCUMENT_REDATE_REPOSITORY,
      useFactory: (clock: Clock): PostgresDocumentRedateRepository =>
        new PostgresDocumentRedateRepository(clock),
      inject: [CLOCK],
    },
    {
      provide: REPORT_REPOSITORY,

      useFactory: (): PostgresReportRepository => new PostgresReportRepository(),
      inject: [],
    },
    {
      provide: DAYBOOK_REPOSITORY,
      useFactory: (clock: Clock): PostgresDaybookRepository =>
        new PostgresDaybookRepository(clock),
      inject: [CLOCK],
    },
    {
      provide: RECONCILIATION_REPOSITORY,
      useFactory: (clock: Clock): PostgresReconciliationRepository =>
        new PostgresReconciliationRepository(clock),
      inject: [CLOCK],
    },
    {
      /*
       * The one adapter in this module that is not a database: reading text out
       * of a PDF (§5.17). It sits here because it is infrastructure like the
       * rest — a library behind a port, replaceable without the use case
       * noticing.
       */
      provide: STATEMENT_EXTRACTOR,
      useFactory: (): PdfTextExtractor => new PdfTextExtractor(),
      inject: [],
    },
    {
      provide: BACKUP_REPOSITORY,
      useFactory: (clock: Clock): PostgresBackupRepository => new PostgresBackupRepository(clock),
      inject: [CLOCK],
    },
    { provide: ARCHIVE_CODEC, useFactory: (): AesArchiveCodec => new AesArchiveCodec() },
    {
      provide: BACKUP_FILE_STORE,
      useFactory: (config: ApiConfig): DirectoryBackupFileStore =>
        new DirectoryBackupFileStore(config.backupDir),
      inject: [API_CONFIG],
    },
    {
      provide: BACKUP_SECRET_STORE,
      useFactory: (config: ApiConfig): FileBackupSecretStore =>
        new FileBackupSecretStore(config.backupKeyPath),
      inject: [API_CONFIG],
    },
    {
      provide: DATABASE_DUMP_TOOL,
      useFactory: (config: ApiConfig): PgDumpTool =>
        new PgDumpTool(config.databaseUrl, config.recoveryDumpDir),
      inject: [API_CONFIG],
    },
    {
      provide: BUILD_INFO,
      useFactory: (): BuildInfo => loadBuildInfo(MIGRATIONS_DIRECTORY, PACKAGE_JSON_PATH),
    },
    {
      provide: PERIOD_REPOSITORY,

      useFactory: (): PostgresPeriodRepository => new PostgresPeriodRepository(),
      inject: [],
    },
    {
      /* Phase 12.4 — what a device sent, and what became of it (§5.23). */
      provide: SYNC_REPOSITORY,
      useFactory: (clock: Clock): PostgresSyncRepository => new PostgresSyncRepository(clock),
      inject: [CLOCK],
    },
    {
      /* Phase 12.1 — registered browser profiles (§5.23, D-01). */
      provide: DEVICE_REPOSITORY,
      useFactory: (): PostgresDeviceRepository => new PostgresDeviceRepository(),
      inject: [],
    },
    {
      provide: STOCK_COUNT_REPOSITORY,
      useFactory: (clock: Clock): PostgresStockCountRepository =>
        new PostgresStockCountRepository(clock),
      inject: [CLOCK],
    },
    {
      provide: PURCHASE_PLAN_REPOSITORY,
      useFactory: (clock: Clock): PostgresPurchasePlanRepository =>
        new PostgresPurchasePlanRepository(clock),
      inject: [CLOCK],
    },
    {
      provide: LANDED_COST_REPOSITORY,
      useFactory: (clock: Clock): PostgresLandedCostRepository =>
        new PostgresLandedCostRepository(clock),
      inject: [CLOCK],
    },
    {
      provide: SERIAL_REPOSITORY,
      useFactory: (clock: Clock): PostgresSerialRepository => new PostgresSerialRepository(clock),
      inject: [CLOCK],
    },
    {
      provide: WARRANTY_REPOSITORY,
      useFactory: (clock: Clock): PostgresWarrantyRepository =>
        new PostgresWarrantyRepository(clock),
      inject: [CLOCK],
    },
    {
      provide: VENDOR_STOCK_REPOSITORY,
      useFactory: (clock: Clock): PostgresVendorStockRepository =>
        new PostgresVendorStockRepository(clock),
      inject: [CLOCK],
    },
    {
      provide: VENDOR_WORKSPACE_REPOSITORY,
      useFactory: (clock: Clock): PostgresVendorWorkspaceRepository =>
        new PostgresVendorWorkspaceRepository(clock),
      inject: [CLOCK],
    },
    {
      provide: EXPENSE_REPOSITORY,
      useFactory: (clock: Clock): PostgresExpenseRepository => new PostgresExpenseRepository(clock),
      inject: [CLOCK],
    },
    {
      provide: PURCHASE_RETURN_REPOSITORY,
      useFactory: (clock: Clock): PostgresPurchaseReturnRepository =>
        new PostgresPurchaseReturnRepository(clock),
      inject: [CLOCK],
    },
    {
      provide: SALES_RETURN_REPOSITORY,
      useFactory: (clock: Clock): PostgresSalesReturnRepository =>
        new PostgresSalesReturnRepository(clock),
      inject: [CLOCK],
    },
  ],
  exports: [
    API_CONFIG,
    CLOCK,
    DATABASE_POOL,
    UNIT_OF_WORK,
    ACCESS_CONTROL,
    PERIOD_GUARD,
    AUDIT_WRITER,
    IDEMPOTENCY_STORE,
    OUTBOX,
    NUMBERING_SERVICE,
    NOTE_REPOSITORY,
    INVENTORY_REPOSITORY,
    PASSWORD_HASHER,
    OTP_CODE_GENERATOR,
    IDENTITY_VERIFIER,
    TOKEN_ISSUER,
    OTP_REPOSITORY,
    TENANT_REPOSITORY,
    ROLE_REPOSITORY,
    USER_REPOSITORY,
    USER_IDENTIFIER_REPOSITORY,
    SESSION_REPOSITORY,
    GOOGLE_VERIFIER,
    SETTINGS_REPOSITORY,
    BUSINESS_PROFILE_REPOSITORY,
    AUDIT_QUERY_REPOSITORY,
    ENTITLEMENT_PROVIDER,
    LICENSE_VERIFIER,
    LICENSE_KEY_STORE,
    LICENSE_MACHINE_STATE,
    CATALOG_REPOSITORY,
    PRODUCT_REPOSITORY,
    PARTY_REPOSITORY,
    MONEY_REPOSITORY,
    PURCHASE_REPOSITORY,
    SALE_REPOSITORY,
    SALES_RETURN_REPOSITORY,
    PURCHASE_RETURN_REPOSITORY,
    EXPENSE_REPOSITORY,
    STOCK_COUNT_REPOSITORY,
    PURCHASE_PLAN_REPOSITORY,
    RECONCILIATION_REPOSITORY,
    STATEMENT_EXTRACTOR,
    LANDED_COST_REPOSITORY,
    SERIAL_REPOSITORY,
    WARRANTY_REPOSITORY,
    VENDOR_STOCK_REPOSITORY,
    VENDOR_WORKSPACE_REPOSITORY,
    PERIOD_REPOSITORY,
    DEVICE_REPOSITORY,
    SYNC_REPOSITORY,
    REPORT_REPOSITORY,
    DAYBOOK_REPOSITORY,
    DOCUMENT_REDATE_REPOSITORY,
  DOCUMENT_REVERSAL_REPOSITORY,
    BACKUP_REPOSITORY,
    ARCHIVE_CODEC,
    BACKUP_FILE_STORE,
    BACKUP_SECRET_STORE,
    DATABASE_DUMP_TOOL,
    BUILD_INFO,
  ],
})
export class PersistenceModule {}
