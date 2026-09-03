/** DI tokens for ports whose types are interfaces (interfaces have no runtime value). */
export const API_CONFIG = Symbol('ApiConfig');
export const CLOCK = Symbol('Clock');
export const DATABASE_POOL = Symbol('DatabasePool');
export const UNIT_OF_WORK = Symbol('UnitOfWork');
export const ACCESS_CONTROL = Symbol('AccessControl');
export const PERIOD_GUARD = Symbol('PeriodGuard');
export const AUDIT_WRITER = Symbol('AuditWriter');
export const IDEMPOTENCY_STORE = Symbol('IdempotencyStore');
export const OUTBOX = Symbol('Outbox');
export const NUMBERING_SERVICE = Symbol('NumberingService');
export const NOTE_REPOSITORY = Symbol('NoteRepository');
export const PASSWORD_HASHER = Symbol('PasswordHasher');
export const OTP_CODE_GENERATOR = Symbol('OtpCodeGenerator');
export const IDENTITY_VERIFIER = Symbol('IdentityVerifier');
export const TOKEN_ISSUER = Symbol('TokenIssuer');
export const OTP_REPOSITORY = Symbol('OtpRepository');
export const TENANT_REPOSITORY = Symbol('TenantRepository');
export const ROLE_REPOSITORY = Symbol('RoleRepository');
export const USER_REPOSITORY = Symbol('UserRepository');
export const USER_IDENTIFIER_REPOSITORY = Symbol('UserIdentifierRepository');
export const SESSION_REPOSITORY = Symbol('SessionRepository');
export const GOOGLE_VERIFIER = Symbol('GoogleVerifier');
export const SETTINGS_REPOSITORY = Symbol('SettingsRepository');
export const BUSINESS_PROFILE_REPOSITORY = Symbol('BusinessProfileRepository');
export const AUDIT_QUERY_REPOSITORY = Symbol('AuditQueryRepository');
export const ENTITLEMENT_PROVIDER = Symbol('EntitlementProvider');
export const CATALOG_REPOSITORY = Symbol('CatalogRepository');
export const PRODUCT_REPOSITORY = Symbol('ProductRepository');
export const PARTY_REPOSITORY = Symbol('PartyRepository');
export const MONEY_REPOSITORY = Symbol('MoneyRepository');
export const INVENTORY_REPOSITORY = Symbol('InventoryRepository');
export const SALE_REPOSITORY = Symbol('SaleRepository');
export const SALES_RETURN_REPOSITORY = Symbol('SalesReturnRepository');
export const PURCHASE_RETURN_REPOSITORY = Symbol('PurchaseReturnRepository');
export const EXPENSE_REPOSITORY = Symbol('ExpenseRepository');
export const STOCK_COUNT_REPOSITORY = Symbol('StockCountRepository');
export const PERIOD_REPOSITORY = Symbol('PeriodRepository');
export const PURCHASE_REPOSITORY = Symbol('PurchaseRepository');

// Phase 8 (§5.9, §5.12, §5.19, §5.6 M07).
export const PURCHASE_PLAN_REPOSITORY = Symbol('PurchasePlanRepository');
export const LANDED_COST_REPOSITORY = Symbol('LandedCostRepository');
export const SERIAL_REPOSITORY = Symbol('SerialRepository');
export const WARRANTY_REPOSITORY = Symbol('WarrantyRepository');
export const VENDOR_STOCK_REPOSITORY = Symbol('VendorStockRepository');
export const VENDOR_WORKSPACE_REPOSITORY = Symbol('VendorWorkspaceRepository');

// Phase 9 (§5.20, §5.27).
export const REPORT_REPOSITORY = Symbol('ReportRepository');
export const DAYBOOK_REPOSITORY = Symbol('DaybookRepository');

// Phase 9.2 — cancelling and correcting posted documents.
export const DOCUMENT_REVERSAL_REPOSITORY = Symbol('DocumentReversalRepository');
export const DOCUMENT_REDATE_REPOSITORY = Symbol('DocumentRedateRepository');

// Phase 12.1 (§5.23, D-01) — registered browser profiles and the offline writer.
export const DEVICE_REPOSITORY = Symbol('DeviceRepository');
/** Phase 12.4 — what a device sent, and what became of it (§5.23). */
export const SYNC_REPOSITORY = Symbol('SyncRepository');

// Phase 11 (§5.17) — reconciliation storage, and reading text out of a PDF.
export const RECONCILIATION_REPOSITORY = Symbol('ReconciliationRepository');
export const STATEMENT_EXTRACTOR = Symbol('StatementExtractor');

// Phase 10 (§5.25, D-15, D-36) — backup, restore, reset and the licence.
export const BACKUP_REPOSITORY = Symbol('BackupRepository');
export const ARCHIVE_CODEC = Symbol('ArchiveCodec');
export const BACKUP_FILE_STORE = Symbol('BackupFileStore');
export const BACKUP_SECRET_STORE = Symbol('BackupSecretStore');
export const DATABASE_DUMP_TOOL = Symbol('DatabaseDumpTool');
export const BUILD_INFO = Symbol('BuildInfo');
export const BACKUP_SERVICE = Symbol('BackupService');
export const RESTORE_SERVICE = Symbol('RestoreService');
export const RESET_BUSINESS_SERVICE = Symbol('ResetBusinessService');
export const LICENSE_STATUS_SERVICE = Symbol('LicenseStatusService');
export const LICENSE_INSTALL_SERVICE = Symbol('LicenseInstallService');
export const LICENSE_VERIFIER = Symbol('LicenseVerifier');
export const LICENSE_KEY_STORE = Symbol('LicenseKeyStore');
export const LICENSE_MACHINE_STATE = Symbol('MachineLicenseState');
