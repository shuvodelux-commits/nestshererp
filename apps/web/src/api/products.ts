import type {
  GeneratedBarcodeResponse,
  ProductListResponse,
  ProductQuery,
  ProductResponse,
  SaveProductRequest,
  UpdateProductRequest,
} from '@sher/core-contracts';

import { localProducts } from '@sher/adapter-sqlite-wasm';

import { request } from './client';
import { offlineWrite, queueCommand } from '../offline/local-writer';
import { queuedProduct } from '../offline/queued-documents';
import { offlineFallback } from './offline-fallback';

/**
 * Products (§5.5).
 *
 * The list call asks for the whole envelope: §5.26 puts `page` beside `data`,
 * and the summary tiles are counted by the same query as the rows, so a tile can
 * never disagree with the table under it.
 */
export function fetchProducts(token: string, query: ProductQuery): Promise<ProductListResponse> {
  const params = new URLSearchParams();
  if (query.search !== undefined && query.search !== '') params.set('search', query.search);
  if (query.brandId !== undefined) params.set('brandId', query.brandId);
  if (query.categoryId !== undefined) params.set('categoryId', query.categoryId);
  if (query.status !== undefined) params.set('status', query.status);
  if (query.cursor !== undefined) params.set('cursor', query.cursor);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  // UI-46: which header the shopkeeper tapped, and which way.
  if (query.sort !== undefined) params.set('sort', query.sort);
  if (query.direction !== undefined) params.set('direction', query.direction);

  const suffix = params.toString();
  return offlineFallback(
    () =>
      request<ProductListResponse>(`/api/v1/products${suffix === '' ? '' : `?${suffix}`}`, {
        token,
        envelope: true,
      }),
    () => localProducts(query),
  );
}

export function fetchProduct(token: string, id: string): Promise<ProductResponse> {
  return request(`/api/v1/products/${id}`, { token });
}

/**
 * `idempotencyKey` is generated once per user intent and reused on retry
 * (UI-34) — it is the same value the server stores as `operation_id`.
 */
export function createProduct(
  token: string,
  payload: SaveProductRequest,
  idempotencyKey: string,
): Promise<ProductResponse> {
  return offlineWrite(
    () =>
      request<ProductResponse>('/api/v1/products', {
        method: 'POST',
        token,
        body: payload,
        idempotencyKey,
      }),
    async () => {
      // Creating a product never creates stock, offline or on (§10, §5.5):
      // goods enter through a purchase, an opening or an adjustment.
      await queueCommand({ type: 'PRODUCT_CREATE', payload, operationId: idempotencyKey });
      return queuedProduct<ProductResponse>(payload, idempotencyKey);
    },
  );
}

export function updateProduct(
  token: string,
  id: string,
  payload: UpdateProductRequest,
): Promise<ProductResponse> {
  return request(`/api/v1/products/${id}`, { method: 'PATCH', token, body: payload });
}

export function setProductStatus(
  token: string,
  id: string,
  status: 'ACTIVE' | 'INACTIVE',
): Promise<ProductResponse> {
  return request(`/api/v1/products/${id}/status`, { method: 'POST', token, body: { status } });
}

export function generateProductBarcode(
  token: string,
  id: string,
): Promise<GeneratedBarcodeResponse> {
  return request(`/api/v1/products/${id}/barcode`, { method: 'POST', token });
}

export function deleteProduct(token: string, id: string): Promise<void> {
  return request(`/api/v1/products/${id}`, { method: 'DELETE', token });
}

/**
 * A product's picture (§5.5, owner decision 2026-08-25).
 *
 * The bytes are resized in the browser first, so what crosses the wire is a
 * thumbnail rather than a camera original.
 */
export function saveProductImage(
  token: string,
  productId: string,
  payload: { mime: string; dataBase64: string },
): Promise<ProductResponse> {
  return request(`/api/v1/products/${productId}/image`, { method: 'POST', token, body: payload });
}

export function removeProductImage(token: string, productId: string): Promise<ProductResponse> {
  return request(`/api/v1/products/${productId}/image`, { method: 'DELETE', token });
}
