import type {
  CreateSalesReturnRequest,
  ReturnableInvoiceResponse,
  SalesReturnListResponse,
  SalesReturnResponse,
} from '@sher/core-contracts';

import { request } from './client';
import { localBusinessDate, offlineWrite, queueCommand } from '../offline/local-writer';
import { queuedDocument } from '../offline/queued-documents';

/**
 * Customer returns (§5.11).
 *
 * `idempotencyKey` is generated once when the modal opens and reused on retry
 * (UI-34): two taps of Take Return are one return, not two, and the second tap
 * gets the first one's answer back.
 */
export function fetchReturnableInvoice(
  token: string,
  saleId: string,
): Promise<ReturnableInvoiceResponse> {
  return request(`/api/v1/sales-returns/returnable/${saleId}`, { token });
}

export function createSalesReturn(
  token: string,
  payload: CreateSalesReturnRequest,
  idempotencyKey: string,
): Promise<SalesReturnResponse> {
  return offlineWrite(
    () =>
      request<SalesReturnResponse>('/api/v1/sales-returns', {
        method: 'POST',
        token,
        body: payload,
        idempotencyKey,
      }),
    async () => {
      await queueCommand({
        type: 'SALES_RETURN_CREATE',
        payload,
        operationId: idempotencyKey,
        ...(payload.businessDate === undefined ? {} : { businessDate: payload.businessDate }),
      });
      return queuedDocument<SalesReturnResponse>(
        idempotencyKey,
        payload.businessDate ?? localBusinessDate(),
        payload.refundMinor,
      );
    },
  );
}

export interface SalesReturnQuery {
  readonly search?: string;
  readonly partyId?: string;
  readonly fromDate?: string;
  readonly toDate?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export function fetchSalesReturns(
  token: string,
  query: SalesReturnQuery = {},
): Promise<SalesReturnListResponse> {
  const params = new URLSearchParams();
  if (query.search !== undefined && query.search !== '') params.set('search', query.search);
  if (query.partyId !== undefined) params.set('partyId', query.partyId);
  if (query.fromDate !== undefined) params.set('fromDate', query.fromDate);
  if (query.toDate !== undefined) params.set('toDate', query.toDate);
  if (query.cursor !== undefined) params.set('cursor', query.cursor);
  if (query.limit !== undefined) params.set('limit', String(query.limit));

  const suffix = params.toString();
  return request(`/api/v1/sales-returns${suffix === '' ? '' : `?${suffix}`}`, {
    token,
    envelope: true,
  });
}
