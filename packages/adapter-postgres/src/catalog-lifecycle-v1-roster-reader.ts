import type { TenantContext, Tx } from '@sher/core-application';
import { asc, eq } from 'drizzle-orm';

import { brands, categories, units } from './schema';
import { txOf } from './unit-of-work';

/**
 * MOD-002 P8b2b1: read-only, unmounted existing catalog masters.
 *
 * No deleted_at filter: archived entries must remain distinguishable from
 * inactive entries, including names reused by a later replacement. The caller
 * owns the tenant-scoped UoW; PostgreSQL FORCE RLS is an additional boundary.
 * No status change, route, DI provider, downstream selection change or writes.
 */
function lifecycle(row: { isActive: boolean; deletedAt: Date | null }) {
  const state: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED' =
    row.deletedAt !== null ? 'ARCHIVED' : row.isActive ? 'ACTIVE' : 'INACTIVE';
  return {
    state,
    archivedAt: row.deletedAt?.toISOString() ?? null,
  };
}

export class PostgresCatalogLifecycleV1RosterReader {
  async listUnits(tx: Tx, ctx: TenantContext) {
    const rows = await txOf(tx).select({
      id: units.id,
      name: units.name,
      nameBn: units.nameBn,
      symbol: units.symbol,
      version: units.version,
      isActive: units.isActive,
      deletedAt: units.deletedAt,
    }).from(units)
      .where(eq(units.tenantId, ctx.tenantId))
      .orderBy(asc(units.name), asc(units.id));

    return rows.map(row => ({
      id: row.id,
      name: row.name,
      nameBn: row.nameBn,
      symbol: row.symbol,
      version: row.version,
      ...lifecycle(row),
    }));
  }

  async listBrands(tx: Tx, ctx: TenantContext) {
    const rows = await txOf(tx).select({
      id: brands.id,
      name: brands.name,
      nameBn: brands.nameBn,
      version: brands.version,
      isActive: brands.isActive,
      deletedAt: brands.deletedAt,
    }).from(brands)
      .where(eq(brands.tenantId, ctx.tenantId))
      .orderBy(asc(brands.name), asc(brands.id));

    return rows.map(row => ({
      id: row.id,
      name: row.name,
      nameBn: row.nameBn,
      version: row.version,
      ...lifecycle(row),
    }));
  }

  async listCategories(tx: Tx, ctx: TenantContext) {
    const rows = await txOf(tx).select({
      id: categories.id,
      name: categories.name,
      nameBn: categories.nameBn,
      parentId: categories.parentId,
      version: categories.version,
      isActive: categories.isActive,
      deletedAt: categories.deletedAt,
    }).from(categories)
      .where(eq(categories.tenantId, ctx.tenantId))
      .orderBy(asc(categories.name), asc(categories.id));

    return rows.map(row => ({
      id: row.id,
      name: row.name,
      nameBn: row.nameBn,
      parentId: row.parentId,
      version: row.version,
      ...lifecycle(row),
    }));
  }
}
