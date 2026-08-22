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
export { stockStatus } from './inventory/stock-status';
export type { StockStatus } from './inventory/stock-status';
export type {
  AverageReceiptResult,
  CostingMethod,
  CostLayer,
  IssueCost,
  LotAllocation,
} from './inventory/costing';
