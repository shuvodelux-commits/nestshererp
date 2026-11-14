import type { ImportResultResponse } from '@sher/core-contracts';
import type { ImportType } from '@sher/core-domain';

import type { TenantContext } from '../ports/tenant-context';
import type { Tx } from '../ports/unit-of-work';

/**
 * Permanent import-batch identity; NOT the prunable 30-day IdempotencyStore.
 * Reservation and completion happen within the caller's single UoW transaction.
 * A competing process with the same (tenant, operation) must wait for the
 * first transaction and then return its committed result or a fingerprint conflict.
 */
export type ImportOperationReservation =
  | { readonly state: 'reserved' }
  | {
      readonly state: 'replay';
      readonly requestFingerprint: string;
      readonly response: ImportResultResponse;
    };

export interface ImportOperationStore {
  reserve(
    tx: Tx,
    ctx: TenantContext,
    operationId: string,
    type: ImportType,
    requestFingerprint: string,
  ): Promise<ImportOperationReservation>;

  complete(
    tx: Tx,
    ctx: TenantContext,
    operationId: string,
    response: ImportResultResponse,
  ): Promise<void>;
}
