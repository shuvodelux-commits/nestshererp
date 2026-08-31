import type {
  ChangeTransactionDateRequest, ChangeTransactionDateResponse, RedatableDocument,
  TransactionDateContext,
} from '@sher/core-contracts';

import { request } from './client';

/**
 * Change Transaction Date (Phase 11.2, UI-72).
 *
 * One route for every screen that offers the action — Daybook, the party and
 * account ledgers, the reconciliation compare screen. There is deliberately no
 * per-module variant here: the day a second URL appears in this file is the day
 * two screens can start disagreeing about what re-dating means.
 */
export function fetchTransactionDateContext(
  token: string,
  documentType: RedatableDocument,
  documentId: string,
): Promise<TransactionDateContext> {
  return request(`/api/v1/corrections/transaction-date/${documentType}/${documentId}`, { token });
}

export function changeTransactionDate(
  token: string,
  body: ChangeTransactionDateRequest,
): Promise<ChangeTransactionDateResponse> {
  return request('/api/v1/corrections/transaction-date', { token, method: 'POST', body });
}

/** Which Daybook kinds this action reaches — the four money vouchers (D-43). */
const REDATABLE: readonly string[] = [
  'EXPENSE',
  'CUSTOMER_RECEIPT',
  'SUPPLIER_PAYMENT',
  'CASH_MOVEMENT',
];

export function isRedatableKind(kind: string): kind is RedatableDocument {
  return REDATABLE.includes(kind);
}
