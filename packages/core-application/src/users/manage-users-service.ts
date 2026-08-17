import { classifyIdentifier, normalizeIdentifier } from '@sher/core-domain';
import { AppError, ErrorCode, OWNER_ROLE_CODE, Permission } from '@sher/core-contracts';
import type { UserListResponse, UserResponse } from '@sher/core-contracts';
import type { Clock } from '@sher/shared-utils';
import { Ulid } from '@sher/shared-utils';

import type {
  RoleRepository,
  UserIdentifierRepository,
  UserRepository,
  UserSummary,
} from '../auth/registration-repository';
import type { SessionRepository } from '../auth/session-repository';
import type { AccessControl } from '../ports/access-control';
import type { AuditWriter } from '../ports/audit-writer';
import type { PasswordHasher } from '../ports/password-hasher';
import type { TenantContext } from '../ports/tenant-context';
import type { Tx, UnitOfWork } from '../ports/unit-of-work';

/**
 * Creating, editing and disabling the people who work in a business (slice 1.3).
 *
 * **Step-up authentication.** §5.3 lists "create/disable/re-privilege a user"
 * among the actions needing a fresh credential, "asserted in the use case, not a
 * UI dialog". Here that is the caller's own password, re-entered with the
 * request and verified below. A PIN is explicitly not accepted — §5.3: it "never
 * satisfies step-up".
 *
 * Editing a display name is **not** step-up: it re-privileges nobody. Changing
 * someone's role is, and so is disabling them.
 *
 * **A new user gets no password.** They set their own through the existing
 * forgot-password flow, which already proves they hold the phone or email. That
 * is why there is no invite-token machinery here: the mechanism that would issue
 * one already exists and is better, because it ends with a credential only they
 * have ever seen.
 */
export interface ListUsersCommand {
  readonly ctx: TenantContext;
}

export interface CreateUserCommand {
  readonly ctx: TenantContext;
  /** The caller's own password — step-up (§5.3), not the new user's. */
  readonly confirmPassword: string;
  readonly displayName: string;
  readonly username: string;
  /** Mobile or email, the same single field as signup (D-07). */
  readonly identifier: string;
  readonly roleId: string;
}

export interface UpdateUserCommand {
  readonly ctx: TenantContext;
  readonly userId: string;
  readonly displayName: string;
  readonly roleId: string;
  /** Required only when the role actually changes. */
  readonly confirmPassword?: string | undefined;
}

export interface SetUserDisabledCommand {
  readonly ctx: TenantContext;
  readonly userId: string;
  readonly disabled: boolean;
  readonly confirmPassword: string;
}

function stepUpFailed(): AppError {
  return new AppError(ErrorCode.UNAUTHENTICATED, 'Your password is not correct');
}

export class ManageUsersService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly accessControl: AccessControl,
    private readonly users: UserRepository,
    private readonly roles: RoleRepository,
    private readonly identifiers: UserIdentifierRepository,
    private readonly sessions: SessionRepository,
    private readonly hasher: PasswordHasher,
    private readonly audit: AuditWriter,
    private readonly clock: Clock,
  ) {}

  async list(command: ListUsersCommand): Promise<UserListResponse> {
    const { ctx } = command;

    return this.uow.run(ctx, async (tx) => {
      await this.accessControl.require(tx, ctx, Permission.USER_VIEW);

      const [users, roles] = await Promise.all([
        this.users.list(tx, ctx),
        this.roles.list(tx, ctx),
      ]);

      return {
        users: users.map(toResponse),
        roles: roles.map((role) => ({ id: role.id, code: role.code, name: role.name })),
      };
    });
  }

  async create(command: CreateUserCommand): Promise<UserResponse> {
    const { ctx } = command;

    const channel = classifyIdentifier(command.identifier.trim());
    if (channel === null) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        'Enter a valid mobile number or email address',
      );
    }
    const identifier = normalizeIdentifier(command.identifier, channel);

    return this.uow.run(ctx, async (tx) => {
      await this.accessControl.require(tx, ctx, Permission.USER_CREATE);
      await this.assertStepUp(tx, ctx, command.confirmPassword);

      // One identifier, one account, across every tenant — the same rule signup
      // enforces, and the same unique index behind it.
      if (await this.identifiers.isTaken(tx, identifier)) {
        throw new AppError(
          ErrorCode.IDENTIFIER_ALREADY_REGISTERED,
          'That mobile number or email already belongs to an account',
        );
      }

      const role = await this.requireRole(tx, ctx, command.roleId);
      const userId = Ulid.generate(this.clock);
      const username = command.username.trim();

      await this.users.insert(tx, ctx, {
        id: userId,
        roleId: role.id,
        username,
        displayName: command.displayName.trim(),
        email: channel === 'EMAIL' ? identifier : null,
        phone: channel === 'PHONE' ? identifier : null,
        // They choose their own, through forgot-password. A password set here
        // would be one the administrator had seen.
        passwordHash: null,
        pinHash: null,
      });
      await this.identifiers.claim(tx, {
        id: Ulid.generate(this.clock),
        identifier,
        channel,
        tenantId: ctx.tenantId,
        userId,
      });

      await this.audit.append(tx, ctx, {
        entityType: 'user',
        entityId: userId,
        action: 'CREATE',
        before: null,
        after: { username, role: role.code, channel },
        source: 'API',
      });

      const created = await this.users.findSummary(tx, ctx, userId);
      if (created === null) throw new AppError(ErrorCode.INTERNAL_ERROR, 'User was not created');
      return toResponse(created);
    });
  }

  async update(command: UpdateUserCommand): Promise<UserResponse> {
    const { ctx } = command;

    return this.uow.run(ctx, async (tx) => {
      await this.accessControl.require(tx, ctx, Permission.USER_EDIT);

      const before = await this.requireUser(tx, ctx, command.userId);
      const role = await this.requireRole(tx, ctx, command.roleId);
      const rePrivileging = before.roleId !== role.id;

      // Re-privileging is step-up; renaming is not (§5.3).
      if (rePrivileging) {
        await this.assertStepUp(tx, ctx, command.confirmPassword);
        await this.assertNotLastOwner(tx, ctx, before, 'change the role of');
      }

      await this.users.update(tx, ctx, command.userId, {
        displayName: command.displayName.trim(),
        roleId: role.id,
      });

      // A role change takes effect immediately because permissions are resolved
      // per request (§5.3) — but their existing sessions keep an access token
      // minted before it, so the ones elsewhere are ended.
      if (rePrivileging) {
        await this.sessions.revokeAllForUser(tx, ctx.tenantId, command.userId, null);
      }

      await this.audit.append(tx, ctx, {
        entityType: 'user',
        entityId: command.userId,
        action: rePrivileging ? 'REPRIVILEGE' : 'UPDATE',
        before: { displayName: before.displayName, role: before.roleCode },
        after: { displayName: command.displayName.trim(), role: role.code },
        source: 'API',
      });

      const updated = await this.users.findSummary(tx, ctx, command.userId);
      if (updated === null) throw new AppError(ErrorCode.NOT_FOUND, 'User not found');
      return toResponse(updated);
    });
  }

  async setDisabled(command: SetUserDisabledCommand): Promise<UserResponse> {
    const { ctx } = command;

    return this.uow.run(ctx, async (tx) => {
      await this.accessControl.require(tx, ctx, Permission.USER_DISABLE);
      await this.assertStepUp(tx, ctx, command.confirmPassword);

      const before = await this.requireUser(tx, ctx, command.userId);

      if (command.disabled) {
        if (command.userId === ctx.userId) {
          throw new AppError(
            ErrorCode.VALIDATION_FAILED,
            'You cannot disable your own account',
          );
        }
        await this.assertNotLastOwner(tx, ctx, before, 'disable');
      }

      await this.users.setDisabled(tx, ctx, command.userId, command.disabled);

      // A disabled account must stop working now, not when its token expires.
      if (command.disabled) {
        await this.sessions.revokeAllForUser(tx, ctx.tenantId, command.userId, null);
      }

      await this.audit.append(tx, ctx, {
        entityType: 'user',
        entityId: command.userId,
        action: command.disabled ? 'DISABLE' : 'ENABLE',
        before: { disabled: before.disabled ? 'YES' : 'NO' },
        after: { disabled: command.disabled ? 'YES' : 'NO' },
        source: 'API',
      });

      const updated = await this.users.findSummary(tx, ctx, command.userId);
      if (updated === null) throw new AppError(ErrorCode.NOT_FOUND, 'User not found');
      return toResponse(updated);
    });
  }

  /**
   * §5.3: a fresh credential, asserted here rather than trusted from a UI
   * dialog. The caller's own password — a PIN never satisfies step-up.
   */
  private async assertStepUp(
    tx: Tx,
    ctx: TenantContext,
    confirmPassword: string | undefined,
  ): Promise<void> {
    if (confirmPassword === undefined || confirmPassword === '') {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Confirm with your password to continue');
    }

    const self = await this.users.findCredentials(tx, ctx, ctx.userId);
    if (self === null) throw stepUpFailed();
    if (self.passwordHash === null) {
      // A Google-only account has nothing to re-enter. Settings → Security is
      // where they add one; refusing here is safer than skipping the check.
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        'Set a password in Settings → Security before managing users',
      );
    }
    if (!(await this.hasher.verify(confirmPassword, self.passwordHash))) throw stepUpFailed();
  }

  /** §5.26: "The system must refuse to remove the last Owner." */
  private async assertNotLastOwner(
    tx: Tx,
    ctx: TenantContext,
    user: UserSummary,
    action: string,
  ): Promise<void> {
    if (user.roleCode !== OWNER_ROLE_CODE) return;

    const owners = await this.users.countActiveWithRole(tx, ctx, user.roleId);
    if (owners <= 1) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        `This is the only Owner. Make someone else an Owner before you ${action} this account.`,
      );
    }
  }

  private async requireUser(tx: Tx, ctx: TenantContext, userId: string): Promise<UserSummary> {
    const user = await this.users.findSummary(tx, ctx, userId);
    // Another tenant's user is simply not found — never a 403 (§5.26).
    if (user === null) throw new AppError(ErrorCode.NOT_FOUND, 'User not found');
    return user;
  }

  private async requireRole(tx: Tx, ctx: TenantContext, roleId: string) {
    const roles = await this.roles.list(tx, ctx);
    const role = roles.find((candidate) => candidate.id === roleId);
    if (role === undefined) throw new AppError(ErrorCode.NOT_FOUND, 'Role not found');
    return role;
  }
}

function toResponse(user: UserSummary): UserResponse {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    email: user.email,
    phone: user.phone,
    roleId: user.roleId,
    roleName: user.roleName,
    disabled: user.disabled,
    hasPassword: user.hasPassword,
  };
}
