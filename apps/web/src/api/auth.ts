import type {
  CompleteRegistrationRequest,
  DashboardSummaryResponse,
  LoginResponse,
  RegistrationResponse,
  RequestSignupOtpResponse,
} from '@sher/core-contracts';

import { request } from './client';

/**
 * Types come from `core-contracts` — the same zod schemas the API validates
 * against (§5.26), so a renamed field breaks the build here rather than at
 * runtime in a shop.
 */
export function requestSignupOtp(identifier: string): Promise<RequestSignupOtpResponse> {
  return request('/api/v1/auth/registration/otp', { method: 'POST', body: { identifier } });
}

/** Checks the code without spending it, so step 2 can answer immediately. */
export function verifySignupOtp(identifier: string, otpCode: string): Promise<{ verified: true }> {
  return request('/api/v1/auth/registration/otp/verify', {
    method: 'POST',
    body: { identifier, otpCode },
  });
}

/**
 * No `Idempotency-Key` (UI-34) on this one call: the idempotency store is
 * tenant-scoped and there is no tenant yet, so the server does not implement it
 * here — sending a header nothing reads would be theatre. A repeated submit is
 * caught instead by the single-use OTP and the unique index on the identifier.
 * Every mutation from slice 1.3 onward carries the key.
 */
export function completeRegistration(
  payload: CompleteRegistrationRequest,
): Promise<RegistrationResponse> {
  return request('/api/v1/auth/registration', { method: 'POST', body: payload });
}

export function fetchDashboardSummary(token: string): Promise<DashboardSummaryResponse> {
  return request('/api/v1/dashboard/summary', { token });
}

/* --- login (D-07) -------------------------------------------------------- */

export function loginWithPassword(identifier: string, password: string): Promise<LoginResponse> {
  return request('/api/v1/auth/login', { method: 'POST', body: { identifier, password } });
}

/** Google links to an account that already exists; it never creates one (D-07). */
export function loginWithGoogle(idToken: string): Promise<LoginResponse> {
  return request('/api/v1/auth/login/google', { method: 'POST', body: { idToken } });
}

/** The refresh token is what proves "same device" — a PIN alone is never a login. */
export function loginWithPin(refreshToken: string, pin: string): Promise<LoginResponse> {
  return request('/api/v1/auth/login/pin', { method: 'POST', body: { refreshToken, pin } });
}

export function refreshSession(refreshToken: string): Promise<LoginResponse> {
  return request('/api/v1/auth/refresh', { method: 'POST', body: { refreshToken } });
}

export function logout(refreshToken: string): Promise<void> {
  return request('/api/v1/auth/logout', { method: 'POST', body: { refreshToken } });
}
