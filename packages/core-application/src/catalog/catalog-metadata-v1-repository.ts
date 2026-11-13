import type {
  CatalogMetadataV1Brand,
  CatalogMetadataV1Category,
  CatalogMetadataV1Unit,
} from '@sher/core-contracts';

import type { TenantContext } from '../ports/tenant-context';
import type { Tx } from '../ports/unit-of-work';

/**
 * MOD-002 T02A metadata-v1 persistence port, not a second catalog writer.
 *
 * A future PostgreSQL adapter must extend the existing catalog ownership,
 * reuse the same tenant-scoped master rows and FORCE-RLS transaction, and
 * satisfy compare-and-set (CAS) atomically at the UPDATE statement.
 *
 * There is deliberately no implementation, DI registration or live route
 * in this source-only application seam.
 */
export interface UnitMetadataPatch {
  readonly nameBn?: string | null;
  readonly symbol?: string | null;
}

export interface NameMetadataPatch {
  readonly nameBn: string | null;
}

export interface CatalogMetadataV1Repository {
  /** Active masters offered for new product selection, scoped by tenant. */
  listUnits(tx: Tx, ctx: TenantContext): Promise<readonly CatalogMetadataV1Unit[]>;
  listBrands(tx: Tx, ctx: TenantContext): Promise<readonly CatalogMetadataV1Brand[]>;
  listCategories(tx: Tx, ctx: TenantContext): Promise<readonly CatalogMetadataV1Category[]>;

  /** Null for missing, archived or another tenant's master, never a foreign row. */
  findUnit(tx: Tx, ctx: TenantContext, id: string): Promise<CatalogMetadataV1Unit | null>;
  findBrand(tx: Tx, ctx: TenantContext, id: string): Promise<CatalogMetadataV1Brand | null>;
  findCategory(tx: Tx, ctx: TenantContext, id: string): Promise<CatalogMetadataV1Category | null>;

  /**
   * UPDATE ... WHERE tenant_id = ctx.tenantId AND id = id
   * AND version = expectedVersion AND deleted_at IS NULL
   * SET ... version = version + 1, updated_at, updated_by
   * RETURNING all metadata columns.
   *
   * In the SQL projection, missing fields must retain their existing values,
   * explicit null clears, and names/conversion factors must not be changed.
   * Return null on a zero-row CAS, never retry or mutate an archived row.
   * The use case will turn a stale CAS into CONFLICT_STALE_VERSION/409.
   */
  compareAndSetUnit(
    tx: Tx, ctx: TenantContext, id: string, expectedVersion: number,
    patch: UnitMetadataPatch,
  ): Promise<CatalogMetadataV1Unit | null>;

  compareAndSetBrand(
    tx: Tx, ctx: TenantContext, id: string, expectedVersion: number,
    patch: NameMetadataPatch,
  ): Promise<CatalogMetadataV1Brand | null>;

  compareAndSetCategory(
    tx: Tx, ctx: TenantContext, id: string, expectedVersion: number,
    patch: NameMetadataPatch,
  ): Promise<CatalogMetadataV1Category | null>;
}
