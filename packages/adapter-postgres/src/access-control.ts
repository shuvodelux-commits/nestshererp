import type { AccessControl, TenantContext, Tx } from '@sher/core-application';
import { AppError, ErrorCode } from '@sher/core-contracts';
import { and, eq, isNull } from 'drizzle-orm';

import { rolePermissions, users } from './schema';
import { txOf } from './unit-of-work';

/**
 * Resolves the acting user's role and asks whether it holds the code (§5.26).
 *
 * Evaluated server-side on every request, never cached in a token and never
 * trusted from a client. Entitlement and feature/setting gating join this chain
 * in Phases 1 and 10; the permission step is what exists today.
 */
export class PostgresAccessControl implements AccessControl {
  async require(tx: Tx, ctx: TenantContext, permissionCode: string): Promise<void> {
    const rows = await txOf(tx)
      .select({ code: rolePermissions.permissionCode })
      .from(users)
      .innerJoin(
        rolePermissions,
        and(
          eq(rolePermissions.roleId, users.roleId),
          eq(rolePermissions.tenantId, users.tenantId),
          isNull(rolePermissions.deletedAt),
        ),
      )
      .where(
        and(
          eq(users.tenantId, ctx.tenantId),
          eq(users.id, ctx.userId),
          isNull(users.deletedAt),
          eq(rolePermissions.permissionCode, permissionCode),
        ),
      )
      .limit(1);

    if (rows.length === 0) {
      throw new AppError(ErrorCode.PERMISSION_DENIED, `Permission required: ${permissionCode}`, {
        permission: permissionCode,
      });
    }
  }
}
