import type { AccessControl, TenantContext, Tx } from '@sher/core-application';
import { AppError, ErrorCode, PERMISSION_CATALOGUE } from '@sher/core-contracts';
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
      // The message is for the shopkeeper reading it; the code goes in `details`
      // for the support call. Naming the raw permission in the message is
      // developer text on a customer's screen (UI-28 keeps the *error* code
      // visible, which is a different thing).
      throw new AppError(ErrorCode.PERMISSION_DENIED, refusalFor(permissionCode), {
        permission: permissionCode,
      });
    }
  }

  async permissionsOf(tx: Tx, ctx: TenantContext): Promise<readonly string[]> {
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
        and(eq(users.tenantId, ctx.tenantId), eq(users.id, ctx.userId), isNull(users.deletedAt)),
      );

    return rows.map((row) => row.code);
  }
}

/**
 * A sentence a shop owner can act on, built from the catalogue that already
 * names every permission for the roles screen — so a new code cannot arrive
 * without a readable refusal, and the two can never describe it differently.
 */
function refusalFor(permissionCode: string): string {
  const known = PERMISSION_CATALOGUE.find((entry) => entry.code === permissionCode);
  return known === undefined
    ? 'You do not have permission to do that. Ask the business owner.'
    : `You do not have permission to ${lowerFirst(known.label)}. Ask the business owner.`;
}

function lowerFirst(label: string): string {
  return label.charAt(0).toLowerCase() + label.slice(1);
}
