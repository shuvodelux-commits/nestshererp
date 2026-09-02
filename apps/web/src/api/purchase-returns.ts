import type {
  CreatePurchaseReturnRequest,
  PurchaseReturnListResponse,
  PurchaseReturnResponse,
  ReturnableBillResponse,
} from '@sher/core-contracts';

import { request } from './client';
import { localBusinessDate, offlineWrite, queueCommand } from '../offline/local-writer';
import { queuedDocument } from '../offline/queued-documents';

/**
 * Supplier returns (§5.11) — the mirror of `returns.ts`.
 *
 * `idempotencyKey` is generated once when the modal opens and reused on retry
 * (UI-34), so two taps of Send Back are one return.
 */
export function fetchReturnableBill(
  token: string,
  purchaseId: string,
): Promise<ReturnableBillResponse> {
  return request(`/api/v1/purchase-returns/returnable/${purchaseId}`, { token });
}

export function createPurchaseReturn(
  token: string,
  payload: CreatePurchaseReturnRequest,
  idempotencyKey: string,
): Promise<PurchaseReturnResponse> {
  return offlineWrite(
    () =>
      request<PurchaseReturnResponse>('/api/v1/purchase-returns', {
        method: 'POST',
        token,
        body: payload,
        idempotencyKey,
      }),
    async () => {
      await queueCommand({
        type: 'PURCHASE_RETURN_CREATE',
        payload,
        operationId: idempotencyKey,
        ...(payload.businessDate === undefined ? {} : { businessDate: payload.businessDate }),
      });
      return queuedDocument<PurchaseReturnResponse>(
        idempotencyKey,
        payload.businessDate ?? localBusinessDate(),
        payload.receivedMinor,
      );
    },
  );
}

export interface PurchaseReturnQuery {
  readonly search?: string;
  readonly supplierPartyId?: string;
  readonly fromDate?: string;
  readonly toDate?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export function fetchPurchaseReturns(
  token: string,
  query: PurchaseReturnQuery = {},
): Promise<PurchaseReturnListResponse> {
  const params = new URLSearchParams();
  if (query.search !== undefined && query.search !== '') params.set('search', query.search);
  if (query.supplierPartyId !== undefined) params.set('supplierPartyId', query.supplierPartyId);
  if (query.fromDate !== undefined) params.set('fromDate', query.fromDate);
  if (query.toDate !== undefined) params.set('toDate', query.toDate);
  if (query.cursor !== undefined) params.set('cursor', query.cursor);
  if (query.limit !== undefined) params.set('limit', String(query.limit));

  const suffix = params.toString();
  return request(`/api/v1/purchase-returns${suffix === '' ? '' : `?${suffix}`}`, {
    token,
    envelope: true,
  });
}
