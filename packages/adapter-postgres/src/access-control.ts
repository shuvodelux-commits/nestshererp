import type {
  AccessControl,
  EntitlementProvider,
  TenantContext,
  Tx,
} from '@sher/core-application';
import {
  AppError,
  ErrorCode,
  licenceIncludes,
  LICENSED_MODULES,
  moduleOwning,
  PERMISSION_CATALOGUE,
} from '@sher/core-contracts';
import type { LicensedModule } from '@sher/core-contracts';
import type { Clock } from '@sher/shared-utils';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { rolePermissions, users } from './schema';
import { txOf } from './unit-of-work';

/**
 * Resolves the acting user's role and asks whether it holds the code (§5.26).
 *
 * Evaluated server-side on every request, never cached in a token and never
 * trusted from a client.
 *
 * **Phase 10 joins the entitlement step to the chain** — `Plan → Feature →
 * Setting → Permission → Access` — and it is one step, here, rather than a
 * check scattered across every module's use case. What the licence excludes is
 * refused with the same shape of answer as what the role excludes, and
 * `permissionsOf` withholds it too, so navigation stops rendering the entry
 * without a second rule having to be written for the screen (UI-09).
 *
 * The rule the owner set on 2026-08-30:
 *
 *   - a module the licence excludes and the shop has **never used** disappears
 *     entirely — read and write both refused, so nothing routes to it;
 *   - a module the licence excludes that **holds this shop's data** stays
 *     readable and refuses only writes, because no state may hide a business's
 *     own records (D-36);
 *   - core modules — selling, buying, stock, money, people, settings, backup —
 *     are not in the registry at all, and no licence can take them away.
 */
export class PostgresAccessControl implements AccessControl {
  constructor(
    private readonly entitlements: EntitlementProvider,
    private readonly clock: Clock,
  ) {}

  async require(tx: Tx, ctx: TenantContext, permissionCode: string): Promise<void> {
    await this.requireEntitlement(tx, ctx, permissionCode);

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

  /**
   * The licence step, run before the role step.
   *
   * Order matters for the message a shopkeeper reads: telling somebody their
   * role is insufficient, when in truth the shop never bought the module, sends
   * them to the owner to be granted a permission that would still not work.
   */
  private async requireEntitlement(
    tx: Tx,
    ctx: TenantContext,
    permissionCode: string,
  ): Promise<void> {
    const module = moduleOwning(permissionCode);
    if (module === null) return;

    const entitlement = this.entitlements.current(this.clock.now());
    if (licenceIncludes(entitlement.modules, module.code)) return;

    if (module.writePermissions.includes(permissionCode)) {
      throw new AppError(
        ErrorCode.PERMISSION_DENIED,
        `Your licence does not include ${module.label}, so nothing new can be saved here. ` +
          'Everything already recorded stays exactly as it is.',
        { module: module.code },
      );
    }

    // A read. Allowed only while the shop has records here to read.
    if (await this.hasData(tx, ctx, module)) return;
    throw new AppError(
      ErrorCode.PERMISSION_DENIED,
      `Your licence does not include ${module.label}.`,
      { module: module.code },
    );
  }

  private async hasData(tx: Tx, ctx: TenantContext, module: LicensedModule): Promise<boolean> {
    for (const table of module.dataTables) {
      // Table names come from this build's own registry, never from a request.
      const result = await txOf(tx).execute(
        sql`SELECT 1 FROM ${sql.identifier(table)} WHERE tenant_id = ${ctx.tenantId} LIMIT 1`,
      );
      if (result.rows.length > 0) return true;
    }
    return false;
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

    const held = rows.map((row) => row.code);

    /*
     * Withheld here as well as refused above, so the sidebar and every screen
     * stop drawing controls the licence would refuse (UI-09: never render a
     * control that will fail). This is a convenience for the client and never
     * an authorisation decision — `require` runs the same rule regardless of
     * what a client believes it holds.
     */
    const entitlement = this.entitlements.current(this.clock.now());
    const withheld = new Set<string>();
    for (const module of LICENSED_MODULES) {
      if (licenceIncludes(entitlement.modules, module.code)) continue;
      for (const code of module.writePermissions) withheld.add(code);
      if (await this.hasData(tx, ctx, module)) continue;
      for (const code of module.readPermissions) withheld.add(code);
    }

    return held.filter((code) => !withheld.has(code));
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
