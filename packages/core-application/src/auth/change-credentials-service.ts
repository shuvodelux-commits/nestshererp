import { isValidPassword, isValidPin } from '@sher/core-domain';
import { AppError, ErrorCode } from '@sher/core-contracts';

import type { AuditWriter } from '../ports/audit-writer';
import type { PasswordHasher } from '../ports/password-hasher';
import type { TenantContext } from '../ports/tenant-context';
import type { TokenIssuer } from '../ports/token-issuer';
import type { Tx, UnitOfWork } from '../ports/unit-of-work';
import type { UserRepository } from './registration-repository';
import type { SessionRepository } from './session-repository';

/**
 * Changing your own password or PIN in Settings (§5.3).
 *
 * "Both are set at signup and changeable in Settings; changing either requires
 * the current credential, and changing a password invalidates all other
 * sessions." That sentence is the whole specification, and each clause is
 * implemented literally below.
 *
 * **No permission code is checked**, and that is deliberate rather than an
 * omission of R-D step 2. The operation acts only on the caller's own row —
 * `ctx.userId`, never an id from the payload — so the authority is the current
 * credential itself. A permission code here would have to be held by every role
 * in the system to avoid locking users out of their own account; changing
 * *another* user's credentials is a different operation, gated by `user.*` in
 * slice 1.3, and is not built here.
 *
 * **No idempotency key**, either. `idempotency_keys` stores the request
 * fingerprint, and a fingerprint of this command would put a plaintext password
 * in a database row — security outranks write-path uniformity in the principle
 * priority. A replay is harmless without it: once the change lands, the old
 * credential no longer matches and the second attempt is simply refused.
 */
export interface ChangePasswordCommand {
  readonly ctx: TenantContext;
  /**
   * This device's refresh token. It identifies the session that survives, so
   * the rule can be "all **other** sessions" rather than "all sessions" — the
   * person changing their password is not logged out of the screen they are on.
   * Unknown or already revoked, every session goes.
   */
  readonly refreshToken: string;
  readonly currentPassword: string;
  readonly newPassword: string;
}

export interface ChangePinCommand {
  readonly ctx: TenantContext;
  readonly currentPin: string;
  readonly newPin: string;
}

function wrongCredential(): AppError {
  return new AppError(ErrorCode.UNAUTHENTICATED, 'That current credential is not correct');
}

export class ChangeCredentialsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly users: UserRepository,
    private readonly sessions: SessionRepository,
    private readonly hasher: PasswordHasher,
    private readonly tokens: TokenIssuer,
    private readonly audit: AuditWriter,
  ) {}

  async changePassword(command: ChangePasswordCommand): Promise<void> {
    if (!isValidPassword(command.newPassword)) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        'Password must be at least 8 characters and contain a letter and a number',
      );
    }

    const { ctx } = command;
    const tokenHash = this.tokens.hashRefreshToken(command.refreshToken);

    await this.uow.run(ctx, async (tx) => {
      const current = await this.verifyCurrent(tx, ctx, (stored) => stored.passwordHash);
      if (!(await this.hasher.verify(command.currentPassword, current))) throw wrongCredential();

      await this.users.updatePasswordHash(
        tx,
        ctx,
        ctx.userId,
        await this.hasher.hash(command.newPassword),
      );

      // §5.3: "changing a password invalidates all other sessions". Anything
      // signed in with the old password stops working; this device does not.
      const keep = await this.sessions.findByTokenHash(tx, tokenHash);
      const keepId = keep !== null && keep.userId === ctx.userId ? keep.id : null;
      await this.sessions.revokeAllForUser(tx, ctx.tenantId, ctx.userId, keepId);

      await this.audit.append(tx, ctx, {
        entityType: 'user',
        entityId: ctx.userId,
        action: 'PASSWORD_CHANGED',
        before: null,
        // Never the password, old or new — only that one credential changed.
        after: { credential: 'PASSWORD', otherSessionsRevoked: keepId === null ? 'ALL' : 'OTHERS' },
        source: 'API',
      });
    });
  }

  /**
   * A PIN change revokes nothing. §5.3 attaches that consequence to a password
   * alone, and rightly: a PIN is only ever accepted alongside the device's own
   * refresh token, so it cannot be the credential behind a session elsewhere.
   */
  async changePin(command: ChangePinCommand): Promise<void> {
    if (!isValidPin(command.newPin)) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'PIN must be exactly 4 digits');
    }

    const { ctx } = command;

    await this.uow.run(ctx, async (tx) => {
      const current = await this.verifyCurrent(tx, ctx, (stored) => stored.pinHash);
      if (!(await this.hasher.verify(command.currentPin, current))) throw wrongCredential();

      await this.users.updatePinHash(tx, ctx, ctx.userId, await this.hasher.hash(command.newPin));

      await this.audit.append(tx, ctx, {
        entityType: 'user',
        entityId: ctx.userId,
        action: 'PIN_CHANGED',
        before: null,
        after: { credential: 'PIN' },
        source: 'API',
      });
    });
  }

  /**
   * The stored hash the current credential is checked against. A user who holds
   * no such credential yet cannot *change* it — that is setting a first one, and
   * it belongs to the administrator flow in slice 1.3, not here.
   */
  private async verifyCurrent(
    tx: Tx,
    ctx: TenantContext,
    select: (stored: { passwordHash: string | null; pinHash: string | null }) => string | null,
  ): Promise<string> {
    const stored = await this.users.findCredentials(tx, ctx, ctx.userId);
    if (stored === null) throw wrongCredential();

    const hash = select(stored);
    if (hash === null) throw wrongCredential();
    return hash;
  }
}
