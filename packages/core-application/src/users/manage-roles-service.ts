import {
  AppError,
  ErrorCode,
  OWNER_ROLE_CODE,
  PERMISSION_CATALOGUE,
  Permission,
} from '@sher/core-contracts';
import type { RoleDetailResponse, RoleListResponse } from '@sher/core-contracts';
import type { Clock } from '@sher/shared-utils';
import { Ulid } from '@sher/shared-utils';

import type { RoleDetail, RoleRepository } from '../auth/registration-repository';
import type { UserRepository } from '../auth/registration-repository';
import type { AccessControl } from '../ports/access-control';
import type { AuditWriter } from '../ports/audit-writer';
import type { PasswordHasher } from '../ports/password-hasher';
import type { TenantContext } from '../ports/tenant-context';
import type { Tx, UnitOfWork } from '../ports/unit-of-work';

/**
 * Roles and what they may do (slice 1.4, §5.26).
 *
 * Two rules from §5.26 shape everything here:
 *
 *   "Seed roles (shipped per tenant, fully editable)" — so Manager, Cashier,
 *   Storekeeper, Accountant and Viewer can all be re-cut by the owner, and new
 *   roles can be added beside them.
 *
 *   "Owner — everything… Cannot be deleted or de-privileged." Owner is the
 *   floor: it always holds every permission that exists, cannot lose one, and
 *   cannot be removed. Without that a shop can lock itself out of its own
 *   business permanently, and no support call can undo it.
 *
 * **Step-up applies.** §5.3 lists re-privileging a user; changing what a role
 * may do re-privileges everyone holding it at once, which is the same act
 * conducted wholesale. The caller's own password is required.
 *
 * A permission change needs no session revocation: permissions are resolved
 * server-side on every request (§5.3), never carried in a token, so the next
 * thing that person clicks already obeys the new rule.
 */
export interface ListRolesCommand {
  readonly ctx: TenantContext;
}

export interface CreateRoleCommand {
  readonly ctx: TenantContext;
  readonly name: string;
  readonly permissions: readonly string[];
  /** How much cash this role may refund on a return; null is unlimited. */
  readonly cashRefundPerReturnMinor: number | null;
  readonly cashRefundPerDayMinor: number | null;
  readonly confirmPassword: string;
}

export interface UpdateRoleCommand {
  readonly ctx: TenantContext;
  readonly roleId: string;
  readonly name: string;
  readonly permissions: readonly string[];
  readonly cashRefundPerReturnMinor: number | null;
  readonly cashRefundPerDayMinor: number | null;
  readonly confirmPassword: string;
}

export interface DeleteRoleCommand {
  readonly ctx: TenantContext;
  readonly roleId: string;
  readonly confirmPassword: string;
}

const KNOWN_CODES = new Set<string>(PERMISSION_CATALOGUE.map((entry) => entry.code));
const EVERY_PERMISSION: readonly string[] = PERMISSION_CATALOGUE.map((entry) => entry.code);

function stepUpFailed(): AppError {
  return new AppError(ErrorCode.UNAUTHENTICATED, 'Your password is not correct');
}

export class ManageRolesService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly accessControl: AccessControl,
    private readonly roles: RoleRepository,
    private readonly users: UserRepository,
    private readonly hasher: PasswordHasher,
    private readonly audit: AuditWriter,
    private readonly clock: Clock,
  ) {}

  async list(command: ListRolesCommand): Promise<RoleListResponse> {
    const { ctx } = command;

    return this.uow.run(ctx, async (tx) => {
      await this.accessControl.require(tx, ctx, Permission.ROLE_VIEW);

      const roles = await this.roles.listDetailed(tx, ctx);
      return {
        roles: roles.map(toResponse),
        catalogue: PERMISSION_CATALOGUE.map((entry) => ({ ...entry })),
      };
    });
  }

  async create(command: CreateRoleCommand): Promise<RoleDetailResponse> {
    const { ctx } = command;
    const name = command.name.trim();
    const permissions = this.validatePermissions(command.permissions);

    return this.uow.run(ctx, async (tx) => {
      await this.accessControl.require(tx, ctx, Permission.ROLE_MANAGE);
      await this.assertStepUp(tx, ctx, command.confirmPassword);

      const code = codeFor(name);
      if ((await this.roles.findByCode(tx, ctx, code)) !== null) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'A role with that name already exists');
      }

      const roleId = Ulid.generate(this.clock);
      await this.roles.insertCustomRole(tx, ctx, { id: roleId, code, name });
      await this.roles.setRefundCaps(tx, ctx, roleId, {
        perReturnMinor: command.cashRefundPerReturnMinor,
        perDayMinor: command.cashRefundPerDayMinor,
      });
      for (const permission of permissions) {
        await this.roles.grant(tx, ctx, roleId, permission);
      }

      await this.audit.append(tx, ctx, {
        entityType: 'role',
        entityId: roleId,
        action: 'CREATE',
        before: null,
        after: { name, permissions: permissions.join(' ') },
        source: 'API',
      });

      return this.reload(tx, ctx, roleId);
    });
  }

  async update(command: UpdateRoleCommand): Promise<RoleDetailResponse> {
    const { ctx } = command;
    const name = command.name.trim();
    const wanted = this.validatePermissions(command.permissions);

    return this.uow.run(ctx, async (tx) => {
      await this.accessControl.require(tx, ctx, Permission.ROLE_MANAGE);
      await this.assertStepUp(tx, ctx, command.confirmPassword);

      const before = await this.requireRole(tx, ctx, command.roleId);

      // §5.26: Owner "cannot be de-privileged". Renaming it is harmless, so only
      // its permissions are frozen — and they are frozen at *everything*, which
      // is what stops a new permission from quietly leaving the owner locked out
      // of a feature the moment a later slice adds it.
      const permissions = before.code === OWNER_ROLE_CODE ? EVERY_PERMISSION : wanted;
      if (before.code === OWNER_ROLE_CODE && !holdsAll(wanted)) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'The Owner role always keeps every permission and cannot be reduced',
        );
      }

      if (name !== before.name) await this.roles.rename(tx, ctx, command.roleId, name);
      await this.applyPermissions(tx, ctx, command.roleId, before.permissions, permissions);
      /*
       * The caps travel with the role, not with the permission list: a shop
       * raising the cashier's limit is not re-privileging anybody, and the
       * Owner's frozen permissions do not freeze what the owner may refund.
       */
      await this.roles.setRefundCaps(tx, ctx, command.roleId, {
        perReturnMinor: command.cashRefundPerReturnMinor,
        perDayMinor: command.cashRefundPerDayMinor,
      });

      await this.audit.append(tx, ctx, {
        entityType: 'role',
        entityId: command.roleId,
        // Everyone holding this role gains or loses something at once, so the
        // trail names it for what it is.
        action: 'REPRIVILEGE',
        before: { name: before.name, permissions: [...before.permissions].sort().join(' ') },
        after: { name, permissions: [...permissions].sort().join(' ') },
        source: 'API',
      });

      return this.reload(tx, ctx, command.roleId);
    });
  }

  async remove(command: DeleteRoleCommand): Promise<void> {
    const { ctx } = command;

    await this.uow.run(ctx, async (tx) => {
      await this.accessControl.require(tx, ctx, Permission.ROLE_MANAGE);
      await this.assertStepUp(tx, ctx, command.confirmPassword);

      const role = await this.requireRole(tx, ctx, command.roleId);

      if (role.code === OWNER_ROLE_CODE) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'The Owner role cannot be deleted');
      }
      if (role.isSystem) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'This role ships with SherERP and cannot be deleted. Remove its permissions instead.',
        );
      }
      // Deleting a role somebody holds would leave them with no role at all —
      // an account that cannot be reasoned about. Move them first.
      if (role.userCount > 0) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          `${String(role.userCount)} ${role.userCount === 1 ? 'person holds' : 'people hold'} this role. Move them to another role first.`,
        );
      }

      await this.roles.softDelete(tx, ctx, command.roleId);

      await this.audit.append(tx, ctx, {
        entityType: 'role',
        entityId: command.roleId,
        action: 'DELETE',
        before: { name: role.name, permissions: [...role.permissions].sort().join(' ') },
        after: null,
        source: 'API',
      });
    });
  }

  /** Grants what is newly wanted and revokes what is not — never a blind wipe. */
  private async applyPermissions(
    tx: Tx,
    ctx: TenantContext,
    roleId: string,
    before: readonly string[],
    after: readonly string[],
  ): Promise<void> {
    const had = new Set(before);
    const wants = new Set(after);

    for (const permission of after) {
      if (!had.has(permission)) await this.roles.grant(tx, ctx, roleId, permission);
    }
    for (const permission of before) {
      if (!wants.has(permission)) await this.roles.revoke(tx, ctx, roleId, permission);
    }
  }

  /**
   * A code the server does not recognise is refused rather than stored. Writing
   * one would put a permission in the database that nothing ever checks — it
   * would read as a granted power and be none.
   */
  private validatePermissions(permissions: readonly string[]): readonly string[] {
    const unknown = permissions.filter((code) => !KNOWN_CODES.has(code));
    if (unknown.length > 0) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Unknown permission', {
        permissions: unknown.join(', '),
      });
    }
    return [...new Set(permissions)];
  }

  /** §5.3: a fresh credential, asserted here. A PIN never satisfies step-up. */
  private async assertStepUp(tx: Tx, ctx: TenantContext, confirmPassword: string): Promise<void> {
    const self = await this.users.findCredentials(tx, ctx, ctx.userId);
    if (self === null) throw stepUpFailed();
    if (self.passwordHash === null) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        'Set a password in Settings → Security before changing roles',
      );
    }
    if (!(await this.hasher.verify(confirmPassword, self.passwordHash))) throw stepUpFailed();
  }

  private async requireRole(tx: Tx, ctx: TenantContext, roleId: string): Promise<RoleDetail> {
    const role = await this.roles.findDetail(tx, ctx, roleId);
    // Another tenant's role is simply not found — never a 403 (§5.26).
    if (role === null) throw new AppError(ErrorCode.NOT_FOUND, 'Role not found');
    return role;
  }

  private async reload(tx: Tx, ctx: TenantContext, roleId: string): Promise<RoleDetailResponse> {
    const role = await this.roles.findDetail(tx, ctx, roleId);
    if (role === null) throw new AppError(ErrorCode.INTERNAL_ERROR, 'Role was not saved');
    return toResponse(role);
  }
}

function holdsAll(permissions: readonly string[]): boolean {
  const held = new Set(permissions);
  return EVERY_PERMISSION.every((code) => held.has(code));
}

/**
 * A stable code derived from the name, so audit rows and future imports have
 * something durable to point at while the display name stays editable.
 */
function codeFor(name: string): string {
  const slug = name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug === '' ? 'ROLE' : slug.slice(0, 40);
}

function toResponse(role: RoleDetail): RoleDetailResponse {
  return {
    id: role.id,
    code: role.code,
    name: role.name,
    isSystem: role.isSystem,
    locked: role.code === OWNER_ROLE_CODE,
    permissions: [...role.permissions],
    cashRefundPerReturnMinor: role.cashRefundPerReturnMinor,
    cashRefundPerDayMinor: role.cashRefundPerDayMinor,
    userCount: role.userCount,
  };
}
