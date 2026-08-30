import type {
  ClaimCandidateResponse,
  CreateWarrantyClaimRequest,
  MoveWarrantyClaimRequest,
  RecordSerialsRequest,
  SerialProgressResponse,
  SerialUnitResponse,
  WarrantyClaimListQuery,
  WarrantyClaimListResponse,
  WarrantyClaimResponse,
} from '@sher/core-contracts';

import { request } from './client';

/** Serial numbers and warranty claims (§5.19). */

export function recordSerials(
  token: string,
  payload: RecordSerialsRequest,
): Promise<SerialProgressResponse> {
  return request('/api/v1/serials', { method: 'POST', token, body: payload });
}

export function fetchSerialProgress(
  token: string,
  purchaseId: string,
): Promise<{ data: readonly SerialProgressResponse[] }> {
  return request(`/api/v1/serials/progress/${purchaseId}`, { token, envelope: true });
}

export function fetchAvailableSerials(
  token: string,
  productId: string,
): Promise<{ data: readonly SerialUnitResponse[] }> {
  return request(`/api/v1/serials/available/${productId}`, { token, envelope: true });
}

/** Serial first, then phone or invoice for goods that carry no serial. */
export function lookupWarranty(
  token: string,
  query: { serial?: string; phone?: string; invoiceNumber?: string },
): Promise<{ data: readonly ClaimCandidateResponse[] }> {
  const params = new URLSearchParams();
  if (query.serial !== undefined && query.serial !== '') params.set('serial', query.serial);
  if (query.phone !== undefined && query.phone !== '') params.set('phone', query.phone);
  if (query.invoiceNumber !== undefined && query.invoiceNumber !== '') {
    params.set('invoiceNumber', query.invoiceNumber);
  }
  return request(`/api/v1/warranty-claims/lookup?${params.toString()}`, {
    token,
    envelope: true,
  });
}

export function fetchWarrantyClaims(
  token: string,
  query: Partial<WarrantyClaimListQuery> = {},
): Promise<WarrantyClaimListResponse> {
  const params = new URLSearchParams();
  if (query.status !== undefined) params.set('status', query.status);
  if (query.search !== undefined && query.search !== '') params.set('search', query.search);
  if (query.openOnly === true) params.set('openOnly', 'true');
  if (query.limit !== undefined) params.set('limit', String(query.limit));

  const suffix = params.toString();
  return request(`/api/v1/warranty-claims${suffix === '' ? '' : `?${suffix}`}`, {
    token,
    envelope: true,
  });
}

export function fetchWarrantyClaim(token: string, id: string): Promise<WarrantyClaimResponse> {
  return request(`/api/v1/warranty-claims/${id}`, { token });
}

export function createWarrantyClaim(
  token: string,
  payload: CreateWarrantyClaimRequest,
): Promise<WarrantyClaimResponse> {
  return request('/api/v1/warranty-claims', { method: 'POST', token, body: payload });
}

/**
 * One step along the claim. Takes a key because the settle step can hand a unit
 * out of own stock, which is a real stock movement charged to warranty expense.
 */
export function moveWarrantyClaim(
  token: string,
  id: string,
  payload: MoveWarrantyClaimRequest,
  idempotencyKey: string,
): Promise<WarrantyClaimResponse> {
  return request(`/api/v1/warranty-claims/${id}/move`, {
    method: 'POST',
    token,
    body: payload,
    idempotencyKey,
  });
}
