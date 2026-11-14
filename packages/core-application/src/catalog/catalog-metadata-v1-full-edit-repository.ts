import type {
  CatalogMetadataV1Unit, CatalogMetadataV1Brand, CatalogMetadataV1Category,
} from '@sher/core-contracts';
import type { TenantContext } from '../ports/tenant-context';
import type { Tx } from '../ports/unit-of-work';

/** MOD-002 P6b: one atomic full-row CAS on the EXISTING catalog master row.
 * The P6c PostgreSQL adapter must implement one UPDATE ... WHERE tenant_id,
 * id, version and deleted_at IS NULL; return null on zero rows. Existing
 * PostgreSQL unique indexes arbitrate concurrent same-name writers.
 * Omitted optional metadata preserves its current stored value; null clears.
 * This port is deliberately not implemented or wired to HTTP by P6b.
 */
export interface CatalogFullEditName {
  readonly name: string;
  readonly nameBn?: string | null;
}
export interface CatalogFullEditUnit extends CatalogFullEditName {
  readonly symbol?: string | null;
}

export interface CatalogMetadataV1FullEditRepository {
  compareAndSetUnit(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number,
    edit: CatalogFullEditUnit): Promise<CatalogMetadataV1Unit | null>;
  compareAndSetBrand(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number,
    edit: CatalogFullEditName): Promise<CatalogMetadataV1Brand | null>;
  compareAndSetCategory(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number,
    edit: CatalogFullEditName): Promise<CatalogMetadataV1Category | null>;
}
