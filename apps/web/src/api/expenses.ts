import type {
  CorrectExpenseRequest,
  ExpenseCategoryResponse,
  ExpenseListResponse,
  ExpenseResponse,
  RecordExpenseRequest,
  VoidDocumentRequest,
} from '@sher/core-contracts';

import { request } from './client';
import { localBusinessDate, offlineWrite, queueCommand } from '../offline/local-writer';
import { queuedExpense } from '../offline/queued-documents';


/** What the shop spends (§5.12). */
export interface ExpenseQuery {
  readonly search?: string;
  readonly categoryId?: string;
  readonly fromDate?: string;
  readonly toDate?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export function fetchExpenses(
  token: string,
  query: ExpenseQuery = {},
): Promise<ExpenseListResponse> {
  const params = new URLSearchParams();
  if (query.search !== undefined && query.search !== '') params.set('search', query.search);
  if (query.categoryId !== undefined && query.categoryId !== '') {
    params.set('categoryId', query.categoryId);
  }
  if (query.fromDate !== undefined) params.set('fromDate', query.fromDate);
  if (query.toDate !== undefined) params.set('toDate', query.toDate);
  if (query.cursor !== undefined) params.set('cursor', query.cursor);
  if (query.limit !== undefined) params.set('limit', String(query.limit));

  const suffix = params.toString();
  return request(`/api/v1/expenses${suffix === '' ? '' : `?${suffix}`}`, {
    token,
    envelope: true,
  });
}

export function recordExpense(
  token: string,
  payload: RecordExpenseRequest,
  idempotencyKey: string,
): Promise<ExpenseResponse> {
  return offlineWrite(
    () =>
      request<ExpenseResponse>('/api/v1/expenses', {
        method: 'POST',
        token,
        body: payload,
        idempotencyKey,
      }),
    async () => {
      await queueCommand({
        type: 'EXPENSE_RECORD',
        payload,
        operationId: idempotencyKey,
        ...(payload.businessDate === undefined ? {} : { businessDate: payload.businessDate }),
        document: {
          partyId: payload.payeePartyId,
          partyName: null,
          totalMinor: payload.amountMinor,
          paidMinor: payload.amountMinor,
          dueMinor: 0,
        },
      });
      return queuedExpense<ExpenseResponse>(
        payload,
        idempotencyKey,
        payload.businessDate ?? localBusinessDate(),
      );
    },
  );
}

export function addExpenseCategory(
  token: string,
  name: string,
): Promise<ExpenseCategoryResponse> {
  return request('/api/v1/expenses/categories', { method: 'POST', token, body: { name } });
}

export function renameExpenseCategory(
  token: string,
  categoryId: string,
  name: string,
): Promise<ExpenseCategoryResponse> {
  return request(`/api/v1/expenses/categories/${categoryId}`, {
    method: 'PUT',
    token,
    body: { name },
  });
}

/** Archived, not deleted: posted expenses keep pointing at it. */
export function archiveExpenseCategory(token: string, categoryId: string): Promise<void> {
  return request(`/api/v1/expenses/categories/${categoryId}`, { method: 'DELETE', token });
}

/**
 * Correcting and cancelling a posted expense (Phase 9.2).
 *
 * `PATCH` sends the whole expense again — the server reverses what was posted
 * and re-posts these figures under the same number — and `void` needs a reason.
 */
export function correctExpense(
  token: string,
  id: string,
  body: CorrectExpenseRequest,
): Promise<ExpenseResponse> {
  return request(`/api/v1/expenses/${id}`, { token, method: 'PATCH', body });
}

export function voidExpense(
  token: string,
  id: string,
  body: VoidDocumentRequest,
): Promise<ExpenseResponse> {
  return request(`/api/v1/expenses/${id}/void`, { token, method: 'POST', body });
}
