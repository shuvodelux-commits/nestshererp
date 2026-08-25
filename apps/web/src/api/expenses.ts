import type {
  ExpenseCategoryResponse,
  ExpenseListResponse,
  ExpenseResponse,
  RecordExpenseRequest,
} from '@sher/core-contracts';

import { request } from './client';

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
  return request('/api/v1/expenses', { method: 'POST', token, body: payload, idempotencyKey });
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
