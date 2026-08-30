import type {
  CompleteReconciliationRequest,
  ConfirmStatementRequest,
  ReconciliationListResponse,
  ReconciliationWorkspaceResponse,
  ReopenReconciliationRequest,
  SaveMatchRequest,
  StartReconciliationRequest,
  StatementPreviewResponse,
  UploadStatementRequest,
} from '@sher/core-contracts';

import { request } from './client';

/**
 * Account reconciliation (§5.17).
 *
 * Every call here reads or moves a **link**. Creating, correcting and
 * cancelling transactions go through `expenses.ts`, `sales.ts`, `purchasing.ts`
 * and `money.ts` exactly as they do from every other screen — the reconciliation
 * workspace opens those dialogs and they call their own endpoints.
 */
export function fetchReconciliations(
  token: string,
  accountId?: string,
): Promise<ReconciliationListResponse> {
  const suffix = accountId === undefined ? '' : `?accountId=${accountId}`;
  return request(`/api/v1/money/reconciliations${suffix}`, { token, envelope: true });
}

export function fetchReconciliation(
  token: string,
  id: string,
): Promise<ReconciliationWorkspaceResponse> {
  return request(`/api/v1/money/reconciliations/${id}`, { token, envelope: true });
}

export function startReconciliation(
  token: string,
  payload: StartReconciliationRequest,
): Promise<ReconciliationWorkspaceResponse> {
  return request('/api/v1/money/reconciliations', { method: 'POST', token, body: payload });
}

export function uploadStatement(
  token: string,
  id: string,
  payload: UploadStatementRequest,
): Promise<StatementPreviewResponse> {
  return request(`/api/v1/money/reconciliations/${id}/statement`, {
    method: 'POST',
    token,
    body: payload,
  });
}

export function confirmStatement(
  token: string,
  id: string,
  payload: ConfirmStatementRequest,
): Promise<ReconciliationWorkspaceResponse> {
  return request(`/api/v1/money/reconciliations/${id}/statement/confirm`, {
    method: 'POST',
    token,
    body: payload,
  });
}

export function saveMatch(
  token: string,
  id: string,
  payload: SaveMatchRequest,
): Promise<ReconciliationWorkspaceResponse> {
  return request(`/api/v1/money/reconciliations/${id}/matches`, {
    method: 'POST',
    token,
    body: payload,
  });
}

export function removeMatch(
  token: string,
  id: string,
  matchId: string,
): Promise<ReconciliationWorkspaceResponse> {
  return request(`/api/v1/money/reconciliations/${id}/matches/${matchId}`, {
    method: 'DELETE',
    token,
  });
}

export function completeReconciliation(
  token: string,
  id: string,
  payload: CompleteReconciliationRequest,
): Promise<ReconciliationWorkspaceResponse> {
  return request(`/api/v1/money/reconciliations/${id}/complete`, {
    method: 'POST',
    token,
    body: payload,
  });
}

export function reopenReconciliation(
  token: string,
  id: string,
  payload: ReopenReconciliationRequest,
): Promise<ReconciliationWorkspaceResponse> {
  return request(`/api/v1/money/reconciliations/${id}/reopen`, {
    method: 'POST',
    token,
    body: payload,
  });
}

/**
 * `View Original Statement` — fetched as a blob rather than linked, because the
 * PDF route needs the bearer token like every other call.
 */
export async function openStatementFile(
  token: string,
  baseUrl: string,
  id: string,
  fileId: string,
): Promise<string> {
  const response = await fetch(
    `${baseUrl}/api/v1/money/reconciliations/${id}/statement/${fileId}/file`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!response.ok) throw new Error('Could not open the statement');

  return URL.createObjectURL(await response.blob());
}
