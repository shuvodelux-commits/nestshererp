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
  /**
   * §5.26's 403 for the **feature** step of `Plan → Feature → Setting →
   * Permission → Access`: the caller may well hold the permission, but the shop
   * has this feature switched off in Settings (§5.21).
   *
   * Distinguished from `PERMISSION_DENIED` because the two have different fixes —
   * one is a role change, the other is a setting — and because the UI must not
   * offer a control that would raise either (UI-09).
   */
  /**
   * §5.26's 422: the sale asks for more of something than the shop has, and
   * the negative-stock policy will not let it post (§5.7).
   *
   * Its own code rather than a validation failure, because the counter's answer
   * is neither "fix the form" nor "you may not" — it is a decision about
   * whether to sell goods that are not on the shelf, and `details.reason`
   * carries which of `BLOCK` or `WARN` produced it so the POS can offer the
   * right control.
   */
  INSUFFICIENT_STOCK: 'INSUFFICIENT_STOCK',
  FEATURE_DISABLED: 'FEATURE_DISABLED',
  /**
   * 402-shaped in spirit, 403 in fact: the caller may take this return, but the
   * cash they want to hand back is over their role's refund limit (owner
   * decision 2026-08-26). Its own code because the screen's answer is neither
   * "fix the form" nor "you may not" — it is to ask somebody senior for a PIN,
   * and no other refusal opens that dialog.
   */
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
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
  INSUFFICIENT_STOCK: 422,
  FEATURE_DISABLED: 403,
  APPROVAL_REQUIRED: 403,
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
