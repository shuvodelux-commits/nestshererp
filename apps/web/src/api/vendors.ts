import type {
  GiveProductsToVendorRequest,
  PayVendorRequest,
  ReceiveFromVendorRequest,
  ReceiveProductsBackRequest,
  ReceiveVendorStockRequest,
  ReturnVendorStockRequest,
  SaleResponse,
  VendorActivityKind,
  VendorActivityRow,
  VendorMoneyDocumentResponse,
  VendorProductIssueResponse,
  VendorProductSettlementRequest,
  VendorProductSettlementResponse,
  VendorSettlementResponse,
  VendorStockReceiptResponse,
  VendorWorkspaceSummaryResponse,
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

/* ------------------------------------------- Vendor Workspace (Phase 8.3) */

/**
 * The vendor's hub (§5.6 M07, UI-52).
 *
 * Four of the six actions on that screen do **not** appear here, because they
 * are not the vendor module's writes: charging goods to a vendor posts through
 * the sale endpoint, settling what they owe through the customer receipt
 * endpoint, and taking charged goods back through the sales return the existing
 * dialog already calls. Only the vendor's own money and its own custody of
 * goods are below.
 */
export function fetchVendorWorkspace(
  token: string,
  vendorPartyId: string,
): Promise<VendorWorkspaceSummaryResponse> {
  return request(`/api/v1/vendor-workspace/summary/${vendorPartyId}`, { token });
}

export function fetchVendorActivity(
  token: string,
  vendorPartyId: string,
  kinds: readonly VendorActivityKind[] = [],
): Promise<{ data: readonly VendorActivityRow[] }> {
  const params = new URLSearchParams();
  if (kinds.length > 0) params.set('kinds', kinds.join(','));
  const suffix = params.toString();
  return request(
    `/api/v1/vendor-workspace/activity/${vendorPartyId}${suffix === '' ? '' : `?${suffix}`}`,
    { token, envelope: true },
  );
}

export function payVendor(
  token: string,
  payload: PayVendorRequest,
  idempotencyKey: string,
): Promise<VendorMoneyDocumentResponse> {
  return request('/api/v1/vendor-workspace/payments', {
    method: 'POST',
    token,
    body: payload,
    idempotencyKey,
  });
}

export function receiveFromVendor(
  token: string,
  payload: ReceiveFromVendorRequest,
  idempotencyKey: string,
): Promise<VendorMoneyDocumentResponse> {
  return request('/api/v1/vendor-workspace/receipts', {
    method: 'POST',
    token,
    body: payload,
    idempotencyKey,
  });
}

/** Charged goods come back as the sale they created; a temporary issue as itself. */
export function giveProductsToVendor(
  token: string,
  payload: GiveProductsToVendorRequest,
  idempotencyKey: string,
): Promise<SaleResponse | VendorProductIssueResponse> {
  return request('/api/v1/vendor-workspace/issues', {
    method: 'POST',
    token,
    body: payload,
    idempotencyKey,
  });
}

export function receiveProductsBack(
  token: string,
  payload: ReceiveProductsBackRequest,
  idempotencyKey: string,
): Promise<VendorProductIssueResponse> {
  return request('/api/v1/vendor-workspace/issues/returns', {
    method: 'POST',
    token,
    body: payload,
    idempotencyKey,
  });
}

export function settleVendorWithProducts(
  token: string,
  payload: VendorProductSettlementRequest,
  idempotencyKey: string,
): Promise<VendorProductSettlementResponse> {
  return request('/api/v1/vendor-workspace/product-settlements', {
    method: 'POST',
    token,
    body: payload,
    idempotencyKey,
  });
}
