import type {
  IdentifierOwner,
  NewRole,
  NewTenant,
  NewUser,
  RoleDetail,
  RoleRepository,
  RoleSummary,
  TenantContext,
  TenantRepository,
  Tx,
  UserCredentials,
  UserEdit,
  UserIdentifierRepository,
  UserRepository,
  UserSummary,
} from '@sher/core-application';
import type { IdentifierChannel } from '@sher/core-domain';
import type { Clock } from '@sher/shared-utils';
import { Ulid } from '@sher/shared-utils';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { rolePermissions, roles, tenants, userIdentifiers, users } from './schema';
import { txOf } from './unit-of-work';

/**
 * The rows a signup creates. No business calculation happens here (R-B6) — the
 * use case decides what a tenant, an Owner role and a first user are; these
 * methods only write them.
 */
export class PostgresTenantRepository implements TenantRepository {
  constructor(private readonly clock: Clock) {}

  async insert(tx: Tx, ctx: TenantContext, tenant: NewTenant): Promise<void> {
    const now = this.clock.now();
    await txOf(tx).insert(tenants).values({
      id: tenant.id,
      name: tenant.name,
      timezone: tenant.timezone,
      createdAt: now,
      updatedAt: now,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
      version: 1,
    });
  }

  async findName(tx: Tx, ctx: TenantContext): Promise<string | null> {
    const rows = await txOf(tx)
      .select({ name: tenants.name })
      .from(tenants)
      .where(and(eq(tenants.id, ctx.tenantId), isNull(tenants.deletedAt)))
      .limit(1);

    const row = rows[0];
    return row === undefined ? null : row.name;
  }
}

export class PostgresRoleRepository implements RoleRepository {
  constructor(private readonly clock: Clock) {}

  async insertSystemRole(tx: Tx, ctx: TenantContext, role: NewRole): Promise<void> {
    const now = this.clock.now();
    await txOf(tx).insert(roles).values({
      id: role.id,
      tenantId: ctx.tenantId,
      code: role.code,
      name: role.name,
      isSystem: true,
      createdAt: now,
      updatedAt: now,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
      version: 1,
    });
  }

  /** Same row shape, `is_system` false — which is what makes it deletable. */
  async insertCustomRole(tx: Tx, ctx: TenantContext, role: NewRole): Promise<void> {
    const now = this.clock.now();
    await txOf(tx).insert(roles).values({
      id: role.id,
      tenantId: ctx.tenantId,
      code: role.code,
      name: role.name,
      isSystem: false,
      createdAt: now,
      updatedAt: now,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
      version: 1,
    });
  }

  async rename(tx: Tx, ctx: TenantContext, roleId: string, name: string): Promise<void> {
    await txOf(tx)
      .update(roles)
      .set({ name, updatedAt: this.clock.now(), updatedBy: ctx.userId })
      .where(and(eq(roles.tenantId, ctx.tenantId), eq(roles.id, roleId)));
  }

  /**
   * The refund caps (owner decision 2026-08-26). Null is unlimited and 0 is a
   * role that may take a return without opening the drawer — so both are stored
   * as given, and neither is coerced into the other.
   */
  async setRefundCaps(
    tx: Tx,
    ctx: TenantContext,
    roleId: string,
    caps: { readonly perReturnMinor: number | null; readonly perDayMinor: number | null },
  ): Promise<void> {
    const now = this.clock.now();
    await txOf(tx)
      .update(roles)
      .set({
        cashRefundPerReturnMinor: caps.perReturnMinor,
        cashRefundPerDayMinor: caps.perDayMinor,
        updatedAt: now,
        updatedBy: ctx.userId,
      })
      .where(and(eq(roles.tenantId, ctx.tenantId), eq(roles.id, roleId)));
  }

  async softDelete(tx: Tx, ctx: TenantContext, roleId: string): Promise<void> {
    const now = this.clock.now();
    await txOf(tx)
      .update(roles)
      .set({ deletedAt: now, deletedBy: ctx.userId, updatedAt: now, updatedBy: ctx.userId })
      .where(and(eq(roles.tenantId, ctx.tenantId), eq(roles.id, roleId)));
  }

  /**
   * Read as three scoped queries rather than one join with aggregates: the row
   * counts here are a handful of roles per tenant, and a correct, obvious query
   * beats a clever one nobody can check.
   */
  async listDetailed(tx: Tx, ctx: TenantContext): Promise<readonly RoleDetail[]> {
    const summaries = await this.list(tx, ctx);
    return this.decorate(tx, ctx, summaries);
  }

  async findDetail(tx: Tx, ctx: TenantContext, roleId: string): Promise<RoleDetail | null> {
    const rows = await txOf(tx)
      .select({ id: roles.id, code: roles.code, name: roles.name })
      .from(roles)
      .where(and(eq(roles.tenantId, ctx.tenantId), eq(roles.id, roleId), isNull(roles.deletedAt)))
      .limit(1);

    const row = rows[0];
    if (row === undefined) return null;
    const [detail] = await this.decorate(tx, ctx, [{ ...row, id: row.id.trim() }]);
    return detail ?? null;
  }

  private async decorate(
    tx: Tx,
    ctx: TenantContext,
    summaries: readonly RoleSummary[],
  ): Promise<readonly RoleDetail[]> {
    const grants = await txOf(tx)
      .select({ roleId: rolePermissions.roleId, code: rolePermissions.permissionCode })
      .from(rolePermissions)
      .where(and(eq(rolePermissions.tenantId, ctx.tenantId), isNull(rolePermissions.deletedAt)));

    const holders = await txOf(tx)
      .select({ roleId: users.roleId })
      .from(users)
      .where(and(eq(users.tenantId, ctx.tenantId), isNull(users.deletedAt)));

    const flags = await txOf(tx)
      .select({
        id: roles.id,
        isSystem: roles.isSystem,
        perReturn: roles.cashRefundPerReturnMinor,
        perDay: roles.cashRefundPerDayMinor,
      })
      .from(roles)
      .where(and(eq(roles.tenantId, ctx.tenantId), isNull(roles.deletedAt)));

    const flagsById = new Map(flags.map((row) => [row.id.trim(), row]));

    return summaries.map((role) => ({
      ...role,
      isSystem: flagsById.get(role.id)?.isSystem ?? false,
      cashRefundPerReturnMinor: flagsById.get(role.id)?.perReturn ?? null,
      cashRefundPerDayMinor: flagsById.get(role.id)?.perDay ?? null,
      permissions: grants
        .filter((grant) => grant.roleId.trim() === role.id)
        .map((grant) => grant.code),
      userCount: holders.filter((holder) => holder.roleId.trim() === role.id).length,
    }));
  }

  /**
   * Granting a permission that was previously revoked **revives that row**
   * rather than inserting a second one. `role_permissions` is unique on
   * (tenant, role, code) and a revoke only soft-deletes, so a plain insert
   * would collide the moment an owner unticked a box and ticked it again.
   */
  async grant(tx: Tx, ctx: TenantContext, roleId: string, permissionCode: string): Promise<void> {
    const now = this.clock.now();
    await txOf(tx)
      .insert(rolePermissions)
      .values({
        id: Ulid.generate(this.clock),
        tenantId: ctx.tenantId,
        roleId,
        permissionCode,
        createdAt: now,
        updatedAt: now,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
        version: 1,
      })
      .onConflictDoUpdate({
        target: [
          rolePermissions.tenantId,
          rolePermissions.roleId,
          rolePermissions.permissionCode,
        ],
        set: { deletedAt: null, deletedBy: null, updatedAt: now, updatedBy: ctx.userId },
      });
  }

  async list(tx: Tx, ctx: TenantContext): Promise<readonly RoleSummary[]> {
    const rows = await txOf(tx)
      .select({ id: roles.id, code: roles.code, name: roles.name })
      .from(roles)
      .where(and(eq(roles.tenantId, ctx.tenantId), isNull(roles.deletedAt)))
      .orderBy(roles.name);

    return rows.map((row) => ({ ...row, id: row.id.trim() }));
  }

  /**
   * Soft delete, not a row removal: `role_permissions` is Class A and the audit
   * trail may still reference the grant that existed.
   */
  async revoke(tx: Tx, ctx: TenantContext, roleId: string, permissionCode: string): Promise<void> {
    const now = this.clock.now();
    await txOf(tx)
      .update(rolePermissions)
      .set({ deletedAt: now, deletedBy: ctx.userId, updatedAt: now, updatedBy: ctx.userId })
      .where(
        and(
          eq(rolePermissions.tenantId, ctx.tenantId),
          eq(rolePermissions.roleId, roleId),
          eq(rolePermissions.permissionCode, permissionCode),
          isNull(rolePermissions.deletedAt),
        ),
      );
  }

  async findByCode(tx: Tx, ctx: TenantContext, code: string): Promise<RoleSummary | null> {
    const rows = await txOf(tx)
      .select({ id: roles.id, code: roles.code, name: roles.name })
      .from(roles)
      .where(and(eq(roles.tenantId, ctx.tenantId), eq(roles.code, code), isNull(roles.deletedAt)))
      .limit(1);

    const row = rows[0];
    return row === undefined ? null : { ...row, id: row.id.trim() };
  }
}

/** Explicit column list — never `SELECT *`, which breaks on a schema change. */
const USER_SUMMARY = {
  id: users.id,
  username: users.username,
  displayName: users.displayName,
  email: users.email,
  phone: users.phone,
  roleId: users.roleId,
  roleCode: roles.code,
  roleName: roles.name,
  deletedAt: users.deletedAt,
  passwordHash: users.passwordHash,
  pinHash: users.pinHash,
};

interface UserSummaryRow {
  id: string;
  username: string | null;
  displayName: string;
  email: string | null;
  phone: string | null;
  roleId: string;
  roleCode: string;
  roleName: string;
  deletedAt: Date | null;
  passwordHash: string | null;
  pinHash: string | null;
}

/** Never leaks the hash itself — only whether one exists (§5.26, R-E8). */
function toSummary(row: UserSummaryRow): UserSummary {
  return {
    id: row.id.trim(),
    username: row.username ?? '',
    displayName: row.displayName,
    email: row.email,
    phone: row.phone,
    roleId: row.roleId.trim(),
    roleCode: row.roleCode,
    roleName: row.roleName,
    disabled: row.deletedAt !== null,
    hasPassword: row.passwordHash !== null,
    hasPin: row.pinHash !== null,
  };
}

export class PostgresUserRepository implements UserRepository {
  constructor(private readonly clock: Clock) {}

  /**
   * Disabled users are included. A list that hid them would make someone who
   * left look as though they had never existed, and would leave no way to put
   * them back.
   */
  async list(tx: Tx, ctx: TenantContext): Promise<readonly UserSummary[]> {
    const rows = await txOf(tx)
      .select(USER_SUMMARY)
      .from(users)
      .innerJoin(roles, and(eq(roles.id, users.roleId), eq(roles.tenantId, users.tenantId)))
      .where(eq(users.tenantId, ctx.tenantId))
      .orderBy(users.displayName);

    return rows.map(toSummary);
  }

  async findSummary(tx: Tx, ctx: TenantContext, userId: string): Promise<UserSummary | null> {
    const rows = await txOf(tx)
      .select(USER_SUMMARY)
      .from(users)
      .innerJoin(roles, and(eq(roles.id, users.roleId), eq(roles.tenantId, users.tenantId)))
      .where(and(eq(users.tenantId, ctx.tenantId), eq(users.id, userId)))
      .limit(1);

    const row = rows[0];
    return row === undefined ? null : toSummary(row);
  }

  async update(tx: Tx, ctx: TenantContext, userId: string, edit: UserEdit): Promise<void> {
    await txOf(tx)
      .update(users)
      .set({
        displayName: edit.displayName,
        roleId: edit.roleId,
        updatedAt: this.clock.now(),
        updatedBy: ctx.userId,
      })
      .where(and(eq(users.tenantId, ctx.tenantId), eq(users.id, userId)));
  }

  /** Soft delete (§3.6) — reversible, and the row stays for the audit trail. */
  async setDisabled(
    tx: Tx,
    ctx: TenantContext,
    userId: string,
    disabled: boolean,
  ): Promise<void> {
    const now = this.clock.now();
    await txOf(tx)
      .update(users)
      .set({
        deletedAt: disabled ? now : null,
        deletedBy: disabled ? ctx.userId : null,
        updatedAt: now,
        updatedBy: ctx.userId,
      })
      .where(and(eq(users.tenantId, ctx.tenantId), eq(users.id, userId)));
  }

  async countActiveWithRole(tx: Tx, ctx: TenantContext, roleId: string): Promise<number> {
    const rows = await txOf(tx)
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.tenantId, ctx.tenantId),
          eq(users.roleId, roleId),
          isNull(users.deletedAt),
        ),
      );

    return rows.length;
  }

  async findCredentials(
    tx: Tx,
    ctx: TenantContext,
    userId: string,
  ): Promise<UserCredentials | null> {
    const rows = await txOf(tx)
      .select({
        userId: users.id,
        username: users.username,
        passwordHash: users.passwordHash,
        pinHash: users.pinHash,
      })
      .from(users)
      .where(and(eq(users.tenantId, ctx.tenantId), eq(users.id, userId), isNull(users.deletedAt)))
      .limit(1);

    const row = rows[0];
    if (row === undefined) return null;
    return { ...row, userId: row.userId.trim(), username: row.username ?? '' };
  }

  /**
   * `users` is Class A (mutable): the row is updated in place and the change is
   * evidenced by the audit event the use case writes, not by a second row. The
   * WHERE clause is tenant-scoped as well as id-scoped — RLS is the backstop,
   * never the only guard (R-C4).
   */
  async updatePasswordHash(
    tx: Tx,
    ctx: TenantContext,
    userId: string,
    hash: string,
  ): Promise<void> {
    await this.updateCredential(tx, ctx, userId, { passwordHash: hash });
  }

  async updatePinHash(tx: Tx, ctx: TenantContext, userId: string, hash: string): Promise<void> {
    await this.updateCredential(tx, ctx, userId, { pinHash: hash });
  }

  private async updateCredential(
    tx: Tx,
    ctx: TenantContext,
    userId: string,
    credential: { passwordHash: string } | { pinHash: string },
  ): Promise<void> {
    await txOf(tx)
      .update(users)
      .set({
        ...credential,
        updatedAt: this.clock.now(),
        updatedBy: ctx.userId,
        version: sql`${users.version} + 1`,
      })
      .where(and(eq(users.tenantId, ctx.tenantId), eq(users.id, userId), isNull(users.deletedAt)));
  }

  async insert(tx: Tx, ctx: TenantContext, user: NewUser): Promise<void> {
    const now = this.clock.now();
    await txOf(tx).insert(users).values({
      id: user.id,
      tenantId: ctx.tenantId,
      roleId: user.roleId,
      email: user.email,
      phone: user.phone,
      username: user.username,
      displayName: user.displayName,
      passwordHash: user.passwordHash,
      pinHash: user.pinHash,
      createdAt: now,
      updatedAt: now,
      // The first user of a tenant creates itself — there is no earlier actor.
      createdBy: user.id,
      updatedBy: user.id,
      version: 1,
    });
  }
}

/**
 * Not tenant-scoped, deliberately: this index is what a signup searches when it
 * has no tenant context yet, and what slice 1.2's login resolves against. The
 * unique constraint on `identifier` is the real guarantee — `isTaken` only
 * exists so the caller can answer with a useful error instead of a constraint
 * violation.
 */
export class PostgresUserIdentifierRepository implements UserIdentifierRepository {
  constructor(private readonly clock: Clock) {}

  async isTaken(tx: Tx, identifier: string): Promise<boolean> {
    const rows = await txOf(tx)
      .select({ id: userIdentifiers.id })
      .from(userIdentifiers)
      .where(eq(userIdentifiers.identifier, identifier))
      .limit(1);

    return rows.length > 0;
  }

  async findOwner(tx: Tx, identifier: string): Promise<IdentifierOwner | null> {
    const rows = await txOf(tx)
      .select({ tenantId: userIdentifiers.tenantId, userId: userIdentifiers.userId })
      .from(userIdentifiers)
      .where(eq(userIdentifiers.identifier, identifier))
      .limit(1);

    const row = rows[0];
    return row === undefined
      ? null
      : { tenantId: row.tenantId.trim(), userId: row.userId.trim() };
  }

  async claim(
    tx: Tx,
    entry: {
      id: string;
      identifier: string;
      channel: IdentifierChannel;
      tenantId: string;
      userId: string;
    },
  ): Promise<void> {
    await txOf(tx).insert(userIdentifiers).values({
      id: entry.id,
      identifier: entry.identifier,
      channel: entry.channel,
      tenantId: entry.tenantId,
      userId: entry.userId,
      createdAt: this.clock.now(),
      createdBy: entry.userId,
    });
  }
}
