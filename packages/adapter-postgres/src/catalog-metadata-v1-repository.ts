import type {
  CatalogMetadataV1Repository,
  NameMetadataPatch,
  UnitMetadataPatch,
  TenantContext,
  Tx,
} from '@sher/core-application';
import type {
  CatalogMetadataV1Unit,
  CatalogMetadataV1Brand,
  CatalogMetadataV1Category,
} from '@sher/core-contracts';
import type { Clock } from '@sher/shared-utils';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';

import { brands, categories, units } from './schema';
import { txOf } from './unit-of-work';

/**
 * Additive MOD-002 metadata projection over the EXISTING catalog master rows.
 *
 * As with PostgresCatalogRepository, every SELECT and UPDATE is tenant-filtered
 * inside the caller's PostgresUnitOfWork transaction (SET LOCAL app.tenant_id).
 * FORCE RLS is the second guard. The adapter deliberately neither opens a
 * transaction nor handles audit/outbox: the application use case owns those.
 */
export class PostgresCatalogMetadataV1Repository implements CatalogMetadataV1Repository {
  constructor(private readonly clock: Clock) {}

  async listUnits(tx: Tx, ctx: TenantContext): Promise<readonly CatalogMetadataV1Unit[]> {
    return txOf(tx)
      .select({
        id: units.id,
        name: units.name,
        nameBn: units.nameBn,
        symbol: units.symbol,
        version: units.version,
      })
      .from(units)
      .where(and(eq(units.tenantId, ctx.tenantId), isNull(units.deletedAt)))
      .orderBy(asc(units.name));
  }

  async listBrands(tx: Tx, ctx: TenantContext): Promise<readonly CatalogMetadataV1Brand[]> {
    return txOf(tx)
      .select({
        id: brands.id,
        name: brands.name,
        nameBn: brands.nameBn,
        version: brands.version,
      })
      .from(brands)
      .where(and(eq(brands.tenantId, ctx.tenantId), isNull(brands.deletedAt)))
      .orderBy(asc(brands.name));
  }

  async listCategories(tx: Tx, ctx: TenantContext): Promise<readonly CatalogMetadataV1Category[]> {
    return txOf(tx)
      .select({
        id: categories.id,
        name: categories.name,
        nameBn: categories.nameBn,
        parentId: categories.parentId,
        version: categories.version,
      })
      .from(categories)
      .where(and(eq(categories.tenantId, ctx.tenantId), isNull(categories.deletedAt)))
      .orderBy(asc(categories.name));
  }

  async findUnit(
    tx: Tx, ctx: TenantContext, id: string,
  ): Promise<CatalogMetadataV1Unit | null> {
    const rows = await txOf(tx)
      .select({
        id: units.id,
        name: units.name,
        nameBn: units.nameBn,
        symbol: units.symbol,
        version: units.version,
      })
      .from(units)
      .where(and(eq(units.tenantId, ctx.tenantId), eq(units.id, id), isNull(units.deletedAt)))
      .limit(1);
    return rows[0] ?? null;
  }

  async findBrand(
    tx: Tx, ctx: TenantContext, id: string,
  ): Promise<CatalogMetadataV1Brand | null> {
    const rows = await txOf(tx)
      .select({
        id: brands.id,
        name: brands.name,
        nameBn: brands.nameBn,
        version: brands.version,
      })
      .from(brands)
      .where(and(eq(brands.tenantId, ctx.tenantId), eq(brands.id, id), isNull(brands.deletedAt)))
      .limit(1);
    return rows[0] ?? null;
  }

  async findCategory(
    tx: Tx, ctx: TenantContext, id: string,
  ): Promise<CatalogMetadataV1Category | null> {
    const rows = await txOf(tx)
      .select({
        id: categories.id,
        name: categories.name,
        nameBn: categories.nameBn,
        parentId: categories.parentId,
        version: categories.version,
      })
      .from(categories)
      .where(and(eq(categories.tenantId, ctx.tenantId), eq(categories.id, id),
        isNull(categories.deletedAt)))
      .limit(1);
    return rows[0] ?? null;
  }

  async compareAndSetUnit(
    tx: Tx,
    ctx: TenantContext,
    id: string,
    expectedVersion: number,
    patch: UnitMetadataPatch,
  ): Promise<CatalogMetadataV1Unit | null> {
    const rows = await txOf(tx)
      .update(units)
      .set({
        ...('nameBn' in patch ? { nameBn: patch.nameBn } : {}),
        ...('symbol' in patch ? { symbol: patch.symbol } : {}),
        updatedAt: this.clock.now(),
        updatedBy: ctx.userId,
        version: sql`${units.version} + 1`,
      })
      .where(and(
        eq(units.tenantId, ctx.tenantId),
        eq(units.id, id),
        eq(units.version, expectedVersion),
        isNull(units.deletedAt),
      ))
      .returning({
        id: units.id,
        name: units.name,
        nameBn: units.nameBn,
        symbol: units.symbol,
        version: units.version,
      });
    return rows[0] ?? null;
  }

  async compareAndSetBrand(
    tx: Tx,
    ctx: TenantContext,
    id: string,
    expectedVersion: number,
    patch: NameMetadataPatch,
  ): Promise<CatalogMetadataV1Brand | null> {
    const rows = await txOf(tx)
      .update(brands)
      .set({
        nameBn: patch.nameBn,
        updatedAt: this.clock.now(),
        updatedBy: ctx.userId,
        version: sql`${brands.version} + 1`,
      })
      .where(and(
        eq(brands.tenantId, ctx.tenantId),
        eq(brands.id, id),
        eq(brands.version, expectedVersion),
        isNull(brands.deletedAt),
      ))
      .returning({
        id: brands.id,
        name: brands.name,
        nameBn: brands.nameBn,
        version: brands.version,
      });
    return rows[0] ?? null;
  }

  async compareAndSetCategory(
    tx: Tx,
    ctx: TenantContext,
    id: string,
    expectedVersion: number,
    patch: NameMetadataPatch,
  ): Promise<CatalogMetadataV1Category | null> {
    const rows = await txOf(tx)
      .update(categories)
      .set({
        nameBn: patch.nameBn,
        updatedAt: this.clock.now(),
        updatedBy: ctx.userId,
        version: sql`${categories.version} + 1`,
      })
      .where(and(
        eq(categories.tenantId, ctx.tenantId),
        eq(categories.id, id),
        eq(categories.version, expectedVersion),
        isNull(categories.deletedAt),
      ))
      .returning({
        id: categories.id,
        name: categories.name,
        nameBn: categories.nameBn,
        parentId: categories.parentId,
        version: categories.version,
      });
    return rows[0] ?? null;
  }
}
