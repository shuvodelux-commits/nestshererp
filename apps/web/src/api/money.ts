import type {
  AccountStatementQuery,
  AccountStatementResponse,
  CashMovementResponse,
  CashSessionResponse,
  CloseDayRequest,
  CreateMoneyAccountRequest,
  DailyCashQuery,
  DailyCashResponse,
  DayStatusResponse,
  MoneyAccountListResponse,
  MoneyAccountResponse,
  RecordCashMovementRequest,
  ReopenDayRequest,
  StartDayRequest,
  UpdateMoneyAccountRequest,
} from '@sher/core-contracts';

import { request } from './client';

/**
 * Money accounts and the business day (§5.16, §5.17).
 *
 * `operationId` travels in the body rather than the header on these calls,
 * because every one of them is a document the shop can only mean once: two
 * `দিন শুরু করুন` taps on a slow connection must open one day, not two.
 */
export function fetchDayStatus(token: string): Promise<DayStatusResponse> {
  return request('/api/v1/money/day', { token, envelope: true });
}

export function startDay(token: string, payload: StartDayRequest): Promise<CashSessionResponse> {
  return request('/api/v1/money/day/start', { method: 'POST', token, body: payload });
}

export function closeDay(
  token: string,
  sessionId: string,
  payload: CloseDayRequest,
): Promise<CashSessionResponse> {
  return request(`/api/v1/money/day/${sessionId}/close`, {
    method: 'POST',
    token,
    body: payload,
  });
}

/** `ভুল করে বন্ধ করেছি` — undoing today's close (§5.16.4). */
export function reopenDay(
  token: string,
  sessionId: string,
  payload: ReopenDayRequest,
): Promise<CashSessionResponse> {
  return request(`/api/v1/money/day/${sessionId}/reopen`, {
    method: 'POST',
    token,
    body: payload,
  });
}

export function recordMovement(
  token: string,
  payload: RecordCashMovementRequest,
): Promise<CashMovementResponse> {
  return request('/api/v1/money/movements', { method: 'POST', token, body: payload });
}

export function fetchDailyCash(
  token: string,
  query: DailyCashQuery = {},
): Promise<DailyCashResponse> {
  return request(`/api/v1/money/daily-cash${queryString(query)}`, { token, envelope: true });
}

export function fetchAccounts(
  token: string,
  includeInactive = false,
): Promise<MoneyAccountListResponse> {
  const suffix = includeInactive ? '?includeInactive=true' : '';
  return request(`/api/v1/money/accounts${suffix}`, { token, envelope: true });
}

export function fetchAccountStatement(
  token: string,
  accountId: string,
  query: AccountStatementQuery = {},
): Promise<AccountStatementResponse> {
  return request(`/api/v1/money/accounts/${accountId}/statement${queryString(query)}`, {
    token,
    envelope: true,
  });
}

export function createAccount(
  token: string,
  payload: CreateMoneyAccountRequest,
): Promise<MoneyAccountResponse> {
  return request('/api/v1/money/accounts', { method: 'POST', token, body: payload });
}

export function updateAccount(
  token: string,
  accountId: string,
  payload: UpdateMoneyAccountRequest,
): Promise<MoneyAccountResponse> {
  return request(`/api/v1/money/accounts/${accountId}`, {
    method: 'PATCH',
    token,
    body: payload,
  });
}

export function deactivateAccount(
  token: string,
  accountId: string,
  version: number,
): Promise<MoneyAccountResponse> {
  return request(`/api/v1/money/accounts/${accountId}/deactivate`, {
    method: 'POST',
    token,
    body: { version },
  });
}

function queryString(query: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded === '' ? '' : `?${encoded}`;
}
