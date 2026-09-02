import type {
  AccountStatementQuery,
  MoneyMovementListQuery,
  MoneyMovementListResponse,
  AccountStatementResponse,
  CashMovementResponse,
  CashSessionResponse,
  CloseDayRequest,
  CorrectCashMovementRequest,
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

import { readLocalState } from '@sher/adapter-sqlite-wasm';

import { request } from './client';
import { localBusinessDate, offlineWrite, queueCommand } from '../offline/local-writer';
import { queuedCashMovement, queuedCashSession } from '../offline/queued-documents';


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
  return offlineWrite(
    () => request<CashSessionResponse>('/api/v1/money/day/start', { method: 'POST', token, body: payload }),
    async () => {
      /*
       * A morning outage must not stop the shop opening (owner decision
       * 2026-09-02). The opening is a document like any other and replays in
       * dependency order, before every sale that took cash into the drawer it
       * opened.
       */
      await queueCommand({
        type: 'CASH_DAY_OPEN',
        payload,
        operationId: payload.operationId,
        businessDate: payload.businessDate,
      });
      return queuedCashSession<CashSessionResponse>(
        payload,
        payload.operationId,
        payload.businessDate,
        false,
      );
    },
  );
}

export function closeDay(
  token: string,
  sessionId: string,
  payload: CloseDayRequest,
): Promise<CashSessionResponse> {
  return offlineWrite(
    () =>
      request<CashSessionResponse>(`/api/v1/money/day/${sessionId}/close`, {
        method: 'POST',
        token,
        body: payload,
      }),
    async () => {
      /*
       * The drawer is counted and the day is closed offline (owner decision
       * 2026-09-02). The session it closes may itself only exist in this
       * machine's queue, so the id travels in the body and replay rewrites it
       * into the real one once the opening has posted (§3).
       *
       * The count the cashier typed is what is queued, and it is never
       * overwritten: the server works out what the drawer should have held from
       * its own postings, and a difference is surfaced rather than silently
       * applied (§12).
       */
      const state = await readLocalState();
      await queueCommand({
        type: 'CASH_DAY_CLOSE',
        payload: { ...payload, sessionId: state?.openSessionOp ?? sessionId },
        operationId: payload.operationId,
      });
      return queuedCashSession<CashSessionResponse>(
        payload,
        payload.operationId,
        localBusinessDate(),
        true,
      );
    },
  );
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
  return offlineWrite(
    () =>
      request<CashMovementResponse>('/api/v1/money/movements', {
        method: 'POST',
        token,
        body: payload,
      }),
    async () => {
      await queueCommand({
        type: 'CASH_MOVEMENT_RECORD',
        payload,
        operationId: payload.operationId,
        businessDate: payload.businessDate,
        document: {
          partyId: null,
          partyName: null,
          totalMinor: payload.amountMinor,
          paidMinor: payload.amountMinor,
          dueMinor: 0,
        },
      });
      return queuedCashMovement<CashMovementResponse>(
        payload,
        payload.operationId,
        payload.businessDate,
      );
    },
  );
}

export function fetchDailyCash(
  token: string,
  query: DailyCashQuery = {},
): Promise<DailyCashResponse> {
  return request(`/api/v1/money/daily-cash${queryString(query)}`, { token, envelope: true });
}

/**
 * Every account this user may see, with its balance.
 *
 * `asOf` is what the Finance Overview's date selector and the transfer modal's
 * "available balance as of" both pass: the balance at the end of that business
 * date rather than now, so the figure shown beside a backdated entry is the
 * figure that entry actually meets.
 */
export function fetchAccounts(
  token: string,
  includeInactive = false,
  asOf?: string,
): Promise<MoneyAccountListResponse> {
  const suffix = queryString({ includeInactive: includeInactive ? 'true' : undefined, asOf });
  return request(`/api/v1/money/accounts${suffix}`, { token, envelope: true });
}

/**
 * What the shop has moved — transfers, owner capital, loan money.
 *
 * One endpoint for the Transfer Money list, both Capital & Loans sections and
 * the Overview's recent list, told apart by `group`. Read-only: recording and
 * correcting still go through `recordMovement`, `correctMovement` and
 * `voidMovement`, which remain the only writing paths there are.
 */
export function fetchMovements(
  token: string,
  query: MoneyMovementListQuery = {},
): Promise<MoneyMovementListResponse> {
  return request(`/api/v1/money/movements${queryString(query)}`, { token, envelope: true });
}

/** Correcting a posted movement — the whole movement, re-stated (§2.5). */
export function correctMovement(
  token: string,
  movementId: string,
  payload: CorrectCashMovementRequest,
): Promise<{ ok: true }> {
  return request(`/api/v1/money/movements/${movementId}`, {
    method: 'PATCH',
    token,
    body: payload,
  });
}

/** Cancelling a posted movement. The reason is required by the server. */
export function voidMovement(
  token: string,
  movementId: string,
  payload: { readonly version: number; readonly reason: string },
): Promise<{ ok: true }> {
  return request(`/api/v1/money/movements/${movementId}/void`, {
    method: 'POST',
    token,
    body: payload,
  });
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

function queryString(query: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded === '' ? '' : `?${encoded}`;
}
