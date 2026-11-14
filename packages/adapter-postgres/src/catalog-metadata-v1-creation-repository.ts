import type {
  CatalogMetadataV1CreationRepository,
  TenantContext,
  Tx,
} from '@sher/core-application';
import type {
  CatalogMetadataV1Brand,
  CatalogMetadataV1Category,
  CatalogMetadataV1Unit,
} from '@sher/core-contracts';
import type { Clock } from '@sher/shared-utils';

import { rethrowCatalogNameConflict } from './catalog-name-conflict';
import { brands, categories, units } from './schema';
import { txOf } from './unit-of-work';

/**
 * MOD-002 T02A/P4b — one INSERT per new bilingual catalog master.
 *
 * Must be called inside the application's already-open tenant-scoped UoW.
 * Uses existing master tables and the existing tenant uniqueness indexes,
 * with FORCE ROW LEVEL SECURITY as the second protection boundary.
 *
 * DO NOT create a legacy English row and then PATCH its Bengali metadata:
 * an interrupted multi-request workflow could leave a half-created master.
 * Audit/outbox are owned by CreateCatalogMetadataV1Service in the same Tx.
 */
export class PostgresCatalogMetadataV1CreationRepository
  implements CatalogMetadataV1CreationRepository {
  constructor(private readonly clock: Clock) {}

  private stamp(ctx: TenantContext) {
    const now = this.clock.now();
    return {
      tenantId: ctx.tenantId,
      createdAt: now,
      updatedAt: now,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
      version: 1,
    };
  }

  async insertUnit(tx: Tx, ctx: TenantContext, row: CatalogMetadataV1Unit): Promise<void> {
    try {
      await txOf(tx).insert(units).values({
        ...this.stamp(ctx),
        id: row.id,
        name: row.name,
        nameBn: row.nameBn,
        symbol: row.symbol,
      });
    } catch (error) {
      rethrowCatalogNameConflict(error, 'unit');
    }
  }

  async insertBrand(tx: Tx, ctx: TenantContext, row: CatalogMetadataV1Brand): Promise<void> {
    try {
      await txOf(tx).insert(brands).values({
        ...this.stamp(ctx),
        id: row.id,
        name: row.name,
        nameBn: row.nameBn,
      });
    } catch (error) {
      rethrowCatalogNameConflict(error, 'brand');
    }
  }

  async insertCategory(tx: Tx, ctx: TenantContext, row: CatalogMetadataV1Category): Promise<void> {
    try {
      await txOf(tx).insert(categories).values({
        ...this.stamp(ctx),
        id: row.id,
        name: row.name,
        nameBn: row.nameBn,
        parentId: row.parentId,
      });
    } catch (error) {
      rethrowCatalogNameConflict(error, 'category');
    }
  }
}
