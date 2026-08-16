import type {
  CompleteRegistrationRequest,
  DashboardSummaryResponse,
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
