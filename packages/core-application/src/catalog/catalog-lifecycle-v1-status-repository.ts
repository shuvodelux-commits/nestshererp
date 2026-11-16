import type { TenantContext } from '../ports/tenant-context';
import type { Tx } from '../ports/unit-of-work';

/**
 * MOD-002 P8b2b2 — NOT mounted or exported: persistence seam for reversible
 * unit/brand ACTIVE/INACTIVE. Requires a future authorized application use case
 * with a current-transaction permission check and atomic audit/outbox before
 * this can ever be called from an HTTP request.
 *
 * Category lifecycle intentionally absent until legacy category creation and
 * parent/child locking follow the same synchronization protocol.
 */
export type CatalogLifecycleV1DesiredState = 'ACTIVE' | 'INACTIVE';
export type CatalogLifecycleV1StatusResult =
  | Readonly<{ outcome: 'CHANGED' | 'UNCHANGED'; state: CatalogLifecycleV1DesiredState; version: number }>
  | Readonly<{ outcome: 'NOT_FOUND' | 'STALE_VERSION' | 'ARCHIVED' | 'VERSION_OVERFLOW' }>;

export interface CatalogLifecycleV1StatusRepository {
  transitionUnit(
    tx: Tx, ctx: TenantContext, id: string, expectedVersion: number,
    desiredState: CatalogLifecycleV1DesiredState,
  ): Promise<CatalogLifecycleV1StatusResult>;
  transitionBrand(
    tx: Tx, ctx: TenantContext, id: string, expectedVersion: number,
    desiredState: CatalogLifecycleV1DesiredState,
  ): Promise<CatalogLifecycleV1StatusResult>;
}
