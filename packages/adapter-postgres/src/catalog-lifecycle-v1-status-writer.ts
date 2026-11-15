import type { TenantContext, Tx } from '@sher/core-application';
import type { Clock } from '@sher/shared-utils';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { brands, units } from './schema';
import { txOf } from './unit-of-work';

type Desired = 'ACTIVE' | 'INACTIVE';
type Result =
  | { outcome: 'CHANGED' | 'UNCHANGED'; state: Desired; version: number }
  | { outcome: 'NOT_FOUND' | 'STALE_VERSION' | 'ARCHIVED' | 'VERSION_OVERFLOW' };
const PG_INT4_MAX = 2_147_483_647;

/**
 * MOD-002 P8b2b2: UNMOUNTED PostgreSQL status persistence; never an API.
 *
 * Each operation runs INSIDE the caller's tenant-scoped UnitOfWork. FOR UPDATE
 * serializes this status writer with existing full-edit UPDATEs. The physical
 * write additionally compares tenant/id/version/current is_active/deleted_at.
 *
 * Deliberately no category writer: legacy category creation must first adopt
 * the same parent-child locking protocol. A future application use case MUST
 * perform the CURRENT permission check, audit and outbox in this transaction
 * before any public activation. This adapter alone confers no authorization.
 */
export class PostgresCatalogLifecycleV1StatusWriter {
  constructor(private readonly clock: Clock) {}

  private preflight(
    row: { version: number; isActive: boolean; deletedAt: Date | null } | undefined,
    expectedVersion: number,
    desiredState: Desired,
  ): Result | null {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new RangeError('Catalog lifecycle version must be a positive safe integer');
    }
    if (desiredState !== 'ACTIVE' && desiredState !== 'INACTIVE') {
      throw new RangeError('Catalog lifecycle desired state must be ACTIVE or INACTIVE');
    }
    if (!row) return { outcome: 'NOT_FOUND' };
    // Keep the P8b1 precedence: a stale same-state/archived request is stale.
    if (row.version !== expectedVersion) return { outcome: 'STALE_VERSION' };
    if (row.deletedAt !== null) return { outcome: 'ARCHIVED' };
    if (row.isActive === (desiredState === 'ACTIVE')) {
      return { outcome: 'UNCHANGED', state: desiredState, version: row.version };
    }
    // PostgreSQL version is int4, not a JavaScript safe integer.
    if (row.version >= PG_INT4_MAX) return { outcome: 'VERSION_OVERFLOW' };
    return null;
  }

  async transitionUnit(
    tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, desiredState: Desired,
  ): Promise<Result> {
    const db = txOf(tx);
    const before = (await db.select({
      version: units.version, isActive: units.isActive, deletedAt: units.deletedAt,
    }).from(units).where(and(
      eq(units.tenantId, ctx.tenantId), eq(units.id, id),
    )).limit(1).for('update'))[0];

    const refusal = this.preflight(before, expectedVersion, desiredState);
    if (refusal) return refusal;
    // The prior FOR UPDATE lock prevents intervening updates in this UoW,
    // and the compare-and-swap WHERE still enforces the full storage contract.
    const updated = await db.update(units).set({
      isActive: desiredState === 'ACTIVE',
      version: sql`${units.version} + 1`,
      updatedAt: this.clock.now(),
      updatedBy: ctx.userId,
    }).where(and(
      eq(units.tenantId, ctx.tenantId), eq(units.id, id),
      eq(units.version, expectedVersion), isNull(units.deletedAt),
      eq(units.isActive, desiredState !== 'ACTIVE'),
    )).returning({ version: units.version });
    if (!updated[0]) return { outcome: 'STALE_VERSION' };
    return { outcome: 'CHANGED', state: desiredState, version: updated[0].version };
  }

  async transitionBrand(
    tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, desiredState: Desired,
  ): Promise<Result> {
    const db = txOf(tx);
    const before = (await db.select({
      version: brands.version, isActive: brands.isActive, deletedAt: brands.deletedAt,
    }).from(brands).where(and(
      eq(brands.tenantId, ctx.tenantId), eq(brands.id, id),
    )).limit(1).for('update'))[0];

    const refusal = this.preflight(before, expectedVersion, desiredState);
    if (refusal) return refusal;
    const updated = await db.update(brands).set({
      isActive: desiredState === 'ACTIVE',
      version: sql`${brands.version} + 1`,
      updatedAt: this.clock.now(),
      updatedBy: ctx.userId,
    }).where(and(
      eq(brands.tenantId, ctx.tenantId), eq(brands.id, id),
      eq(brands.version, expectedVersion), isNull(brands.deletedAt),
      eq(brands.isActive, desiredState !== 'ACTIVE'),
    )).returning({ version: brands.version });
    if (!updated[0]) return { outcome: 'STALE_VERSION' };
    return { outcome: 'CHANGED', state: desiredState, version: updated[0].version };
  }
}
