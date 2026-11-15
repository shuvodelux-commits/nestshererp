import type { TenantContext } from '../ports/tenant-context';
import type { Tx } from '../ports/unit-of-work';

/**
 * MOD-002 P8b2b1: unmounted tenant-scoped catalog lifecycle roster.
 * Archived != inactive. No API, permission grant, status writer or mutation
 * follows from this read port. P8b3 owns live application authorization.
 */
export type CatalogLifecycleV1State = 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';

export interface CatalogLifecycleV1Entry {
  readonly id: string;
  readonly name: string;
  readonly nameBn: string | null;
  readonly version: number;
  readonly state: CatalogLifecycleV1State;
  /** Non-null if and only if state is ARCHIVED. ISO 8601 with offset. */
  readonly archivedAt: string | null;
}
export interface CatalogLifecycleV1UnitEntry extends CatalogLifecycleV1Entry {
  readonly symbol: string | null;
}
export interface CatalogLifecycleV1CategoryEntry extends CatalogLifecycleV1Entry {
  readonly parentId: string | null;
}

export interface CatalogLifecycleV1RosterRepository {
  listUnits(tx: Tx, ctx: TenantContext): Promise<readonly CatalogLifecycleV1UnitEntry[]>;
  listBrands(tx: Tx, ctx: TenantContext): Promise<readonly CatalogLifecycleV1Entry[]>;
  listCategories(tx: Tx, ctx: TenantContext): Promise<readonly CatalogLifecycleV1CategoryEntry[]>;
}
