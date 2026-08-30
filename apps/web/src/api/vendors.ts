import type {
  ReceiveVendorStockRequest,
  ReturnVendorStockRequest,
  VendorSettlementResponse,
  VendorStockReceiptResponse,
} from '@sher/core-contracts';

import { request } from './client';

/**
 * Stock the shop holds but does not own (§5.6 M07, DR13.10).
 *
 * Both writes carry an idempotency key even though neither posts a journal
 * entry: they move stock, and stock recorded twice is as wrong as money
 * recorded twice.
 */
export function fetchVendorStock(
  token: string,
  vendorPartyId?: string,
): Promise<{ data: readonly VendorStockReceiptResponse[] }> {
  const params = new URLSearchParams();
  if (vendorPartyId !== undefined && vendorPartyId !== '') {
    params.set('vendorPartyId', vendorPartyId);
  }
  const suffix = params.toString();
  return request(`/api/v1/vendor-stock${suffix === '' ? '' : `?${suffix}`}`, {
    token,
    envelope: true,
  });
}

export function fetchVendorSettlement(
  token: string,
  vendorPartyId: string,
): Promise<VendorSettlementResponse> {
  return request(`/api/v1/vendor-stock/settlement/${vendorPartyId}`, { token });
}

export function receiveVendorStock(
  token: string,
  payload: ReceiveVendorStockRequest,
  idempotencyKey: string,
): Promise<VendorStockReceiptResponse> {
  return request('/api/v1/vendor-stock', {
    method: 'POST',
    token,
    body: payload,
    idempotencyKey,
  });
}

export function returnVendorStock(
  token: string,
  payload: ReturnVendorStockRequest,
  idempotencyKey: string,
): Promise<VendorStockReceiptResponse> {
  return request('/api/v1/vendor-stock/returns', {
    method: 'POST',
    token,
    body: payload,
    idempotencyKey,
  });
}
