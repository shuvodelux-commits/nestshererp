import type {
  IdentifierOwner,
  NewRole,
  NewTenant,
  NewUser,
  RoleRepository,
  TenantContext,
  TenantRepository,
  Tx,
  UserCredentials,
  UserIdentifierRepository,
  UserRepository,
} from '@sher/core-application';
import type { IdentifierChannel } from '@sher/core-domain';
import type { Clock } from '@sher/shared-utils';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { roles, tenants, userIdentifiers, users } from './schema';
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
}

export class PostgresUserRepository implements UserRepository {
  constructor(private readonly clock: Clock) {}

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
