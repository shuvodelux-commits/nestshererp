import type {
  CatalogFullEditName,
  CatalogFullEditUnit,
  CatalogMetadataV1FullEditRepository,
  TenantContext,
  Tx,
} from '@sher/core-application';
import type {
  CatalogMetadataV1Brand,
  CatalogMetadataV1Category,
  CatalogMetadataV1Unit,
} from '@sher/core-contracts';
import type { Clock } from '@sher/shared-utils';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { rethrowCatalogNameConflict } from './catalog-name-conflict';
import { brands, categories, units } from './schema';
import { txOf } from './unit-of-work';

/**
 * MOD-002 P6c: full English+Bengali edit on existing master rows.
 * Exactly one version-checked PostgreSQL UPDATE per request. The application
 * use case owns the transaction, live permissions, audit and outbox.
 *
 * Tenant RLS and explicit tenant_id WHERE both apply. Absent metadata fields
 * preserve stored values; explicit null clears them. Existing unique indexes
 * arbitrate parallel writers after the application preflight.
 */
export class PostgresCatalogMetadataV1FullEditRepository
  implements CatalogMetadataV1FullEditRepository {
  constructor(private readonly clock: Clock) {}

  async compareAndSetUnit(
    tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, edit: CatalogFullEditUnit,
  ): Promise<CatalogMetadataV1Unit | null> {
    try {
      const rows = await txOf(tx)
        .update(units)
        .set({
          name: edit.name,
          ...('nameBn' in edit ? { nameBn: edit.nameBn } : {}),
          ...('symbol' in edit ? { symbol: edit.symbol } : {}),
          updatedAt: this.clock.now(),
          updatedBy: ctx.userId,
          version: sql.raw('"version" + 1'),
        })
        .where(and(
          eq(units.tenantId, ctx.tenantId), eq(units.id, id),
          eq(units.version, expectedVersion), isNull(units.deletedAt),
        ))
        .returning({
          id: units.id, name: units.name, nameBn: units.nameBn,
          symbol: units.symbol, version: units.version,
        });
      return rows[0] ?? null;
    } catch (error) {
      rethrowCatalogNameConflict(error, 'unit');
    }
  }

  async compareAndSetBrand(
    tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, edit: CatalogFullEditName,
  ): Promise<CatalogMetadataV1Brand | null> {
    try {
      const rows = await txOf(tx)
        .update(brands)
        .set({
          name: edit.name,
          ...('nameBn' in edit ? { nameBn: edit.nameBn } : {}),
          updatedAt: this.clock.now(),
          updatedBy: ctx.userId,
          version: sql.raw('"version" + 1'),
        })
        .where(and(
          eq(brands.tenantId, ctx.tenantId), eq(brands.id, id),
          eq(brands.version, expectedVersion), isNull(brands.deletedAt),
        ))
        .returning({
          id: brands.id, name: brands.name, nameBn: brands.nameBn,
          version: brands.version,
        });
      return rows[0] ?? null;
    } catch (error) {
      rethrowCatalogNameConflict(error, 'brand');
    }
  }

  async compareAndSetCategory(
    tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, edit: CatalogFullEditName,
  ): Promise<CatalogMetadataV1Category | null> {
    try {
      const rows = await txOf(tx)
        .update(categories)
        .set({
          name: edit.name,
          ...('nameBn' in edit ? { nameBn: edit.nameBn } : {}),
          updatedAt: this.clock.now(),
          updatedBy: ctx.userId,
          version: sql.raw('"version" + 1'),
        })
        .where(and(
          eq(categories.tenantId, ctx.tenantId), eq(categories.id, id),
          eq(categories.version, expectedVersion), isNull(categories.deletedAt),
        ))
        .returning({
          id: categories.id, name: categories.name, nameBn: categories.nameBn,
          parentId: categories.parentId, version: categories.version,
        });
      return rows[0] ?? null;
    } catch (error) {
      rethrowCatalogNameConflict(error, 'category');
    }
  }
}
