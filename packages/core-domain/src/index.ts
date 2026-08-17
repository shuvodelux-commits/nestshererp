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
