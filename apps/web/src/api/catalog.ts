import type {
  CatalogResponse,
  CreateCategoryRequest,
  RemoveCatalogEntryResponse,
  SaveBrandRequest,
} from '@sher/core-contracts';

import { request } from './client';

/**
 * What a screen holds before the catalog arrives. Every feature reads false
 * until the server says otherwise — a form that guessed 'on' would flash fields
 * the shop has switched off.
 */
export const EMPTY_CATALOG: CatalogResponse = {
  units: [],
  brands: [],
  categories: [],
  features: {
    productOffers: false,
    expiryTracking: false,
    serialTracking: false,
  warranty: false,
    customerGroups: false,
    vendors: false,
  },
};

/**
 * The catalog vocabulary (§5.5): units of measure, brands, categories.
 *
 * Every write returns the whole catalog, so the screen never has to merge a
 * single row into three lists and hope it matched what the server did.
 */
export function fetchCatalog(token: string): Promise<CatalogResponse> {
  return request('/api/v1/catalog', { token });
}

/** `kind` is the path segment: `units`, `brands` or `categories`. */
export type CatalogKind = 'units' | 'brands' | 'categories';

export function createCatalogEntry(
  token: string,
  kind: CatalogKind,
  payload: SaveBrandRequest | CreateCategoryRequest,
): Promise<CatalogResponse> {
  return request(`/api/v1/catalog/${kind}`, { method: 'POST', token, body: payload });
}

export function renameCatalogEntry(
  token: string,
  kind: CatalogKind,
  id: string,
  name: string,
): Promise<CatalogResponse> {
  return request(`/api/v1/catalog/${kind}/${id}`, { method: 'PATCH', token, body: { name } });
}

export function removeCatalogEntry(
  token: string,
  kind: CatalogKind,
  id: string,
): Promise<RemoveCatalogEntryResponse> {
  return request(`/api/v1/catalog/${kind}/${id}/remove`, { method: 'POST', token });
}
