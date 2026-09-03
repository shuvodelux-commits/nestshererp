/**
 * The control plane's own error type.
 *
 * A deliberate copy of the ERP's shape rather than an import of it: this
 * process is forbidden from importing `@sher/core-contracts`' application
 * layer, and the two vocabularies are not the same anyway — nothing here has a
 * period lock or a stale document version, and nothing in the ERP has an
 * untrusted installation key.
 *
 * The one rule carried over verbatim: **clients switch on `code`, never on
 * `message`**, and a resource belonging to someone the caller may not see is
 * `NOT_FOUND`, never `PERMISSION_DENIED`. Confirming that a thing exists is
 * itself a leak.
 */
export const ControlErrorCode = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  REAUTH_REQUIRED: 'REAUTH_REQUIRED',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  /** The agent's signature, nonce, clock or identity did not check out (§18). */
  AGENT_UNAUTHENTICATED: 'AGENT_UNAUTHENTICATED',
  INSTALLATION_REVOKED: 'INSTALLATION_REVOKED',
  ENROLMENT_TOKEN_INVALID: 'ENROLMENT_TOKEN_INVALID',
  SIGNER_UNAVAILABLE: 'SIGNER_UNAVAILABLE',
  SUPPORT_SESSION_INACTIVE: 'SUPPORT_SESSION_INACTIVE',
  DEPLOYMENT_HALTED: 'DEPLOYMENT_HALTED',
  PRECONDITION_FAILED: 'PRECONDITION_FAILED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;
export type ControlErrorCode = (typeof ControlErrorCode)[keyof typeof ControlErrorCode];

export class ControlError extends Error {
  constructor(
    readonly code: ControlErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ControlError';
  }
}

const STATUS: Readonly<Record<ControlErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  PERMISSION_DENIED: 403,
  REAUTH_REQUIRED: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  AGENT_UNAUTHENTICATED: 401,
  INSTALLATION_REVOKED: 403,
  ENROLMENT_TOKEN_INVALID: 400,
  SIGNER_UNAVAILABLE: 503,
  SUPPORT_SESSION_INACTIVE: 403,
  DEPLOYMENT_HALTED: 409,
  PRECONDITION_FAILED: 412,
  INTERNAL_ERROR: 500,
};

export function statusFor(code: ControlErrorCode): number {
  return STATUS[code];
}
