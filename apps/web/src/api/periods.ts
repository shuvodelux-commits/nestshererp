import type { PeriodListResponse, PeriodResponse } from '@sher/core-contracts';

import { request } from './client';

/**
 * Closing a month (§5.19, D-25).
 *
 * There is no reopen call, deliberately: the owner's decision is that a closed
 * month is final, and a correction posts in the month that is open.
 */
export function fetchPeriods(token: string): Promise<PeriodListResponse> {
  return request('/api/v1/periods', { token, envelope: true });
}

export function closePeriod(
  token: string,
  payload: { year: number; month: number; note: string | null },
): Promise<PeriodResponse> {
  return request('/api/v1/periods/close', { method: 'POST', token, body: payload });
}
