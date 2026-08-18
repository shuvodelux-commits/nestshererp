/**
 * Error codes and the error type every layer throws (§5.26).
 *
 * Clients switch on `code`, never on `message`. A cross-tenant access is
 * NOT_FOUND (404), never PERMISSION_DENIED (403) — confirming that a record
 * exists in another tenant is itself a leak.
 */
export const ErrorCode = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT_STALE_VERSION: 'CONFLICT_STALE_VERSION',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  PERIOD_LOCKED: 'PERIOD_LOCKED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  /**
   * Signup (D-07). The three OTP codes are deliberately distinguishable to the
   * person typing the code — "wrong code", "it expired", "too many tries" are
   * different problems with different fixes — but none of them reveals whether
   * the identifier has an account.
   */
  OTP_INCORRECT: 'OTP_INCORRECT',
  OTP_EXPIRED: 'OTP_EXPIRED',
  OTP_MAX_ATTEMPTS_EXCEEDED: 'OTP_MAX_ATTEMPTS_EXCEEDED',
  IDENTIFIER_ALREADY_REGISTERED: 'IDENTIFIER_ALREADY_REGISTERED',
  /**
   * A verified Google email with no account here yet (§5.3, D-07 revised
   * 2026-08-17). Deliberately distinguishable, unlike a failed password login:
   * the caller proved they own the address, so telling them it has no business
   * reveals nothing — and it is what sends them to the one-field signup.
   */
  GOOGLE_ACCOUNT_UNKNOWN: 'GOOGLE_ACCOUNT_UNKNOWN',
  /**
   * D-36: the licence term has run out and its 30-day grace period with it.
   * Reads and backup export continue — there is no state in which customer data
   * is destroyed, hidden or made un-exportable — but new business writes stop.
   */
  LICENSE_READ_ONLY: 'LICENSE_READ_ONLY',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

const HTTP_STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  PERMISSION_DENIED: 403,
  NOT_FOUND: 404,
  CONFLICT_STALE_VERSION: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  PERIOD_LOCKED: 409,
  INTERNAL_ERROR: 500,
  OTP_INCORRECT: 400,
  OTP_EXPIRED: 400,
  OTP_MAX_ATTEMPTS_EXCEEDED: 400,
  IDENTIFIER_ALREADY_REGISTERED: 409,
  // 404: there is no account for this identity — not 401, because the caller's
  // Google credential was perfectly valid.
  GOOGLE_ACCOUNT_UNKNOWN: 404,
  // 423 Locked (§5.26). Not 403: the caller has every permission they need,
  // and nothing about their account is wrong — the deployment is out of term.
  LICENSE_READ_ONLY: 423,
};

export function httpStatusFor(code: ErrorCode): number {
  return HTTP_STATUS[code];
}

/** The one error type application services throw. apps/api maps it to HTTP. */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, string>>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
