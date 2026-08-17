import type {
  CompleteRegistrationRequest,
  DashboardSummaryResponse,
  LoginResponse,
  MyAccessResponse,
  RegistrationResponse,
  RequestPasswordResetResponse,
  RequestSignupOtpResponse,
  SecuritySettingsResponse,
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

/**
 * Who is signed in and what they may do (UI-09). The permission list decides
 * what the screen *offers*; the server decides what it allows.
 */
export function fetchMyAccess(token: string): Promise<MyAccessResponse> {
  return request('/api/v1/me', { token });
}

export function fetchDashboardSummary(token: string): Promise<DashboardSummaryResponse> {
  return request('/api/v1/dashboard/summary', { token });
}

/* --- login (D-07) -------------------------------------------------------- */

export function loginWithPassword(identifier: string, password: string): Promise<LoginResponse> {
  return request('/api/v1/auth/login', { method: 'POST', body: { identifier, password } });
}

/**
 * Signs in the account holding the verified Google email. Fails with
 * `GOOGLE_ACCOUNT_UNKNOWN` when there is none — the caller then collects a
 * business name and calls `registerWithGoogle` (§5.3, D-07 revised).
 */
export function loginWithGoogle(idToken: string): Promise<LoginResponse> {
  return request('/api/v1/auth/login/google', { method: 'POST', body: { idToken } });
}

/**
 * Creates the business for a verified Google email. The same ID token is sent
 * again and verified again server-side — the earlier exchange is not trusted.
 */
export function registerWithGoogle(
  idToken: string,
  businessName: string,
): Promise<RegistrationResponse> {
  return request('/api/v1/auth/registration/google', {
    method: 'POST',
    body: { idToken, businessName },
  });
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

/* --- forgot password (D-07) ---------------------------------------------- */

/**
 * The server answers the same whether or not the identifier has an account, so
 * this screen can never be used to discover which shops are registered.
 */
export function requestPasswordResetOtp(identifier: string): Promise<RequestPasswordResetResponse> {
  return request('/api/v1/auth/password/otp', { method: 'POST', body: { identifier } });
}

/** Returns nothing: a reset does not sign you in — you log in with the new password. */
export function resetPassword(
  identifier: string,
  otpCode: string,
  password: string,
): Promise<void> {
  return request('/api/v1/auth/password/reset', {
    method: 'POST',
    body: { identifier, otpCode, password },
  });
}

/* --- Settings → Security (§5.3) ------------------------------------------ */

/** Whether this account already holds a password and a PIN — Set versus Change. */
export function fetchSecuritySettings(token: string): Promise<SecuritySettingsResponse> {
  return request('/api/v1/settings/security', { token });
}

/**
 * The refresh token travels with the request so the server knows which session
 * to spare: changing a password invalidates all **other** sessions, not this one.
 *
 * `currentPassword` is omitted when the account has none yet — a Google signup
 * setting its first one. The server decides whether it was actually required;
 * leaving it out is never a way past that check.
 */
export function changePassword(
  token: string,
  refreshToken: string,
  currentPassword: string | null,
  newPassword: string,
): Promise<void> {
  return request('/api/v1/settings/security/password', {
    method: 'POST',
    token,
    body: {
      refreshToken,
      newPassword,
      ...(currentPassword === null ? {} : { currentPassword }),
    },
  });
}

export function changePin(
  token: string,
  currentPin: string | null,
  newPin: string,
): Promise<void> {
  return request('/api/v1/settings/security/pin', {
    method: 'POST',
    token,
    body: { newPin, ...(currentPin === null ? {} : { currentPin }) },
  });
}
