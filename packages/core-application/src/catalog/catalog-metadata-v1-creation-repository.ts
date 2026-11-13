import type {
  CatalogMetadataV1Brand,
  CatalogMetadataV1Category,
  CatalogMetadataV1Unit,
} from '@sher/core-contracts';

import type { TenantContext } from '../ports/tenant-context';
import type { Tx } from '../ports/unit-of-work';

/**
 * MOD-002 T02A/P4a: a separate, required persistence port for atomic
 * metadata-v1 CREATE operations. The P4b PostgreSQL implementation MUST
 * insert the existing units/brands/categories master row with both its
 * canonical English name and optional metadata in ONE INSERT statement.
 *
 * Do not use a legacy name-only insert followed by a metadata PATCH:
 * even inside a new application service that could create partial writes.
 * The owning use case keeps insert, CREATE audit and outbox in ONE UoW.
 *
 * This port is not wired to Nest or a database in P4a. It does not change
 * the already accepted CatalogMetadataV1Repository read/PATCH interface.
 */
export interface CatalogMetadataV1CreationRepository {
  insertUnit(tx: Tx, ctx: TenantContext, row: CatalogMetadataV1Unit): Promise<void>;
  insertBrand(tx: Tx, ctx: TenantContext, row: CatalogMetadataV1Brand): Promise<void>;
  insertCategory(tx: Tx, ctx: TenantContext, row: CatalogMetadataV1Category): Promise<void>;
}
