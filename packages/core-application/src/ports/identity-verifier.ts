import type { IdentifierChannel } from '@sher/core-domain';

/**
 * D-33: identity verification is pluggable. `sendOtp` is called from exactly one
 * place, and no module outside M02 imports an SMS provider type.
 *
 * Slice 1.1 ships the development transport only. `OtpIdentityVerifier` (real
 * SMS/email, SaaS) and `NoOpIdentityVerifier` (on-premise) arrive with the rest
 * of D-33 in slice 1.7, along with the boot-time validation that rejects the
 * wrong combination.
 */
export interface OtpDelivery {
  /**
   * The code, echoed back **only** by a development transport so registration is
   * testable without a paid SMS gateway. A real provider returns it undefined,
   * and the API must never expose it in production.
   */
  readonly devCode?: string;
}

export interface IdentityVerifier {
  sendOtp(identifier: string, channel: IdentifierChannel, code: string): Promise<OtpDelivery>;
}
