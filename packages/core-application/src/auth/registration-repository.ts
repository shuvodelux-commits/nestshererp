import type { IdentifierChannel } from '@sher/core-domain';

import type { TenantContext } from '../ports/tenant-context';
import type { Tx } from '../ports/unit-of-work';

/**
 * The rows a signup creates, and the pre-authentication lookup it needs.
 *
 * Business-specific interfaces, no generic CRUD (R-B7). Implementations live in
 * adapter-postgres and expose no Drizzle type, which is what keeps a SQLite WASM
 * implementation possible (D-14).
 *
 * `tenant_id` still never comes from a request payload (R-C4). It is generated
 * by the use case, because this is the one operation in the system that creates
 * the tenant rather than acting inside one.
 */

export interface NewTenant {
  readonly id: string;
  readonly name: string;
  readonly timezone: string;
}

export interface NewRole {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

export interface NewUser {
  readonly id: string;
  readonly roleId: string;
  readonly username: string;
  readonly displayName: string;
  readonly email: string | null;
  readonly phone: string | null;
  /**
   * Null on an account Google created (§5.3, D-07 revised 2026-08-17) — that
   * path collects only a business name, so there is no password to hash. A
   * placeholder hash would be a password nobody chose.
   */
  readonly passwordHash: string | null;
  /** Null on a Google-created account, for the same reason. */
  readonly pinHash: string | null;
}

export interface TenantRepository {
  insert(tx: Tx, ctx: TenantContext, tenant: NewTenant): Promise<void>;
  findName(tx: Tx, ctx: TenantContext): Promise<string | null>;
}

/** A role as the Users screen needs it: something to assign, with a name. */
export interface RoleSummary {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

/** A role with what it may do, and how many people hold it. */
export interface RoleDetail extends RoleSummary {
  readonly isSystem: boolean;
  readonly permissions: readonly string[];
  readonly userCount: number;
  /** How much cash this role may refund (Phase 7). Null is unlimited. */
  readonly cashRefundPerReturnMinor: number | null;
  readonly cashRefundPerDayMinor: number | null;
}

export interface RoleRepository {
  insertSystemRole(tx: Tx, ctx: TenantContext, role: NewRole): Promise<void>;
  /** A role the owner made. Not `is_system`, so it can be deleted again. */
  insertCustomRole(tx: Tx, ctx: TenantContext, role: NewRole): Promise<void>;
  rename(tx: Tx, ctx: TenantContext, roleId: string, name: string): Promise<void>;
  grant(tx: Tx, ctx: TenantContext, roleId: string, permissionCode: string): Promise<void>;
  revoke(tx: Tx, ctx: TenantContext, roleId: string, permissionCode: string): Promise<void>;
  list(tx: Tx, ctx: TenantContext): Promise<readonly RoleSummary[]>;
  /** Every role with its permissions and holder count, for the Roles screen. */
  listDetailed(tx: Tx, ctx: TenantContext): Promise<readonly RoleDetail[]>;
  findDetail(tx: Tx, ctx: TenantContext, roleId: string): Promise<RoleDetail | null>;
  findByCode(tx: Tx, ctx: TenantContext, code: string): Promise<RoleSummary | null>;
  /** Soft delete (§3.6) — a role that was used stays readable in the audit trail. */
  /** The two refund caps, set from the Roles screen (owner decision 2026-08-26). */
  setRefundCaps(
    tx: Tx,
    ctx: TenantContext,
    roleId: string,
    caps: { readonly perReturnMinor: number | null; readonly perDayMinor: number | null },
  ): Promise<void>;
  /** Soft delete (§3.6) — a role that was used stays readable in the audit trail. */
  softDelete(tx: Tx, ctx: TenantContext, roleId: string): Promise<void>;
}

/** The stored credentials a login checks against. */
export interface UserCredentials {
  readonly userId: string;
  readonly username: string;
  readonly passwordHash: string | null;
  readonly pinHash: string | null;
}

/** A user as the Users list shows them. Never carries a hash. */
export interface UserSummary {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly roleId: string;
  readonly roleCode: string;
  readonly roleName: string;
  /** A disabled user is soft deleted (§3.6) and cannot sign in. */
  readonly disabled: boolean;
  /** Whether they can sign in yet — a newly created user has no password. */
  readonly hasPassword: boolean;
  /**
   * Whether they have a counter PIN (Phase 12.4, §9).
   *
   * The only credential that travels to an offline machine, so this is what
   * decides whether a person can be named as someone who may work on one. Like
   * `hasPassword`, it says whether one exists and never what it is.
   */
  readonly hasPin: boolean;
}

export interface UserEdit {
  readonly displayName: string;
  readonly roleId: string;
}

export interface UserRepository {
  insert(tx: Tx, ctx: TenantContext, user: NewUser): Promise<void>;
  /** Everyone in the tenant, disabled included — hiding them hides the trail. */
  list(tx: Tx, ctx: TenantContext): Promise<readonly UserSummary[]>;
  findSummary(tx: Tx, ctx: TenantContext, userId: string): Promise<UserSummary | null>;
  update(tx: Tx, ctx: TenantContext, userId: string, edit: UserEdit): Promise<void>;
  /** Soft delete (§3.6). Reversible, and the audit trail keeps the row. */
  setDisabled(tx: Tx, ctx: TenantContext, userId: string, disabled: boolean): Promise<void>;
  /** Live holders of a role — what "refuse to remove the last Owner" counts. */
  countActiveWithRole(tx: Tx, ctx: TenantContext, roleId: string): Promise<number>;
  /**
   * Null when the user does not exist, belongs to another tenant, or is soft
   * deleted — a disabled account must not be able to sign in.
   */
  findCredentials(tx: Tx, ctx: TenantContext, userId: string): Promise<UserCredentials | null>;
  /**
   * Replaces the stored password hash (§5.3). Separate from the PIN so a
   * recovery flow can never touch the PIN by accident, and so an audit event
   * describes exactly one credential.
   */
  updatePasswordHash(tx: Tx, ctx: TenantContext, userId: string, hash: string): Promise<void>;
  updatePinHash(tx: Tx, ctx: TenantContext, userId: string, hash: string): Promise<void>;
}

/**
 * The pre-authentication index from an identifier to the account that owns it.
 *
 * It exists because `users` is RLS-scoped and a signup has no tenant context to
 * search it with — and because "one phone or email, one account" has to be
 * enforced by a unique constraint, not by a read-then-write race. Slice 1.2's
 * login resolves its identifier through this same index.
 *
 * It is never exposed through an API: knowing an identifier is taken is exactly
 * what an enumeration attack wants, so callers answer with a generic conflict.
 */
/** Which account an identifier belongs to, resolved before authentication. */
export interface IdentifierOwner {
  readonly tenantId: string;
  readonly userId: string;
}

export interface UserIdentifierRepository {
  isTaken(tx: Tx, identifier: string): Promise<boolean>;
  /** Null when no account holds this identifier. */
  findOwner(tx: Tx, identifier: string): Promise<IdentifierOwner | null>;
  claim(
    tx: Tx,
    entry: {
      readonly id: string;
      readonly identifier: string;
      readonly channel: IdentifierChannel;
      readonly tenantId: string;
      readonly userId: string;
    },
  ): Promise<void>;
}
