// Use cases and ports (repository interfaces). No Drizzle, no pg, no @nestjs/*,
// no Node built-ins — enforced by `pnpm test:boundaries`.
// Re-exported so apps/api reaches the domain through this layer rather than
// importing core-domain directly (§2.1: api → application → domain).
export {
  advancedHighWater,
  catalogNameKey,
  clockBehindMs,
  effectiveLicenseNow,
  isValidCatalogName,
  licenseAllowsWrites,
  licenseStateAt,
  normalizeCatalogName,
  OTP_LENGTH,
} from '@sher/core-domain';
export type { IdentifierChannel, LicenseState, LicenseTerm, OtpPurpose } from '@sher/core-domain';

export type { TenantContext } from './ports/tenant-context';
export type { Tx, UnitOfWork } from './ports/unit-of-work';
export type { AccessControl } from './ports/access-control';
export type { PeriodGuard } from './ports/period-guard';
export { SYSTEM_ACTOR_ID } from './ports/audit-writer';
export type { AuditEvent, AuditValues, AuditWriter } from './ports/audit-writer';
export type { IdempotencyRecord, IdempotencyStore } from './ports/idempotency-store';
export type { Outbox, OutboxRecord } from './ports/outbox';
export type { NumberingService } from './ports/numbering-service';
export type { PasswordHasher } from './ports/password-hasher';
export type { GoogleIdentity, GoogleVerifier } from './ports/google-verifier';
export type { IdentityVerifier, OtpDelivery } from './ports/identity-verifier';
export type { OtpCodeGenerator } from './ports/otp-code-generator';
export type { TokenIssuer } from './ports/token-issuer';
export type {
  InstallationProfile,
  ManagementProfileRepository,
} from './ports/management-profile';
export type { EntryMode, Note, NoteRepository } from './notes/note-repository';
export { CreateNoteService, entryModeFor } from './notes/create-note-service';
export type { CreateNoteCommand } from './notes/create-note-service';
export { GetNoteService } from './notes/get-note-service';
export type { NewOtp, OtpRepository, StoredOtp } from './auth/otp-repository';
export type {
  IdentifierOwner,
  NewRole,
  NewTenant,
  NewUser,
  RoleRepository,
  TenantRepository,
  RoleDetail,
  RoleSummary,
  UserCredentials,
  UserEdit,
  UserIdentifierRepository,
  UserRepository,
  UserSummary,
} from './auth/registration-repository';
export type {
  NewSession,
  SessionRepository,
  StoredSession,
} from './auth/session-repository';
export { LoginService } from './auth/login-service';
export type {
  LoginWithGoogleCommand,
  LoginWithPasswordCommand,
  LoginWithPinCommand,
} from './auth/login-service';
export { RequestSignupOtpService } from './auth/request-signup-otp-service';
export type { RequestSignupOtpCommand } from './auth/request-signup-otp-service';
export { VerifySignupOtpService } from './auth/verify-signup-otp-service';
export type { VerifySignupOtpCommand } from './auth/verify-signup-otp-service';
export { CompleteRegistrationService } from './auth/complete-registration-service';
export type { CompleteRegistrationCommand } from './auth/complete-registration-service';
export { GetDashboardSummaryService } from './auth/get-dashboard-summary-service';
export { RegisterWithGoogleService } from './auth/register-with-google-service';
export type { RegisterWithGoogleCommand } from './auth/register-with-google-service';
export { provisionTenant } from './auth/tenant-provisioning';
export type {
  ProvisionedTenant,
  ProvisionTenantCommand,
  ProvisionTenantDeps,
} from './auth/tenant-provisioning';
export { RequestPasswordResetService } from './auth/request-password-reset-service';
export type { RequestPasswordResetCommand } from './auth/request-password-reset-service';
export { ResetPasswordService } from './auth/reset-password-service';
export type { ResetPasswordCommand } from './auth/reset-password-service';
export { ChangeCredentialsService } from './auth/change-credentials-service';
export type {
  ChangePasswordCommand,
  ChangePinCommand,
  SecuritySettings,
} from './auth/change-credentials-service';
export { ManageUsersService } from './users/manage-users-service';
export type {
  CreateUserCommand,
  ListUsersCommand,
  SetUserDisabledCommand,
  UpdateUserCommand,
} from './users/manage-users-service';
export { ManageRolesService } from './users/manage-roles-service';
export type {
  CreateRoleCommand,
  DeleteRoleCommand,
  ListRolesCommand,
  UpdateRoleCommand,
} from './users/manage-roles-service';
export { GetMyAccessService } from './auth/get-my-access-service';
export {
  cascadeOff,
  isFeatureOn,
  settingValuesOf,
  effectiveSettings,
  effectiveValue,
  isAllowedValue,
  settingDescriptor,
  unmetParents,
} from './settings/feature-dependencies';
export type {
  BusinessProfile,
  BusinessProfileRepository,
  SettingsRepository,
  StoredSetting,
} from './settings/settings-repository';
export { ManageSettingsService } from './settings/manage-settings-service';
export type {
  GetSettingsCommand,
  UpdateBusinessProfileCommand,
  UpdateSettingCommand,
  UpdateSettingResult,
} from './settings/manage-settings-service';
export type {
  AuditEventRow,
  AuditFacets,
  AuditFilter,
  AuditQueryRepository,
} from './audit/audit-query-repository';
export { ListAuditEventsService } from './audit/list-audit-events-service';
export type { ListAuditEventsCommand } from './audit/list-audit-events-service';
export { RecordPermissionDenialService } from './audit/record-permission-denial-service';
export type { RecordPermissionDenialCommand } from './audit/record-permission-denial-service';
export type { Entitlement, EntitlementProvider } from './ports/entitlement-provider';
export type {
  CatalogEntry,
  CatalogRepository,
  CategoryEntry,
} from './catalog/catalog-repository';
export { ManageCatalogService } from './catalog/manage-catalog-service';
export type {
  CreateCategoryCommand,
  EditCatalogNameCommand,
  ListCatalogCommand,
  RemoveCatalogEntryCommand,
  SaveCatalogNameCommand,
} from './catalog/manage-catalog-service';
export type {
  NewProduct,
  ProductCounts,
  ProductEdit,
  ProductFilter,
  ProductRepository,
  ProductRow,
} from './catalog/product-repository';
export { ManageProductsService } from './catalog/manage-products-service';
export type {
  CreateProductCommand,
  GetProductCommand,
  ListProductsCommand,
  ProductIdCommand,
  ProductInput,
  SetProductStatusCommand,
  UpdateProductCommand,
} from './catalog/manage-products-service';
export type {
  CostAdjustmentListRow,
  InventoryMovementRow,
  InventoryLotFilter,
  InventoryLotRow,
  InventoryValuationLotRow,
  InventoryCostStateRow,
  InventoryRepository,
  InventoryStockRow,
  LocationRow,
  OpeningStockRecord,
  ProductStockPosition,
  StockAdjustmentFilter,
  StockAdjustmentListRow,
  StockAdjustmentForReversal,
  StockAdjustmentRecord,
  StockAdjustmentReversal,
  StockCostLayerRow,
} from './inventory/inventory-repository';
export { ManageInventoryService } from './inventory/manage-inventory-service';
export type { AdjustStockCommand, RecordOpeningStockCommand } from './inventory/manage-inventory-service';
export type {
  CustomerGroupEntry,
  NewParty,
  NewPartyOpening,
  PartyCounts,
  PartyEdit,
  PartyFilter,
  PartyLedgerFilter,
  PartyLedgerLineRow,
  PartyOpeningCorrection,
  PartyOpeningRow,
  PartyRepository,
  PartyRow,
} from './parties/party-repository';
export { ManagePartiesService } from './parties/manage-parties-service';
export type {
  CorrectPartyOpeningCommand,
  CreatePartyCommand,
  GetPartyOpeningCommand,
  ListPartiesCommand,
  OpeningBalanceInput,
  PartyIdCommand,
  PartyInput,
  SetPartyOpeningCommand,
  SetPartyStatusCommand,
  UpdatePartyCommand,
} from './parties/manage-parties-service';
export { PartyLedgerService } from './parties/party-ledger-service';
export type { PartyLedgerCommand } from './parties/party-ledger-service';
export { ManagePartyGroupsService } from './parties/manage-party-groups-service';
export type {
  CreateCustomerGroupCommand,
  PartySetupCommand,
  RemoveCustomerGroupCommand,
  RenameCustomerGroupCommand,
} from './parties/manage-party-groups-service';
export { ImportDataService } from './imports/import-data-service';
export type { CommitImportCommand, ImportCommand } from './imports/import-data-service';
export { CashMovementService } from './money/cash-movement-service';
export type { RecordMovementCommand } from './money/cash-movement-service';
export { CashSessionService } from './money/cash-session-service';
export type {
  CloseDayCommand,
  DayStatusCommand,
  ReopenDayCommand,
  StartDayCommand,
} from './money/cash-session-service';
export { DailyCashService } from './money/daily-cash-service';
export { seesLoans } from './money/loan-visibility';
export { MoneyMovementsService } from './money/money-movements-service';
export type { ListMovementsCommand } from './money/money-movements-service';
export type { AccountStatementCommand, DailyCashCommand } from './money/daily-cash-service';
export { ManageAccountsService } from './money/manage-accounts-service';
export type {
  AccountInput,
  CreateAccountCommand,
  DeactivateAccountCommand,
  ListAccountsCommand,
  UpdateAccountCommand,
} from './money/manage-accounts-service';
export type {
  AccountOpeningCorrection,
  MovementHistoryFilter,
  MovementHistoryRow,
  CashMovementRow,
  CashSessionCloseRow,
  CashSessionRow,
  CashSessionTotalsRow,
  DailyCashFilter,
  MoneyAccountEdit,
  MoneyAccountRow,
  MoneyRepository,
  NewAccountOpening,
  NewCashMovement,
  NewCashSession,
  NewCashSessionClose,
  NewJournalEntry,
  NewMoneyAccount,
  RepostCashMovement,
  StatementFilter,
  StatementLineRow,
} from './money/money-repository';
export type { CashSessionReopen } from './money/money-repository';
export { CreatePurchaseService } from './purchasing/create-purchase-service';
export type {
  CreatePurchaseCommand,
  PurchaseLineInput,
} from './purchasing/create-purchase-service';
export { PaySupplierService } from './purchasing/pay-supplier-service';
export type { PaySupplierCommand, SupplierDueCommand } from './purchasing/pay-supplier-service';
export { PurchaseQueryService } from './purchasing/purchase-query-service';
export type {
  PurchaseDetailCommand,
  PurchaseListCommand,
} from './purchasing/purchase-query-service';
export type {
  NewPurchase,
  NewPurchaseLine,
  NewSupplierPayment,
  OpenBillRow,
  PurchaseDetail,
  PurchaseFilter,
  PurchaseLineRow,
  PurchaseListRowData,
  PurchasePaymentRow,
  PurchaseRepository,
  RepostSupplierPayment,
  PurchaseRow,
  PurchaseSummary,
  SupplierPaymentDetail,
} from './purchasing/purchase-repository';
export { CreateSaleService } from './sales/create-sale-service';
export type {
  CreateSaleCommand,
  SaleLineInput,
  SalePaymentInput,
} from './sales/create-sale-service';
export { ReceiveCustomerPaymentService } from './sales/receive-payment-service';
export type { ReceiveCustomerPaymentCommand } from './sales/receive-payment-service';
export { SaleQueryService, DEFAULT_INVOICE_SETTINGS } from './sales/sale-query-service';
export { InvoicePresentationService } from './sales/invoice-presentation-service';
export type {
  UpdateInvoicePresentationCommand,
  UpdateInvoiceSettingsCommand,
} from './sales/invoice-presentation-service';
export { CancelSaleService } from './sales/cancel-sale-service';
export type { CancelSaleCommand } from './sales/cancel-sale-service';
export { QuotationService } from './sales/quotation-service';
export type { CreateQuotationCommand } from './sales/quotation-service';
export { toSaleListItem, toSaleResponse } from './sales/sale-view';
export type {
  CustomerReceiptRow,
  CustomerStandingRow,
  InvoicePresentationRow,
  InvoiceSettingsRow,
  NewCustomerReceipt,
  NewQuotation,
  NewSale,
  NewSaleDraft,
  NewSaleLine,
  NewSalePayment,
  OpenInvoiceRow,
  PosProductFilter,
  PosProductRow,
  QuotationRow,
  SaleDetail,
  SaleDraftRow,
  SaleFilter,
  SaleLineRow,
  SalePaymentRow,
  SaleReceiptRow,
  RepostCustomerReceipt,
  SaleRepository,
  SaleReversal,
  SaleRow,
  SaleTotalsRow,
} from './sales/sale-repository';
export { ManagePeriodsService } from './periods/manage-periods-service';
export type { PeriodRepository, PeriodRow } from './periods/period-repository';
export { StockCountService } from './inventory/stock-count-service';
export type { CountLineInput, PostStockCountCommand } from './inventory/stock-count-service';
export type {
  NewStockCount,
  NewStockCountLine,
  StockCountLineRow,
  StockCountRepository,
  StockCountRow,
} from './inventory/stock-count-repository';
export { ManageExpensesService, toExpenseResponse } from './expenses/manage-expenses-service';
export type {
  RecordExpenseCommand,
  SaveCategoryCommand,
} from './expenses/manage-expenses-service';
export type {
  ExpenseCategoryRow,
  ExpenseFilter,
  ExpenseRepository,
  ExpenseRow,
  NewExpense,
  RepostExpense,
  NewExpenseCategory,
} from './expenses/expense-repository';
export { VoidPurchaseService } from './purchasing/void-purchase-service';
export type { VoidPurchaseCommand } from './purchasing/void-purchase-service';
export type {
  PurchaseForReversal,
  PurchaseReversal,
} from './purchasing/purchase-repository';
export { CreatePurchaseReturnService } from './returns/create-purchase-return-service';
export type {
  CreatePurchaseReturnCommand,
  PurchaseReturnLineInput,
} from './returns/create-purchase-return-service';
export { PurchaseReturnQueryService } from './returns/purchase-return-query-service';
export { toPurchaseReturnResponse } from './returns/purchase-return-view';
export type {
  NewPurchaseReturn,
  NewPurchaseReturnLine,
  PurchaseReturnFilter,
  PurchaseReturnForReversal,
  PurchaseReturnReversal,
  PurchaseReturnLineRow,
  PurchaseReturnRepository,
  PurchaseReturnRow,
  ReturnableBillLineRow,
  ReturnableBillRow,
} from './returns/purchase-return-repository';
export { CreateSalesReturnService } from './returns/create-sales-return-service';
export type {
  CreateSalesReturnCommand,
  SalesReturnLineInput,
} from './returns/create-sales-return-service';
export { SalesReturnQueryService } from './returns/sales-return-query-service';
export { toSalesReturnResponse } from './returns/sales-return-view';
export type {
  ApprovalCandidate,
  LineConsumptionRow,
  NewSalesReturn,
  NewSalesReturnLine,
  RefundCaps,
  ReturnableInvoiceRow,
  ReturnableLineRow,
  SalesReturnFilter,
  SalesReturnForReversal,
  SalesReturnReversal,
  SalesReturnLineRow,
  SalesReturnRepository,
  SalesReturnRow,
} from './returns/sales-return-repository';

// ------------------------------------------------------------------ Phase 8
export { PlannerService, supplierFor, toPlanProduct } from './purchasing/planner-service';
export type { PlannerQueryCommand } from './purchasing/planner-service';
export { PurchasePlanService } from './purchasing/purchase-plan-service';
export type {
  SavePlanCommand,
  SendSupplierOrderCommand,
  UpdatePlanCommand,
} from './purchasing/purchase-plan-service';
export type {
  NewPlanLine,
  NewPurchasePlan,
  NewSupplierOrder,
  NewSupplierOrderLine,
  PlanListRow,
  PlanLineRow,
  PlanOrderRow,
  PlannerProductRow,
  PlannerReadOptions,
  PlanRow,
  PurchasePlanRepository,
  SupplierOrderListRow,
  SupplierOrderRow,
} from './purchasing/purchase-plan-repository';
export { AddLandedCostService } from './purchasing/landed-cost-service';
export type { AddLandedCostCommand } from './purchasing/landed-cost-service';
export type {
  CostStateRow,
  CostStateUpdate,
  LandedCostPurchaseRow,
  LandedCostRepository,
  LandedCostTargetRow,
  LotCostUpdate,
  NewLandedCost,
  PurchaseLineShareUpdate,
} from './purchasing/landed-cost-repository';
export { SerialService, toUnitResponse } from './inventory/serial-service';
export type {
  NewSerialUnit,
  SerialLineRow,
  SerialRepository,
  SerialUnitRow,
} from './inventory/serial-repository';
export { WarrantyService } from './warranty/warranty-service';
export type { CreateClaimCommand, MoveClaimCommand } from './warranty/warranty-service';
export type {
  ClaimMove,
  NewWarrantyClaim,
  WarrantyClaimRow,
  WarrantyRepository,
} from './warranty/warranty-repository';
export { VendorStockService } from './vendors/vendor-stock-service';
export type {
  ReceiveVendorStockCommand,
  ReturnVendorStockCommand,
} from './vendors/vendor-stock-service';
export type {
  NewVendorReceipt,
  NewVendorReturn,
  VendorReceiptRow,
  VendorStockRepository,
} from './vendors/vendor-stock-repository';

/* ------------------------------------------ Phase 8.3: the Vendor Workspace */
export { VendorMoneyService } from './vendors/vendor-money-service';
export type {
  PayVendorCommand,
  ReceiveFromVendorCommand,
} from './vendors/vendor-money-service';
export { VendorIssueService, issueResponseFrom } from './vendors/vendor-issue-service';
export type {
  GiveProductsToVendorCommand,
  ReceiveProductsBackCommand,
} from './vendors/vendor-issue-service';
export { VendorWorkspaceService } from './vendors/vendor-workspace-service';
export { VendorProductSettlementService } from './vendors/vendor-product-settlement-service';
export type { CreateVendorProductSettlementCommand } from './vendors/vendor-product-settlement-service';
export type {
  NewIssueLot,
  NewVendorIssueReturn,
  NewVendorMoneyDocument,
  NewVendorProductIssue,
  NewVendorProductSettlement,
  VendorAccountBalances,
  VendorActivityFilter,
  VendorActivityRowData,
  VendorMoneyDocumentRow,
  VendorProductIssueRow,
  VendorProductSettlementRow,
  VendorWorkspaceRepository,
} from './vendors/vendor-workspace-repository';

/* ------------------------------------------- Phase 9: reporting and Daybook */
export { ReportQueryService } from './reporting/report-query-service';
export { ProfitTargetService } from './reporting/profit-target-service';
export { DashboardService } from './reporting/dashboard-service';
export type {
  AccountMovementRow,
  DashboardFigures,
  DashboardSale,
  GroupedAmountRow,
  PartyLedgerEntry,
  ProductPerformanceRow,
  ProfitFigures,
  PurchaseGrouping,
  ReportPeriod,
  ReportRepository,
  SalesGrouping,
  SaveTargetInput,
  StoredTarget,
  WhySourceLine,
} from './reporting/report-repository';
export { GetDaybookService } from './daybook/get-daybook-service';
export { MarkDayReviewedService } from './daybook/mark-day-reviewed-service';
export { PrintDaybookService } from './daybook/print-daybook-service';
export { CAPABILITIES, KIND_BY_SOURCE_TYPE, kindOf } from './daybook/daybook-kinds';
export type {
  DaybookDayTotals,
  DaybookEntryRow,
  DaybookFilter,
  DaybookPrintRow,
  DaybookRepository,
  DaybookReviewRow,
  NewDaybookPrint,
  NewDaybookReview,
} from './daybook/daybook-repository';
export { reverseMoneyDocument } from './corrections/reverse-money-document';
export type {
  ReverseMoneyDocumentDeps,
  ReverseMoneyDocumentInput,
} from './corrections/reverse-money-document';
export type {
  DocumentReversalInput,
  DocumentReversalRepository,
  PostedDocument,
  PostedJournalLine,
  ReversibleDocument,
} from './corrections/document-reversal-repository';
export { ChangeTransactionDateService } from './corrections/change-transaction-date-service';
export type { ChangeTransactionDateCommand } from './corrections/change-transaction-date-service';
export type {
  DocumentRedateInput,
  DocumentRedateRepository,
  RedatableFacts,
  RedateAllocation,
  RedateJournalLine,
} from './corrections/document-redate-repository';
export { ReconcileAccountService } from './reconciliation/reconcile-account-service';
export type {
  CompleteReconciliationCommand,
  ListReconciliationsCommand,
  RemoveMatchCommand,
  ReopenReconciliationCommand,
  SaveMatchCommand,
  StartReconciliationCommand,
  WorkspaceCommand,
} from './reconciliation/reconcile-account-service';
export { ImportStatementService } from './reconciliation/import-statement-service';
export type {
  ConfirmStatementCommand,
  ReadStatementFileCommand,
  StatementFileContent,
  UploadStatementCommand,
} from './reconciliation/import-statement-service';
export type { StatementExtractor } from './reconciliation/statement-extractor';
export type {
  CompleteReconciliation,
  ForeignAccountLine,
  LedgerFilter,
  LedgerLineRow,
  MatchRecord,
  NewMatch,
  NewReconciliation,
  NewStatementFile,
  ReconcilableAccount,
  ReconciliationRepository,
  ReconciliationRow,
  ReopenReconciliation,
  StatementFileRow,
  StatementLineRecord,
} from './reconciliation/reconciliation-repository';

export { BackupService } from './backup/backup-service';
export type {
  BackupStatusCommand,
  ExportBackupCommand,
  ExportedArchive,
} from './backup/backup-service';
export { RestoreService } from './backup/restore-service';
export type { InspectArchiveCommand, RestoreCommand } from './backup/restore-service';
export { ResetBusinessService } from './backup/reset-business-service';
export type { ResetBusinessCommand } from './backup/reset-business-service';
export { LicenseStatusService } from './licensing/license-status-service';
export { LicenseInstallService } from './licensing/license-install-service';
export {
  entitlementFor,
  entitlesModule,
  licenseAppliesTo,
} from './licensing/entitlement-binding';
export type {
  LicenseKeyStore,
  LicenseVerification,
  LicenseVerifier,
  VerifiedLicense,
} from './licensing/license-ports';
export { ArchiveOpenError } from './backup/backup-ports';
export type {
  ArchiveBody,
  ArchiveCodec,
  ArchiveOpenFailure,
  ArchiveTable,
  BackupFileStore,
  BackupSecretStore,
  BuildInfo,
  DatabaseDumpTool,
  DumpResult,
  EncodedArchive,
  StoredArchive,
} from './backup/backup-ports';
export type {
  BackupRepository,
  BackupRunRecord,
  FinishRunInput,
  RestoreBlock,
  RestoreEventInput,
  StartRunInput,
} from './backup/backup-repository';
export type { ReplaceSecretCommand } from './backup/backup-service';

/* Phase 12.1 — the offline foundation (§5.23, D-01, D-24). */
export { OfflineStatusService } from './devices/offline-status-service';
export { ManageDevicesService } from './devices/manage-devices-service';
export { toDeviceResponse } from './devices/device-view';
export type {
  DeviceRepository,
  DeviceRow,
  DeviceStatusChange,
  NewDevice,
  OfflineUserRow,
} from './devices/device-repository';

/* Phase 12.3 — the snapshot the offline device reads from (§5.23). */
export { SnapshotService, SNAPSHOT_SCHEMA_VERSION } from './devices/snapshot-service';

/* Phase 12.4 — the shop trades offline and comes back (§5.23, §6, §15). */
export {
  label as syncOperationLabel,
  OP_DOCUMENT_TABLE,
  replayOperation,
  ReplayService,
  ResolveConflictService,
  SyncReadService,
  toConflictResponse,
} from './sync';
export type {
  NewSyncConflict,
  NewSyncOperation,
  ReplayResult,
  SyncChangeRow,
  SyncConflictRow,
  SyncCounts,
  SyncOperationOutcome,
  SyncOperationRow,
  SyncOperationStatus,
  SyncRepository,
  SyncServices,
} from './sync';

/* --------------------------------------------------- Phase 18.1: Global Search */
export { GlobalSearchService } from './search/global-search-service';
export type { GlobalSearchCommand } from './search/global-search-service';
