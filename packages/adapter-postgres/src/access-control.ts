import type {
  AccessControl,
  EntitlementProvider,
  TenantContext,
  Tx,
} from '@sher/core-application';
import { entitlementFor, entitlesModule } from '@sher/core-application';
import {
  AppError,
  ErrorCode,
  LICENSED_MODULES,
  moduleOwning,
  Permission,
  PERMISSION_CATALOGUE,
} from '@sher/core-contracts';
import type { LicensedModule } from '@sher/core-contracts';
import type { Clock } from '@sher/shared-utils';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { rolePermissions, users } from './schema';
import { txOf } from './unit-of-work';

/**
 * The prefix a vendor support principal's `userId` carries (Phase 17, §12).
 *
 * A support session is not a user. It has no row in `users`, no password, no
 * PIN and nothing to leave behind, so the role join below would find nothing
 * and refuse everything — which is why the principal has to be recognised here
 * rather than pretended into the users table. The prefix is set in exactly one
 * place, `apps/api/src/management/support-grant.ts`, and can only get onto a
 * request through a grant this installation has verified against the vendor's
 * pinned public key.
 */
const SUPPORT_PRINCIPAL_PREFIX = 'support:';

function isSupportPrincipal(ctx: TenantContext): boolean {
  return ctx.userId.startsWith(SUPPORT_PRINCIPAL_PREFIX);
}

/**
 * What a support session may never do, whatever else it may (§13 ceiling,
 * owner decision 2026-09-03).
 *
 * The owner deliberately chose **full operational and accounting reach** for
 * vendor support — every correction, reversal, adjustment, setting and
 * document — so this list is short. It is not empty, and the two things on it
 * are the two an audit trail cannot repair:
 *
 *  - **Identity.** Changing a password or PIN, or creating a user, would leave
 *    the vendor able to come back as the shop after the session is over. That
 *    is the permanent backdoor §12 forbids, reached by a different door.
 *  - **Erasure.** Reset Business Data, a restore over live data, and replacing
 *    the backup secret each destroy the evidence of what the session did. A
 *    capability that can erase its own audit trail is not audited.
 *
 * It is the permission half of the ceiling; `SUPPORT_FORBIDDEN_ROUTE_PREFIXES`
 * in the API is the route half. Both exist because a route that forgot to
 * declare a permission would otherwise inherit the ceiling by omission, and a
 * permission checked by a service that has no route would be missed by the edge.
 * They are **not** the same list expressed twice: two of the forbidden acts have
 * no permission code of their own and can only be stopped at the route, which is
 * set out below.
 *
 * **Every entry must be a real code.** Until 2026-09-03 nine of the ten entries
 * here were names that no permission has ever had — `users.create` where the
 * code is `user.account.create`, `settings.reset_business_data` where it is
 * `business.reset` — so `includes` never matched and the whole permission half
 * of the ceiling was inert. `support-ceiling.spec.ts` now holds this list
 * against `PERMISSION_CATALOGUE` so a name that does not exist cannot be
 * mistaken for a control again.
 */
export const SUPPORT_FORBIDDEN_PERMISSIONS: readonly string[] = [
  Permission.USER_CREATE,
  Permission.USER_EDIT,
  Permission.USER_DISABLE,
  Permission.ROLE_MANAGE,
  Permission.BACKUP_RESTORE,
  Permission.BUSINESS_RESET,
];

/*
 * Two acts §13 forbids that have no permission code of their own, and are
 * therefore stopped at the route instead (2026-09-03).
 *
 * **Changing a password or PIN** is self-service: `ChangeCredentialsService`
 * acts on `ctx.userId`, so there is nothing for a role to gate. A support
 * principal has no `users` row, so `findCredentials` returns null and the
 * service refuses it anyway — but that is an accident of the lookup, not a
 * control, so `/api/v1/settings/security` and `/api/v1/auth/password` are
 * named in `SUPPORT_FORBIDDEN_ROUTE_PREFIXES` and that is the control.
 *
 * **Replacing the backup secret** requires `backup.export`, which support
 * legitimately needs in order to take a backup before it changes anything.
 * Refusing the code would refuse the export too, so `/api/v1/backup/secret`
 * is the only place the distinction can be drawn.
 *
 * Listing invented codes for either — which is what this list used to do —
 * looks like protection and is none.
 */

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

    /*
     * Phase 17: the vendor, in a support session (§13).
     *
     * **The licence step above still ran, and still refused.** That order is
     * deliberate: a vendor support session does not entitle a shop to a module
     * it never bought, and pretending otherwise would let support quietly
     * create records the shop cannot afterwards read. Support is about fixing
     * what the shop already has, not about widening what it owns.
     *
     * Below that, the principal holds everything except the identity and
     * erasure codes. Note what this does *not* do: it does not bypass the
     * period guard, the domain rules, the posting engine or the audit writer.
     * The request still goes controller → application service → domain →
     * database exactly as a click at the counter does (§14), and `AuditWriter`
     * stamps `support:<operator>` on every row it writes, so a vendor
     * correction is distinguishable from the owner's own for ever.
     */
    if (isSupportPrincipal(ctx)) {
      if (SUPPORT_FORBIDDEN_PERMISSIONS.includes(permissionCode)) {
        throw new AppError(
          ErrorCode.PERMISSION_DENIED,
          'A support session may not change sign-in details or users, or erase or restore data.',
          { permission: permissionCode },
        );
      }
      return;
    }

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

    /*
     * Judged against *this* business. A licence file belonging to another shop
     * verifies perfectly well and entitles this one to nothing (owner decision
     * 2026-09-02) — the binding is re-checked here rather than trusted from the
     * install screen, because a key file can be copied onto a machine by hand.
     */
    const entitlement = entitlementFor(this.entitlements.current(this.clock.now()), ctx.tenantId);
    if (entitlesModule(entitlement, module.code)) return;

    const holdsData = await this.hasData(tx, ctx, module);

    /*
     * Finishing something the shop is already holding — handing back a vendor's
     * goods, closing a claim taken in over the counter. A lapsed licence stops
     * new business; it must not strand somebody else's property on the shelf
     * (owner decision 2026-09-02). Checked before the write refusal, because
     * these codes are write codes.
     */
    if (holdsData && module.unwindPermissions.includes(permissionCode)) return;

    if (module.writePermissions.includes(permissionCode)) {
      throw new AppError(
        ErrorCode.PERMISSION_DENIED,
        `Your licence does not include ${module.label}, so nothing new can be saved here. ` +
          'Everything already recorded stays exactly as it is.',
        { module: module.code },
      );
    }

    // A read. Allowed only while the shop has records here to read.
    if (holdsData) return;
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
    /*
     * A support session's own permission list, so the screens the operator sees
     * render their controls (UI-09: never draw a control that will fail).
     *
     * Built from the same catalogue and filtered by the same two rules as
     * `require` — the forbidden list, and then the licence withholding below —
     * so what the screen offers and what the server allows cannot drift apart.
     */
    if (isSupportPrincipal(ctx)) {
      return this.withheldFiltered(
        tx,
        ctx,
        PERMISSION_CATALOGUE.map((entry) => entry.code).filter(
          (code) => !SUPPORT_FORBIDDEN_PERMISSIONS.includes(code),
        ),
      );
    }

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

    return this.withheldFiltered(tx, ctx, rows.map((row) => row.code));
  }

  /**
   * Removes the codes this shop's licence withholds from a list of held codes.
   *
   * Split out so the ordinary user path and the support path apply exactly the
   * same licence rule — a second copy of it would be a second thing to get
   * wrong, and the one that drifted would be the one nobody was watching.
   */
  private async withheldFiltered(
    tx: Tx,
    ctx: TenantContext,
    held: readonly string[],
  ): Promise<readonly string[]> {
    /*
     * Withheld here as well as refused above, so the sidebar and every screen
     * stop drawing controls the licence would refuse (UI-09: never render a
     * control that will fail). This is a convenience for the client and never
     * an authorisation decision — `require` runs the same rule regardless of
     * what a client believes it holds.
     */
    const entitlement = entitlementFor(this.entitlements.current(this.clock.now()), ctx.tenantId);
    const withheld = new Set<string>();
    for (const module of LICENSED_MODULES) {
      if (entitlesModule(entitlement, module.code)) continue;
      for (const code of module.writePermissions) withheld.add(code);
      const holdsData = await this.hasData(tx, ctx, module);
      // The unwind path stays offered while there is something to unwind, or
      // the screen would hide the only button that can hand a vendor's goods
      // back — and `require` would have allowed it.
      if (holdsData) {
        for (const code of module.unwindPermissions) withheld.delete(code);
        continue;
      }
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
