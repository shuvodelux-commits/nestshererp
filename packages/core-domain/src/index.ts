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
