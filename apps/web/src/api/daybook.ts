import type {
  DaybookPrint, DaybookPrintRequest, DaybookQuery, DaybookResponse, DayReview,
  MarkDayReviewedRequest,
} from '@sher/core-contracts';

import { request } from './client';

/** Daybook (§5.27). Reads, one review mark, one print record — nothing else. */
export function fetchDaybook(
  token: string,
  input: Partial<DaybookQuery> & { from: string; to: string },
): Promise<DaybookResponse> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  return request(`/api/v1/daybook?${search.toString()}`, { token });
}

export function markDayReviewed(
  token: string,
  body: MarkDayReviewedRequest,
): Promise<DayReview> {
  return request('/api/v1/daybook/review', { token, method: 'POST', body });
}

export function recordDaybookPrint(
  token: string,
  body: DaybookPrintRequest,
): Promise<{ print: DaybookPrint; daybook: DaybookResponse }> {
  return request('/api/v1/daybook/print', { token, method: 'POST', body });
}

export function fetchDaybookPrints(token: string): Promise<readonly DaybookPrint[]> {
  return request('/api/v1/daybook/prints', { token });
}

/**
 * Cancelling a document from a Daybook row (Phase 9.2).
 *
 * **Daybook posts nothing**: each of these is the owning module's own
 * endpoint, checked against that module's own permission (§5.27, DR1). What
 * lives here is only the mapping from a row's kind to the route that owns it,
 * so the screen does not carry a switch statement over URLs.
 */
const VOID_ROUTES: Readonly<Record<string, (id: string) => string>> = {
  SALE: (id) => `/api/v1/sales/${id}/cancel`,
  PURCHASE: (id) => `/api/v1/purchases/${id}/void`,
  EXPENSE: (id) => `/api/v1/expenses/${id}/void`,
  CASH_MOVEMENT: (id) => `/api/v1/money/movements/${id}/void`,
  CUSTOMER_RECEIPT: (id) => `/api/v1/customer-payments/${id}/void`,
  SUPPLIER_PAYMENT: (id) => `/api/v1/suppliers/payments/${id}/void`,
  STOCK_ADJUSTMENT: (id) => `/api/v1/inventory/adjustments/${id}/void`,
  SALES_RETURN: (id) => `/api/v1/sales-returns/${id}/void`,
  PURCHASE_RETURN: (id) => `/api/v1/purchase-returns/${id}/void`,
};

export function canCancelKind(kind: string): boolean {
  return kind in VOID_ROUTES;
}

export async function cancelDocument(
  token: string,
  kind: string,
  sourceId: string,
  version: number,
  reason: string,
): Promise<void> {
  const route = VOID_ROUTES[kind];
  if (route === undefined) throw new Error(`Nothing cancels a ${kind} from here`);
  await request(route(sourceId), { token, method: 'POST', body: { version, reason } });
}
