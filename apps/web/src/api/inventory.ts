import type {
  AdjustStockRequest, CostAdjustmentRow, InventoryLotPage, InventoryLotsQuery,
  InventoryOverviewResponse, InventoryReportQuery, InventoryValuationResponse,
  OpeningStockResponse, RecordOpeningStockRequest, StockAdjustmentResponse, StockAdjustmentRow,
} from '@sher/core-contracts';

import { request } from './client';

export function recordOpeningStock(token: string, payload: RecordOpeningStockRequest, idempotencyKey: string): Promise<OpeningStockResponse> {
  return request('/api/v1/inventory/openings', { method: 'POST', token, body: payload, idempotencyKey });
}

export function fetchOpeningStock(token: string, id: string): Promise<OpeningStockResponse> {
  return request(`/api/v1/inventory/openings/${id}`, { token });
}

/**
 * Correct one product's stock (§5.10). `idempotencyKey` is generated once per
 * user intent and reused on retry (UI-34) — it becomes the permanent
 * `operation_id`, so a double-tap cannot write the damage off twice.
 */
export function adjustStock(token: string, payload: AdjustStockRequest, idempotencyKey: string): Promise<StockAdjustmentResponse> {
  return request('/api/v1/inventory/adjustments', { method: 'POST', token, body: payload, idempotencyKey });
}

function reportParams(query: Partial<InventoryReportQuery>): string {
  const params = new URLSearchParams();
  if (query.fromDate !== undefined && query.fromDate !== '') params.set('fromDate', query.fromDate);
  if (query.toDate !== undefined && query.toDate !== '') params.set('toDate', query.toDate);
  if (query.productId !== undefined && query.productId !== '') params.set('productId', query.productId);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  const suffix = params.toString();
  return suffix === '' ? '' : `?${suffix}`;
}

export function fetchInventory(token: string, query: Partial<InventoryReportQuery> = {}): Promise<InventoryOverviewResponse> {
  return request(`/api/v1/inventory${reportParams(query)}`, { token });
}

export function fetchStockAdjustments(token: string, query: Partial<InventoryReportQuery> = {}): Promise<readonly StockAdjustmentRow[]> {
  return request(`/api/v1/inventory/adjustments${reportParams(query)}`, { token });
}

export function fetchCostAdjustments(token: string, query: Partial<InventoryReportQuery> = {}): Promise<readonly CostAdjustmentRow[]> {
  return request(`/api/v1/inventory/cost-adjustments${reportParams(query)}`, { token });
}

/**
 * `productId` is optional: the Lots dialog on a product row passes it, the
 * Inventory Report's cross-product lot and expiry sections leave it out.
 */
export function fetchInventoryLots(token: string, query: InventoryLotsQuery): Promise<InventoryLotPage> {
  const params = new URLSearchParams({
    limit: String(query.limit),
    sort: query.sort,
    direction: query.direction,
  });
  if (query.productId !== undefined) params.set('productId', query.productId);
  if (query.expiringOnly === true) params.set('expiringOnly', 'true');
  if (query.status !== undefined) params.set('status', query.status);
  if (query.cursor !== undefined) params.set('cursor', query.cursor);
  return request(`/api/v1/inventory/lots?${params.toString()}`, { token });
}

export function fetchInventoryValuation(token: string): Promise<InventoryValuationResponse> {
  return request('/api/v1/inventory/valuation', { token });
}
