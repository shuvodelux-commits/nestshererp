import type {
  DashboardResponse, MoneyReportResponse, PerformanceResponse, PurchaseReportResponse,
  SalesReportResponse, SetTargetRequest, StockReportResponse, TargetResponse, WhyResponse,
} from '@sher/core-contracts';

import { request } from './client';

/** The four report screens, the drill-down, the target and the dashboard (§5.20). */

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text === '' ? '' : `?${text}`;
}

export interface RangeQuery {
  readonly from: string;
  readonly to: string;
}

export function fetchSalesReport(
  token: string,
  input: RangeQuery & { groupBy: string },
): Promise<SalesReportResponse> {
  return request(`/api/v1/reports/sales${query({ ...input })}`, { token });
}

export function fetchPurchaseReport(
  token: string,
  input: RangeQuery & { groupBy: string },
): Promise<PurchaseReportResponse> {
  return request(`/api/v1/reports/purchases${query({ ...input })}`, { token });
}

export function fetchStockReport(
  token: string,
  input: RangeQuery & { view: string },
): Promise<StockReportResponse> {
  return request(`/api/v1/reports/stock${query({ ...input })}`, { token });
}

export function fetchMoneyReport(
  token: string,
  input: RangeQuery & { view: string },
): Promise<MoneyReportResponse> {
  return request(`/api/v1/reports/money${query({ ...input })}`, { token });
}

export function fetchPerformance(token: string, input: RangeQuery): Promise<PerformanceResponse> {
  return request(`/api/v1/reports/performance${query({ ...input })}`, { token });
}

/** The "Why?" behind one figure — the journal lines or movements under it. */
export function fetchWhy(
  token: string,
  input: RangeQuery & { subject: string; key: string },
): Promise<WhyResponse> {
  return request(`/api/v1/reports/why${query({ ...input })}`, { token });
}

export function fetchTarget(token: string, month: string): Promise<TargetResponse> {
  return request(`/api/v1/reports/target${query({ month })}`, { token });
}

export function saveTarget(token: string, body: SetTargetRequest): Promise<TargetResponse> {
  return request('/api/v1/reports/target', { token, method: 'PUT', body });
}

export function fetchDashboardCards(token: string): Promise<DashboardResponse> {
  return request('/api/v1/dashboard/cards', { token });
}
