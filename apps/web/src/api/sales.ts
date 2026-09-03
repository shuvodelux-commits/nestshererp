import type {
  CreateQuotationRequest,
  CreateSaleRequest,
  CustomerReceiptResponse,
  CustomerStandingResponse,
  InvoicePresentation,
  InvoiceSettings,
  PosProductList,
  PosProductQuery,
  QuotationResponse,
  SaleDraftResponse,
  SaveSaleDraftRequest,
  ReceiveCustomerPaymentRequest,
  SaleListQuery,
  SaleListResponse,
  SaleResponse,
} from '@sher/core-contracts';

import { request } from './client';
import { localSaleResponse } from '../offline/local-sale';
import { queuedReceipt } from '../offline/queued-documents';
import { localBusinessDate, offlineWrite, queueCommand, queueSale } from '../offline/local-writer';

/**
 * Selling (§5.7, §5.8).
 *
 * `idempotencyKey` is generated once per sale and reused on retry (UI-34) — it
 * is the same value the server stores as `operation_id`, which is what makes
 * two taps of Complete Sale one invoice rather than two.
 */
export function fetchPosProducts(
  token: string,
  query: PosProductQuery = {},
): Promise<PosProductList> {
  const params = new URLSearchParams();
  if (query.search !== undefined && query.search !== '') params.set('search', query.search);
  if (query.barcode !== undefined && query.barcode !== '') params.set('barcode', query.barcode);
  if (query.categoryId !== undefined) params.set('categoryId', query.categoryId);
  if (query.brandId !== undefined) params.set('brandId', query.brandId);
  if (query.stockStatus !== undefined) params.set('stockStatus', query.stockStatus);
  if (query.customerPartyId !== undefined) params.set('customerPartyId', query.customerPartyId);
  if (query.cursor !== undefined) params.set('cursor', query.cursor);
  if (query.limit !== undefined) params.set('limit', String(query.limit));

  const suffix = params.toString();
    // The whole object: the grid needs `items` and `nextCursor` side by side.
  return request(`/api/v1/sales/pos-products${suffix === '' ? '' : `?${suffix}`}`, {
    token,
    envelope: true,
  });
}

export function fetchSales(token: string, query: SaleListQuery = {}): Promise<SaleListResponse> {
  const params = new URLSearchParams();
  if (query.search !== undefined && query.search !== '') params.set('search', query.search);
  if (query.partyId !== undefined) params.set('partyId', query.partyId);
  if (query.fromDate !== undefined) params.set('fromDate', query.fromDate);
  if (query.toDate !== undefined) params.set('toDate', query.toDate);
  if (query.unpaidOnly === true) params.set('unpaidOnly', 'true');
  if (query.cursor !== undefined) params.set('cursor', query.cursor);
  if (query.limit !== undefined) params.set('limit', String(query.limit));

  const suffix = params.toString();
    // The whole envelope: §5.26 puts the tiles beside the rows, counted by the
  // same query.
  return request(`/api/v1/sales${suffix === '' ? '' : `?${suffix}`}`, { token, envelope: true });
}

export function fetchSale(token: string, id: string): Promise<SaleResponse> {
  return request(`/api/v1/sales/${id}`, { token });
}

/**
 * Sell (§5.7), and keep selling when the line is down (Phase 12.4).
 *
 * The offline branch is here rather than in the POS for the reason the read
 * fallback gives in `offline-fallback.ts`: one rule in one place, instead of a
 * second write path inside the longest screen in the app — the one branch
 * nobody exercises until the day it matters.
 *
 * It queues the **same command** the server would have received and answers in
 * the **same shape**, so the till prints, the change is right and the cart
 * clears exactly as they do online. What differs is one honest warning on the
 * invoice and the absence of a profit figure, which the books have not worked
 * out yet.
 */
export function createSale(
  token: string,
  payload: CreateSaleRequest,
  idempotencyKey: string,
): Promise<SaleResponse> {
  return offlineWrite(
    () => request<SaleResponse>('/api/v1/sales', { method: 'POST', token, body: payload, idempotencyKey }),
    async (device) => {
      const queued = await queueSale(payload, idempotencyKey, device);
      return localSaleResponse(
        payload,
        queued.number,
        idempotencyKey,
        payload.businessDate ?? localBusinessDate(),
        device.deviceCode,
      );
    },
  );
}

/** Display-only overrides (§5.8). Never an accounting fact. */
export function updateInvoicePresentation(
  token: string,
  saleId: string,
  payload: InvoicePresentation,
): Promise<SaleResponse> {
  return request(`/api/v1/sales/${saleId}/presentation`, { method: 'PUT', token, body: payload });
}

export function cancelSale(
  token: string,
  saleId: string,
  version: number,
  reason: string | null,
): Promise<SaleResponse> {
  return request(`/api/v1/sales/${saleId}/cancel`, {
    method: 'POST',
    token,
    body: { version, reason },
  });
}

/** What the customer panel shows the moment a customer resolves (§5.8). */
export function fetchCustomerStanding(
  token: string,
  partyId: string,
): Promise<CustomerStandingResponse> {
  return request(`/api/v1/customers/${partyId}/standing`, { token });
}

export function receiveCustomerPayment(
  token: string,
  payload: ReceiveCustomerPaymentRequest,
  idempotencyKey: string,
): Promise<CustomerReceiptResponse> {
  return offlineWrite(
    () => request<CustomerReceiptResponse>('/api/v1/customer-payments', {
    method: 'POST',
    token,
    body: payload,
    idempotencyKey,
  }),
    async () => {
      /*
       * Money in from a customer while the line is down. Queued as the command
       * the receipts endpoint takes, so the server allocates it oldest-first
       * through the one service that owns receipts — the device never decides
       * which invoices it settles (§4, §6).
       */
      await queueCommand({
        type: 'CUSTOMER_RECEIPT_RECORD',
        payload,
        operationId: idempotencyKey,
        document: {
          partyId: payload.customerPartyId,
          partyName: null,
          totalMinor: payload.amountMinor,
          paidMinor: payload.amountMinor,
          dueMinor: 0,
        },
        balanceDelta: { partyId: payload.customerPartyId, amountMinor: -payload.amountMinor },
      });
      return queuedReceipt<CustomerReceiptResponse>(payload, idempotencyKey, localBusinessDate());
    },
  );
}

export function fetchInvoiceSettings(token: string): Promise<InvoiceSettings> {
  return request('/api/v1/sales/invoice-settings', { token });
}

export function updateInvoiceSettings(
  token: string,
  payload: Partial<InvoiceSettings>,
): Promise<InvoiceSettings> {
  return request('/api/v1/sales/invoice-settings', { method: 'PUT', token, body: payload });
}

export function fetchQuotations(
  token: string,
  kind: 'QUOTATION' | 'ORDER',
): Promise<readonly QuotationResponse[]> {
  return request(`/api/v1/quotations?kind=${kind}`, { token });
}

export function createQuotation(
  token: string,
  payload: CreateQuotationRequest,
  idempotencyKey: string,
): Promise<QuotationResponse> {
  return request('/api/v1/quotations', { method: 'POST', token, body: payload, idempotencyKey });
}

/** The shop's logo (§5.8). Resized in the browser before it is sent. */
export function saveInvoiceLogo(
  token: string,
  payload: { mime: string; dataBase64: string },
): Promise<InvoiceSettings> {
  return request('/api/v1/sales/invoice-logo', { method: 'POST', token, body: payload });
}

export function removeInvoiceLogo(token: string): Promise<InvoiceSettings> {
  return request('/api/v1/sales/invoice-logo', { method: 'DELETE', token });
}

/**
 * Parked carts (§5.7, owner decision 2026-08-26).
 *
 * A draft is not a document: it posts nothing, holds no number and is deleted
 * outright once its sale is complete or abandoned.
 */
export function fetchSaleDrafts(token: string): Promise<readonly SaleDraftResponse[]> {
  return request('/api/v1/sales/drafts', { token });
}

export function saveSaleDraft(
  token: string,
  payload: SaveSaleDraftRequest,
): Promise<SaleDraftResponse> {
  return request('/api/v1/sales/drafts', { method: 'POST', token, body: payload });
}

export function deleteSaleDraft(token: string, id: string): Promise<void> {
  return request(`/api/v1/sales/drafts/${id}`, { method: 'DELETE', token });
}
