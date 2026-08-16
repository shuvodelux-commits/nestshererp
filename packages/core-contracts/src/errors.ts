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
