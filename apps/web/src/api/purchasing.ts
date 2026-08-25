import type {
  CreatePurchaseRequest,
  PaySupplierRequest,
  PurchaseListQuery,
  PurchaseListResponse,
  PurchaseResponse,
  SupplierDueResponse,
  SupplierPaymentResponse,
} from '@sher/core-contracts';

import { request } from './client';

/**
 * Purchases and supplier payments (§5.9).
 *
 * `idempotencyKey` is generated once per user intent and reused on retry
 * (UI-34) — it is the same value the server stores as `operation_id`, which is
 * what makes two taps on a slow connection one bill rather than two.
 */
export function fetchPurchases(
  token: string,
  query: PurchaseListQuery = {},
): Promise<PurchaseListResponse> {
  const params = new URLSearchParams();
  if (query.search !== undefined && query.search !== '') params.set('search', query.search);
  if (query.supplierPartyId !== undefined) params.set('supplierPartyId', query.supplierPartyId);
  if (query.fromDate !== undefined) params.set('fromDate', query.fromDate);
  if (query.toDate !== undefined) params.set('toDate', query.toDate);
  if (query.settlement !== undefined) params.set('settlement', query.settlement);
  if (query.cursor !== undefined) params.set('cursor', query.cursor);
  if (query.limit !== undefined) params.set('limit', String(query.limit));

  const suffix = params.toString();
  // The whole envelope: §5.26 puts `page` and `summary` beside `data`, and the
  // tiles are counted by the same query as the rows.
  return request(`/api/v1/purchases${suffix === '' ? '' : `?${suffix}`}`, {
    token,
    envelope: true,
  });
}

export function fetchPurchase(token: string, id: string): Promise<PurchaseResponse> {
  return request(`/api/v1/purchases/${id}`, { token });
}

export function createPurchase(
  token: string,
  payload: CreatePurchaseRequest,
  idempotencyKey: string,
): Promise<PurchaseResponse> {
  return request('/api/v1/purchases', { method: 'POST', token, body: payload, idempotencyKey });
}

/**
 * Cancelling a posted bill (§2.5). A **correction** is not here: it is
 * `createPurchase` with `correctionOf` set, because there is one purchase
 * writer and a corrected bill must obey exactly the rules a typed one does.
 */
export function voidPurchase(
  token: string,
  purchaseId: string,
  payload: { version: number; reason: string | null },
): Promise<PurchaseResponse> {
  return request(`/api/v1/purchases/${purchaseId}/void`, { method: 'POST', token, body: payload });
}

/** What the Pay Supplier dialog opens on: the debt, and the bills behind it. */
export function fetchSupplierDue(token: string, supplierId: string): Promise<SupplierDueResponse> {
  return request(`/api/v1/suppliers/${supplierId}/due`, { token });
}

export function paySupplier(
  token: string,
  payload: PaySupplierRequest,
  idempotencyKey: string,
): Promise<SupplierPaymentResponse> {
  return request('/api/v1/suppliers/payments', {
    method: 'POST',
    token,
    body: payload,
    idempotencyKey,
  });
}
