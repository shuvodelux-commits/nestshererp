import type { PostStockCountRequest, StockCountResponse } from '@sher/core-contracts';

import { request } from './client';

/**
 * Counting the shelf (§5.13).
 *
 * `idempotencyKey` is generated once when the sheet is opened and reused on
 * retry, so a slow post that is tapped twice is one count, not two.
 */
export function fetchStockCounts(token: string, limit = 20): Promise<readonly StockCountResponse[]> {
  return request(`/api/v1/stock-counts?limit=${String(limit)}`, { token });
}

export function postStockCount(
  token: string,
  payload: PostStockCountRequest,
  idempotencyKey: string,
): Promise<StockCountResponse> {
  return request('/api/v1/stock-counts', { method: 'POST', token, body: payload, idempotencyKey });
}
