import type { TenantContext, Tx } from '@sher/core-application';
import { AppError, ErrorCode } from '@sher/core-contracts';
import { and, eq, isNull } from 'drizzle-orm';

import { categories } from './schema';
import { txOf } from './unit-of-work';

/**
 * MOD-002 P8b2c1: the shared parent-row FOR UPDATE synchronization point for
 * both legacy and bilingual category inserts and legacy removal.
 *
 * All callers must already be inside the tenant UoW, with current permission
 * checked by their application service. PostgreSQL FORCE RLS and the explicit
 * tenant predicate both apply. Never call this from a read-only request.
 *
 * A future category lifecycle status writer MUST lock the parent first, then
 * check children inside the same transaction, using this exact row-lock order.
 * This file does not enable or authorize status changes.
 */
export async function lockEligibleCategoryParent(
  tx: Tx, ctx: TenantContext, parentId: string | null,
): Promise<void> {
  if (parentId === null) return;

  const parent = (await txOf(tx).select({
    parentId: categories.parentId,
    isActive: categories.isActive,
    deletedAt: categories.deletedAt,
  }).from(categories).where(and(
    eq(categories.tenantId, ctx.tenantId),
    eq(categories.id, parentId),
  )).limit(1).for('update'))[0];

  // Foreign tenant IDs are indistinguishable from missing or archived IDs.
  if (!parent || parent.deletedAt !== null) {
    throw new AppError(ErrorCode.NOT_FOUND, 'That parent category was not found');
  }
  if (parent.parentId !== null) {
    throw new AppError(
      ErrorCode.VALIDATION_FAILED,
      'Categories go two levels deep, not three',
    );
  }
  if (!parent.isActive) {
    throw new AppError(
      ErrorCode.VALIDATION_FAILED,
      'Activate the parent category before adding subcategories',
    );
  }
}

/**
 * Lock the category row *before* the final child check. A concurrent child
 * insert is forced to take the same parent lock. This closes the gap between
 * legacy application-level countSubcategories and the later archive/delete.
 *
 * Existing nonarchived child records block removal, even if inactive, exactly
 * like the legacy countSubcategories rule. This guard changes no history.
 */
export async function lockCategoryForRemoval(
  tx: Tx, ctx: TenantContext, id: string,
): Promise<void> {
  const db = txOf(tx);
  const current = (await db.select({
    id: categories.id,
    deletedAt: categories.deletedAt,
  }).from(categories).where(and(
    eq(categories.tenantId, ctx.tenantId),
    eq(categories.id, id),
  )).limit(1).for('update'))[0];

  if (!current || current.deletedAt !== null) {
    throw new AppError(ErrorCode.NOT_FOUND, 'That category was not found');
  }

  // This is a fresh READ COMMITTED snapshot acquired only AFTER the parent
  // lock. A child that committed while we waited is therefore visible.
  const child = (await db.select({ id: categories.id })
    .from(categories)
    .where(and(
      eq(categories.tenantId, ctx.tenantId),
      eq(categories.parentId, id),
      isNull(categories.deletedAt),
    ))
    .limit(1))[0];
  if (child) {
    throw new AppError(
      ErrorCode.VALIDATION_FAILED,
      'This category still has subcategories. Remove them first',
    );
  }
}
