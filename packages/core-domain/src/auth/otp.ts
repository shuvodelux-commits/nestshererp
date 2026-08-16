/**
 * OTP rules (§5.3, D-07): 6 digits · 5-minute expiry · single use · invalidated
 * on a new request · maximum 5 verification attempts then the code dies.
 *
 * Pure decision logic only. Generating the code needs randomness and storing it
 * needs hashing — both are I/O concerns behind ports, because this package is
 * bundled for the browser and may not import `node:crypto`.
 *
 * Expiry is derived from `createdAt` rather than stored, so the 5-minute rule
 * lives here and only here. Times are compared as epoch milliseconds: `new
 * Date()` is banned outside the Clock implementation (R-C8).
 */
export const OTP_LENGTH = 6;
export const OTP_TTL_SECONDS = 300;
export const OTP_MAX_ATTEMPTS = 5;

/**
 * What a code was issued for (D-07): identity is verified once at signup and
 * again at password recovery, and those are the only two.
 *
 * The purpose is part of a code's identity, not a label on it. A code sent to
 * prove "this phone is mine" must not be spendable to set a new password on an
 * account that already exists — so every lookup is scoped by purpose, and the
 * two flows can never see each other's codes.
 */
export type OtpPurpose = 'SIGNUP' | 'PASSWORD_RESET';

export interface OtpState {
  readonly attemptCount: number;
  readonly createdAt: Date;
  readonly consumedAt: Date | null;
}

/**
 * Why a code cannot be verified, or `null` when it still can be.
 *
 * The caller reports `CONSUMED` to the user as expiry: telling an attacker that
 * a code was already used says an identifier finished signing up.
 */
export type OtpRejection = 'EXPIRED' | 'CONSUMED' | 'MAX_ATTEMPTS';

export function rejectionFor(state: OtpState, now: Date): OtpRejection | null {
  if (state.consumedAt !== null) return 'CONSUMED';
  if (state.attemptCount >= OTP_MAX_ATTEMPTS) return 'MAX_ATTEMPTS';
  if (isExpired(state.createdAt, now)) return 'EXPIRED';
  return null;
}

export function isExpired(createdAt: Date, now: Date): boolean {
  return now.getTime() - createdAt.getTime() >= OTP_TTL_SECONDS * 1000;
}
