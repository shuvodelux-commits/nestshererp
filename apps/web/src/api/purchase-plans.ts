import type {
  AddLandedCostRequest,
  DecidePlanRequest,
  CreatePurchasePlanRequest,
  LandedCostResponse,
  PlannerQuery,
  PlannerResponse,
  PurchasePlanListQuery,
  PurchasePlanListResponse,
  PurchasePlanResponse,
  SupplierOrderListResponse,
  SupplierPurchaseOrderResponse,
  UpdatePurchasePlanRequest,
} from '@sher/core-contracts';

import { request } from './client';

/**
 * The Purchase Planner, its saved plans and the supplier's copy (§5.9, §5.12).
 *
 * **No `idempotencyKey` on the plan calls.** A plan posts no stock, no payable
 * and no journal entry, so there is nothing to make replay-safe — unlike
 * `addLandedCost` below, which moves money and takes a key like every other
 * financial write.
 */
export function fetchPlannerSuggestions(
  token: string,
  query: Partial<PlannerQuery> = {},
): Promise<PlannerResponse> {
  const params = new URLSearchParams();
  if (query.lookBackDays !== undefined) params.set('lookBackDays', String(query.lookBackDays));
  if (query.coverDays !== undefined) params.set('coverDays', String(query.coverDays));
  if (query.budgetMinor !== undefined) params.set('budgetMinor', String(query.budgetMinor));
  if (query.supplierPartyId !== undefined) params.set('supplierPartyId', query.supplierPartyId);
  if (query.search !== undefined && query.search !== '') params.set('search', query.search);
  if (query.needsOnly === true) params.set('needsOnly', 'true');
  if (query.limit !== undefined) params.set('limit', String(query.limit));

  const suffix = params.toString();
  return request(`/api/v1/purchase-plans/suggestions${suffix === '' ? '' : `?${suffix}`}`, {
    token,
    envelope: true,
  });
}

export function fetchPurchasePlans(
  token: string,
  query: Partial<PurchasePlanListQuery> = {},
): Promise<PurchasePlanListResponse> {
  const params = new URLSearchParams();
  if (query.status !== undefined) params.set('status', query.status);
  if (query.limit !== undefined) params.set('limit', String(query.limit));

  const suffix = params.toString();
  return request(`/api/v1/purchase-plans${suffix === '' ? '' : `?${suffix}`}`, {
    token,
    envelope: true,
  });
}

export function fetchPurchasePlan(token: string, id: string): Promise<PurchasePlanResponse> {
  return request(`/api/v1/purchase-plans/${id}`, { token });
}

export function createPurchasePlan(
  token: string,
  payload: CreatePurchasePlanRequest,
): Promise<PurchasePlanResponse> {
  return request('/api/v1/purchase-plans', { method: 'POST', token, body: payload });
}

export function updatePurchasePlan(
  token: string,
  id: string,
  payload: UpdatePurchasePlanRequest,
): Promise<PurchasePlanResponse> {
  return request(`/api/v1/purchase-plans/${id}`, { method: 'POST', token, body: payload });
}

/**
 * Agree a plan, or turn it down.
 *
 * Approving is what creates the supplier orders — there is no send call,
 * because nothing is transmitted: an order is printed, saved as a PDF or
 * shared as an image.
 */
export function decidePurchasePlan(
  token: string,
  id: string,
  payload: DecidePlanRequest,
): Promise<PurchasePlanResponse> {
  return request(`/api/v1/purchase-plans/${id}/decide`, { method: 'POST', token, body: payload });
}

/** Only a draft can go; an approved plan has orders against it. */
export function deletePurchasePlan(token: string, id: string, version: number): Promise<void> {
  return request(`/api/v1/purchase-plans/${id}/delete`, {
    method: 'POST',
    token,
    body: { version },
  });
}

export function fetchSupplierOrders(
  token: string,
  status?: string,
): Promise<SupplierOrderListResponse> {
  const params = new URLSearchParams();
  if (status !== undefined && status !== '') params.set('status', status);
  const suffix = params.toString();
  return request(`/api/v1/supplier-orders${suffix === '' ? '' : `?${suffix}`}`, {
    token,
    envelope: true,
  });
}

export function fetchSupplierOrder(
  token: string,
  id: string,
): Promise<SupplierPurchaseOrderResponse> {
  return request(`/api/v1/supplier-orders/${id}`, { token });
}

/** A cost that turned up after the goods (§5.12). This one posts money. */
export function addLandedCost(
  token: string,
  purchaseId: string,
  payload: AddLandedCostRequest,
  idempotencyKey: string,
): Promise<LandedCostResponse> {
  return request(`/api/v1/purchases/${purchaseId}/landed-costs`, {
    method: 'POST',
    token,
    body: payload,
    idempotencyKey,
  });
}
