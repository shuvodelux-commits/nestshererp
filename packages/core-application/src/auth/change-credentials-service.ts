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
  /** Absent when the account has no password yet — see `authorize`. */
  readonly currentPassword?: string | undefined;
  readonly newPassword: string;
}

export interface ChangePinCommand {
  readonly ctx: TenantContext;
  readonly currentPin?: string | undefined;
  readonly newPin: string;
}

/** What the caller may do with each credential right now. */
export interface SecuritySettings {
  readonly hasPassword: boolean;
  readonly hasPin: boolean;
}

function wrongCredential(): AppError {
  return new AppError(ErrorCode.UNAUTHENTICATED, 'That current credential is not correct');
}

function currentRequired(credential: 'password' | 'PIN'): AppError {
  return new AppError(ErrorCode.VALIDATION_FAILED, `Your current ${credential} is required`);
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
      const replacing = await this.authorize(
        tx,
        ctx,
        (stored) => stored.passwordHash,
        command.currentPassword,
        'password',
      );

      await this.users.updatePasswordHash(
        tx,
        ctx,
        ctx.userId,
        await this.hasher.hash(command.newPassword),
      );

      // §5.3: "changing a password invalidates all other sessions". Anything
      // signed in with the old password stops working; this device does not.
      //
      // Setting a *first* password revokes nothing: there was no old password
      // for those sessions to have been established with, so there is nothing
      // to invalidate. Signing a Google user out of their phone because they
      // added a password would be a surprise the spec does not ask for.
      let revoked = 'NONE';
      if (replacing) {
        const keep = await this.sessions.findByTokenHash(tx, tokenHash);
        const keepId = keep !== null && keep.userId === ctx.userId ? keep.id : null;
        await this.sessions.revokeAllForUser(tx, ctx.tenantId, ctx.userId, keepId);
        revoked = keepId === null ? 'ALL' : 'OTHERS';
      }

      await this.audit.append(tx, ctx, {
        entityType: 'user',
        entityId: ctx.userId,
        // Setting a first credential and replacing one are different events, and
        // an audit trail that called both "changed" would hide which happened.
        action: replacing ? 'PASSWORD_CHANGED' : 'PASSWORD_SET',
        before: null,
        // Never the password, old or new — only that one credential changed.
        after: { credential: 'PASSWORD', otherSessionsRevoked: revoked },
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
      const replacing = await this.authorize(
        tx,
        ctx,
        (stored) => stored.pinHash,
        command.currentPin,
        'PIN',
      );

      await this.users.updatePinHash(tx, ctx, ctx.userId, await this.hasher.hash(command.newPin));

      await this.audit.append(tx, ctx, {
        entityType: 'user',
        entityId: ctx.userId,
        action: replacing ? 'PIN_CHANGED' : 'PIN_SET',
        before: null,
        after: { credential: 'PIN' },
        source: 'API',
      });
    });
  }

  /** Which credentials this user holds, so Settings can offer Set or Change. */
  async read(ctx: TenantContext): Promise<SecuritySettings> {
    return this.uow.run(ctx, async (tx) => {
      const stored = await this.users.findCredentials(tx, ctx, ctx.userId);
      if (stored === null) throw new AppError(ErrorCode.NOT_FOUND, 'User not found');
      return { hasPassword: stored.passwordHash !== null, hasPin: stored.pinHash !== null };
    });
  }

  /**
   * Decides whether this is a **change** or a first **set**, and enforces the
   * rule that goes with it. Returns true when an existing credential was
   * replaced.
   *
   * A user who signed up through Google holds no password and no PIN (D-07:
   * Google is the credential). There is nothing for them to prove, so a valid
   * access token is the authority — they are already signed in as themselves.
   * Once a credential exists, the current one is required again.
   *
   * **The branch is decided from what is stored, never from what was sent.** A
   * caller who omits `current` when one exists is refused rather than let
   * through; otherwise omitting a field would be a way past the check.
   */
  private async authorize(
    tx: Tx,
    ctx: TenantContext,
    select: (stored: { passwordHash: string | null; pinHash: string | null }) => string | null,
    current: string | undefined,
    credential: 'password' | 'PIN',
  ): Promise<boolean> {
    const stored = await this.users.findCredentials(tx, ctx, ctx.userId);
    if (stored === null) throw wrongCredential();

    const hash = select(stored);
    if (hash === null) return false;

    if (current === undefined || current === '') throw currentRequired(credential);
    if (!(await this.hasher.verify(current, hash))) throw wrongCredential();
    return true;
  }
}
