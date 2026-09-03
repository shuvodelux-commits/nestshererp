// Pure TypeScript. Entities, invariants, costing strategies, posting rules.
// Imports only @sher/shared-utils and zod — enforced by `pnpm test:boundaries`.
// This package is bundled for the browser in Phase 12, so Node built-ins are banned too.
export { isValidPassword, isValidPin, PASSWORD_MIN_LENGTH, PIN_LENGTH } from './auth/credentials';
export {
  classifyIdentifier,
  DERIVED_USERNAME_FALLBACK,
  normalizeIdentifier,
  usernameFromEmail,
} from './auth/identifier';
export type { IdentifierChannel } from './auth/identifier';
export { isExpired, OTP_LENGTH, OTP_MAX_ATTEMPTS, OTP_TTL_SECONDS, rejectionFor } from './auth/otp';
export type { OtpPurpose, OtpRejection, OtpState } from './auth/otp';
export { licenseAllowsWrites, licenseStateAt } from './licensing/license-state';
export type { LicenseState, LicenseTerm } from './licensing/license-state';
export {
  advancedHighWater,
  clockBehindMs,
  clockLooksWrong,
  effectiveLicenseNow,
} from './licensing/license-clock';
export { licenseRegression } from './licensing/license-regression';
export type { LicenseRegression, LicenseTerms } from './licensing/license-regression';
export {
  CATALOG_NAME_MAX_LENGTH,
  catalogNameKey,
  isValidCatalogName,
  normalizeCatalogName,
} from './catalog/catalog-name';
export {
  CONVERSION_FACTOR_SCALE,
  isValidConversionFactor,
  pricePerBaseUnit,
  pricePerConversionUnit,
  rejectConversion,
  splitToMixed,
  toBaseQty,
} from './catalog/unit-conversion';
export type { ConversionRejection, MixedQty, UnitConversion } from './catalog/unit-conversion';
export {
  blankToNull,
  displayNameOf,
  offerAppliesAt,
  ONE_HUNDRED_PERCENT,
  PERCENT_SCALE,
  rejectPricing,
} from './catalog/product';
export type {
  DiscountType,
  PricingRejection,
  ProductPricing,
  ProductStatus,
} from './catalog/product';
export {
  customerPhoneKey,
  isPhoneShaped,
  normalizePartyName,
  normalizePhone,
  PARTY_NAME_MAX_LENGTH,
  PARTY_PHONE_MAX_LENGTH,
  PARTY_ROLES,
  rejectParty,
} from './parties/party';
export type { PartyDraft, PartyRejection, PartyRole, PartyStatus } from './parties/party';
export {
  affectsPartyBalance,
  exceedsCreditLimit,
  PARTY_BALANCE_ACCOUNTS,
  partyBalanceOf,
  SETTLED_BALANCE,
} from './parties/party-balance';
export type { BalanceDirection, PartyBalance } from './parties/party-balance';
export { openingBalancePosting, rejectOpeningBalance } from './parties/opening-balance';
export type {
  OpeningBalanceDirection,
  OpeningBalanceDraft,
  OpeningBalancePosting,
  OpeningBalanceRejection,
} from './parties/opening-balance';
export { buildPartyLedger } from './parties/party-ledger';
export type { PartyLedger, PartyLedgerLine, PartyLedgerRow } from './parties/party-ledger';

/**
 * The posting kernel (§2.4). Every module that moves value posts through these
 * — there is no second way, which is what makes INV-01 and INV-10 provable.
 */
export {
  FIXED_ACCOUNTS,
  fixedAccount,
  isAccountCode,
  PARAMETERISED_ACCOUNTS,
  parameterisedAccount,
  parseAccountCode,
} from './accounting/account';
export type {
  AccountCode,
  FixedAccount,
  ParameterisedAccount,
  ParsedAccount,
} from './accounting/account';
export {
  entryTotalMinor,
  rejectEntry,
  reverseEntry,
} from './accounting/journal-entry';
export type {
  JournalEntryDraft,
  JournalLineDraft,
  JournalRejection,
} from './accounting/journal-entry';
export { openingStockPosting } from './inventory/opening-stock';
export type { OpeningStockPosting } from './inventory/opening-stock';
export {
  rejectStockAdjustment,
  STOCK_ADJUSTMENT_REASONS,
  stockAdjustmentPosting,
} from './inventory/stock-adjustment';
export type {
  StockAdjustmentDraft,
  StockAdjustmentPosting,
  StockAdjustmentReason,
  StockAdjustmentRejection,
} from './inventory/stock-adjustment';
export {
  allocateLots,
  averageAfterReceipt,
  averageUnitCostFrom,
  costIssue,
  stockValueMinor,
  unitCostFromMoneyMinor,
} from './inventory/costing';
/**
 * The onboarding CSV import (§5.6): the file's shape and the meaning of one
 * cell. Which unit or customer group a name refers to is resolved in
 * `core-application`, where the tenant's own rows can be read.
 */
export { parseCsv, toCsv } from './import/csv';
export type { CsvParseResult, CsvRecord, CsvRejection, CsvTable } from './import/csv';
export {
  IMPORT_COLUMNS,
  IMPORT_TYPES,
  importTemplate,
  isCalendarDate,
  missingColumns,
  readCustomerRow,
  readOpeningStockRow,
  readProductRow,
  readSupplierRow,
  valuesOf,
} from './import/templates';
export type {
  ImportCellError,
  ImportColumn,
  ImportDraft,
  ImportType,
  OpeningStockImportDraft,
  PartyImportDraft,
  ProductImportDraft,
  ReadRowResult,
} from './import/templates';
export { countTotals } from './inventory/stock-count';
export type { CountLineDraft, CountLineTotals, CountTotals } from './inventory/stock-count';
export { stockStatus } from './inventory/stock-status';
export type { StockStatus } from './inventory/stock-status';
export type {
  AverageReceiptResult,
  CostingMethod,
  CostLayer,
  IssueCost,
  LotAllocation,
} from './inventory/costing';
export {
  ACCOUNT_NAME_MAX_LENGTH,
  ACCOUNT_REFERENCE_MAX_LENGTH,
  accountCodeFor,
  canDeactivate,
  isCountable,
  isLiability,
  MONEY_ACCOUNT_TYPES,
  rejectMoneyAccount,
} from './money/money-account';
export type {
  MoneyAccountDraft,
  MoneyAccountRejection,
  MoneyAccountStatus,
  MoneyAccountType,
} from './money/money-account';
export {
  accountOpeningCorrectionPosting,
  accountOpeningPosting,
  rejectAccountOpening,
} from './money/account-opening';
export type { AccountOpeningDraft, AccountOpeningRejection } from './money/account-opening';
export {
  cashDifference,
  cashDifferencePosting,
  cashDifferenceReversal,
  closeFigures,
  differenceKindOf,
  expectedClosing,
  openingDifference,
  rejectCashClose,
  rejectCashCloseReason,
  rejectStartDay,
} from './money/cash-session';
export type {
  CashCloseFigures,
  CashCloseRejection,
  CashDifferenceKind,
  CashSessionStatus,
  CashSessionTotals,
  StartDayDraft,
  StartDayRejection,
} from './money/cash-session';
export {
  CASH_MOVEMENT_KINDS,
  cashMovementPosting,
  openingAdjustmentSides,
  rejectCashMovement,
} from './money/cash-movement';
export type {
  CashMovementDraft,
  CashMovementKind,
  CashMovementRejection,
} from './money/cash-movement';
export {
  purchaseCosts,
  purchasePosting,
  rejectPurchase,
} from './purchasing/purchase';
export type {
  PurchaseCosts,
  PurchaseDraft,
  PurchaseLineCost,
  PurchaseLineDraft,
  PurchasePostingSides,
  PurchaseRejection,
} from './purchasing/purchase';
export {
  purchaseReturnPosting,
  purchaseReturnTotals,
  rejectPurchaseReturn,
  returnableBillQty,
} from './purchasing/purchase-return';
export type {
  PurchaseReturnDraft,
  PurchaseReturnLineDraft,
  PurchaseReturnLineTotals,
  PurchaseReturnPostingSides,
  PurchaseReturnRejection,
  PurchaseReturnTotals,
  ReturnableBillLine,
} from './purchasing/purchase-return';
export {
  allocateOldestFirst,
  rejectSupplierPayment,
  supplierPaymentPosting,
} from './purchasing/supplier-payment';
export type {
  BillAllocation,
  OpenBill,
  SupplierPaymentDraft,
  SupplierPaymentRejection,
} from './purchasing/supplier-payment';
export {
  rejectVendorPayment,
  rejectVendorReceipt,
  vendorPaymentPosting,
  vendorReceiptPosting,
} from './vendors/vendor-money';
export type {
  VendorPaymentDraft,
  VendorPaymentIntent,
  VendorPaymentRejection,
  VendorReceiptDraft,
  VendorReceiptIntent,
  VendorReceiptRejection,
} from './vendors/vendor-money';
export {
  outstandingIssueQty,
  rejectVendorIssueReturn,
  restoreToLots,
} from './vendors/vendor-issue';
export type {
  IssueLotOutstanding,
  IssueLotRestore,
  VendorIssueReturnDraft,
  VendorIssueReturnRejection,
} from './vendors/vendor-issue';
export {
  ageingBucket,
  allocateReceipt,
  receiptPosting,
  rejectSale,
  salePosting,
  saleTotals,
} from './sales/sale';
export type {
  AgeingBucket,
  AllocatableInvoice,
  ReceiptAllocation,
  SaleDraft,
  SaleLineDraft,
  SaleLineTotals,
  SalePaymentSide,
  SalePostingSides,
  SaleRejection,
  SaleTotals,
} from './sales/sale';
export {
  refillLots,
  rejectSalesReturn,
  returnableQty,
  salesReturnPosting,
  salesReturnTotals,
} from './sales/sales-return';
export type {
  LotConsumed,
  LotRefill,
  ReturnableLine,
  SalesReturnDraft,
  SalesReturnLineDraft,
  SalesReturnLineTotals,
  SalesReturnPostingSides,
  SalesReturnRejection,
  SalesReturnTotals,
} from './sales/sales-return';
export {
  buildProductSearchText,
  normalizeSearchText,
  rankProduct,
  searchProducts,
  searchTokens,
} from './catalog/product-search';
export type { ProductSearchDoc, ProductSearchFields } from './catalog/product-search';

// ------------------------------------------------------------------ Phase 8
export {
  affordableQty,
  allocateBudget,
  comparePlanLines,
  coverDaysOf,
  dailySalesQty,
  expectedSalesMinor,
  investmentMinor,
  MIN_SELLING_DAYS,
  PLAN_PRIORITIES,
  planTotals,
  priorityOf,
  roundToPack,
  suggestFor,
} from './purchasing/purchase-plan';
export type {
  BudgetAllocation,
  BudgetedLine,
  PlanLineForBudget,
  PlanParams,
  PlanPriority,
  PlanProduct,
  PlanSuggestion,
  PlanTotals,
  PlanTotalsLine,
} from './purchasing/purchase-plan';
export {
  allocateLandedCost,
  DEFAULT_LANDED_COST_METHOD,
  isLandedCostCategory,
  LANDED_COST_CATEGORIES,
  rejectLandedCost,
  splitLateLandedCost,
} from './purchasing/landed-cost';
export type {
  LandedCostCategory,
  LandedCostMethod,
  LandedCostRejection,
  LandedCostShare,
  LandedCostTarget,
  LateCostSplit,
} from './purchasing/landed-cost';
export {
  ACTIVE_SERIAL_STATUSES,
  normalizeSerial,
  rejectSerial,
  rejectSerialBatch,
  serialsOutstanding,
  wholeUnitsOf,
} from './inventory/serial-unit';
export type { SerialBatch, SerialRejection, SerialUnitStatus } from './inventory/serial-unit';
export {
  canMoveClaim,
  nextClaimStatuses,
  rejectClaim,
  rejectClaimMove,
  settlementRecoversValue,
  settlementReturnsGoods,
  warrantyCoversOn,
  warrantyEndDate,
} from './warranty/warranty-claim';
export type {
  ClaimDraft,
  ClaimHandling,
  ClaimRejection,
  ClaimSettlement,
  ClaimStatus,
} from './warranty/warranty-claim';
export {
  ageingTotals,
  daysOutstanding,
  isOverdue,
  reportAgeingBucket,
  REPORT_AGEING_BUCKETS,
} from './reporting/ageing';
export type { AgeingDocument, AgeingTotals, ReportAgeingBucket } from './reporting/ageing';
export {
  grossProfitMinor,
  marginBp,
  PERCENT_BASIS,
  productPerformance,
  rankMovers,
  stockTurnBp,
} from './reporting/performance';
export type { ProductPerformance, ProductPerformanceInput } from './reporting/performance';
export { targetProgress } from './reporting/target';
export type { TargetBasis, TargetProgress, TargetProgressInput } from './reporting/target';
export { cancellationDate, correctionWindow } from './corrections/correction-window';
export type { CorrectionEntryMode, CorrectionWindow } from './corrections/correction-window';
export { isRedateRefusal, planRedate } from './corrections/redate';
export type { RedateInput, RedatePlan, RedateRefusal } from './corrections/redate';
export { parseStatement } from './reconciliation/statement-parser';
export type {
  ExtractedTextLine,
  ParsedStatement,
  ParsedStatementLine,
  StatementParseStatus,
  StatementProblem,
} from './reconciliation/statement-parser';
export {
  daysBetween,
  describeSimilarity,
  MATCH_RULES,
  matchStatement,
} from './reconciliation/matching';
export type {
  MatchableRow,
  MatchConflict,
  MatchOutcome,
  MatchPair,
  MatchReason,
  MatchRules,
} from './reconciliation/matching';
export {
  ARCHIVE_VERSION,
  archiveCompatibility,
  archiveFileName,
  archivesToDelete,
  AUTOMATIC_BACKUP_RETENTION,
  MANUAL_EXPORT_REMINDER_DAYS,
} from './backup/archive';
export type { ArchiveCompatibility, ArchiveManifest } from './backup/archive';
/* Phase 12.1 — the offline foundation (§5.23, D-01, D-24). */
export {
  canTransition,
  holdsOfflineWrite,
  nextStatus,
  occupiesWriterSlot,
  pushesAreQuarantined,
  replacementRoute,
} from './devices/authority';
export type { DeviceStatus, DeviceTransition, ReplacementRoute } from './devices/authority';
export { evaluateOfflineGate, OFFLINE_GATE_ORDER } from './devices/offline-gate';
export type {
  OfflineGateReport,
  OfflineGateResult,
  OfflineGateState,
  OfflineGateStep,
} from './devices/offline-gate';
export {
  estimateSnapshotBytes,
  requiredOfflineBytes,
  SNAPSHOT_BASE_BYTES,
  SNAPSHOT_HEADROOM_MULTIPLE,
  SNAPSHOT_MONTHS,
  SNAPSHOT_ROW_BYTES,
} from './devices/snapshot-size';
export type { SnapshotCounts } from './devices/snapshot-size';
