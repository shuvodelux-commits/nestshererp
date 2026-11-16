import type { TenantContext, Tx } from '@sher/core-application';
import type { Clock } from '@sher/shared-utils';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { categories } from './schema';
import { txOf } from './unit-of-work';

type Desired = 'ACTIVE' | 'INACTIVE';
type Result =
  | { outcome: 'CHANGED' | 'UNCHANGED'; state: Desired; version: number }
  | { outcome: 'NOT_FOUND' | 'STALE_VERSION' | 'ARCHIVED' | 'VERSION_OVERFLOW' |
      'ACTIVE_CHILDREN' | 'PARENT_NOT_ACTIVE' | 'INVALID_CATEGORY_CONTEXT' };
const PG_INT4_MAX = 2_147_483_647;

/**
 * MOD-002 P8b2c2 / #301 — unmounted, tenant-RLS category status CAS.
 *
 * The caller provides an already-authorized tenant UnitOfWork; this storage
 * adapter neither grants permission nor writes audit/outbox. The eventual
 * application service must add permission, audit and outbox in that SAME UoW
 * before any route is mounted. No category creation or archival logic changes.
 *
 * Lock order: the category row is its own parent lock if it is a root.
 * For children, discover immutable parent_id without a write lock, lock the
 * parent FOR UPDATE, then re-read and lock the child FOR UPDATE. This shares
 * the P8b2c1 parent lock with both legacy and bilingual child INSERT paths.
 * All reads and the single versioned UPDATE carry explicit tenant predicates.
 */
export class PostgresCatalogLifecycleV1CategoryStatusWriter {
  constructor(private readonly clock: Clock) {}

  async transitionCategory(
    tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, desiredState: Desired,
  ): Promise<Result> {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new RangeError('Catalog lifecycle version must be a positive safe integer');
    }
    if (desiredState !== 'ACTIVE' && desiredState !== 'INACTIVE') {
      throw new RangeError('Catalog lifecycle desired state must be ACTIVE or INACTIVE');
    }

    const db = txOf(tx);
    // A nonlocking discovery query is safe: the actual decision uses ONLY the
    // later locked version and rechecks immutable parent_id after acquiring it.
    const candidate = (await db.select({ parentId: categories.parentId })
      .from(categories).where(and(
        eq(categories.tenantId, ctx.tenantId),
        eq(categories.id, id),
      )).limit(1))[0];
    if (!candidate) return { outcome: 'NOT_FOUND' };

    let parent: {
      parentId: string | null;
      isActive: boolean;
      deletedAt: Date | null;
    } | undefined;
    if (candidate.parentId !== null) {
      parent = (await db.select({
        parentId: categories.parentId,
        isActive: categories.isActive,
        deletedAt: categories.deletedAt,
      }).from(categories).where(and(
        eq(categories.tenantId, ctx.tenantId),
        eq(categories.id, candidate.parentId),
      )).limit(1).for('update'))[0];
    }

    // Root: lock root first; child: lock parent first, then child.
    const row = (await db.select({
      parentId: categories.parentId,
      version: categories.version,
      isActive: categories.isActive,
      deletedAt: categories.deletedAt,
    }).from(categories).where(and(
      eq(categories.tenantId, ctx.tenantId),
      eq(categories.id, id),
    )).limit(1).for('update'))[0];
    if (!row) return { outcome: 'NOT_FOUND' };
    if (row.parentId !== candidate.parentId) return { outcome: 'STALE_VERSION' };

    // Preserve P8b1 decision order: version > archived > same-state no-op
    // > parent/child eligibility. Never treat stale same-state as idempotent.
    if (row.version !== expectedVersion) return { outcome: 'STALE_VERSION' };
    if (row.deletedAt !== null) return { outcome: 'ARCHIVED' };
    if (row.isActive === (desiredState === 'ACTIVE')) {
      return { outcome: 'UNCHANGED', state: desiredState, version: row.version };
    }
    if (row.version >= PG_INT4_MAX) return { outcome: 'VERSION_OVERFLOW' };

    if (row.parentId !== null) {
      // A nonroot parent violates the existing two-level hierarchy.
      if (parent?.parentId !== null && parent !== undefined) {
        return { outcome: 'INVALID_CATEGORY_CONTEXT' };
      }
      if (desiredState === 'ACTIVE' &&
          (!parent || parent.deletedAt !== null || !parent.isActive)) {
        return { outcome: 'PARENT_NOT_ACTIVE' };
      }
    } else if (desiredState === 'INACTIVE') {
      // Must be a fresh READ COMMITTED snapshot AFTER this root's FOR UPDATE.
      // Both category creation paths lock the same root before insertion.
      const child = (await db.select({ id: categories.id })
        .from(categories).where(and(
          eq(categories.tenantId, ctx.tenantId),
          eq(categories.parentId, id),
          eq(categories.isActive, true),
          isNull(categories.deletedAt),
        )).limit(1))[0];
      if (child) return { outcome: 'ACTIVE_CHILDREN' };
    }

    // Defensive SQL CAS against tenant, version, current status and archive.
    // PostgreSQL int4 overflow was refused before reaching this expression.
    const updated = await db.update(categories).set({
      isActive: desiredState === 'ACTIVE',
      version: sql`${categories.version} + 1`,
      updatedAt: this.clock.now(),
      updatedBy: ctx.userId,
    }).where(and(
      eq(categories.tenantId, ctx.tenantId),
      eq(categories.id, id),
      eq(categories.version, expectedVersion),
      eq(categories.isActive, desiredState !== 'ACTIVE'),
      isNull(categories.deletedAt),
    )).returning({ version: categories.version });
    if (!updated[0]) return { outcome: 'STALE_VERSION' };
    return { outcome: 'CHANGED', state: desiredState, version: updated[0].version };
  }
}
