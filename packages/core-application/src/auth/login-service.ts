import { classifyIdentifier, normalizeIdentifier } from '@sher/core-domain';
import { AppError, ErrorCode } from '@sher/core-contracts';
import type { LoginResponse } from '@sher/core-contracts';
import type { Clock } from '@sher/shared-utils';
import { addSeconds, Ulid } from '@sher/shared-utils';

import type { AuditWriter } from '../ports/audit-writer';
import type { GoogleVerifier } from '../ports/google-verifier';
import type { PasswordHasher } from '../ports/password-hasher';
import type { TenantContext } from '../ports/tenant-context';
import type { TokenIssuer } from '../ports/token-issuer';
import type { Tx, UnitOfWork } from '../ports/unit-of-work';
import type { UserIdentifierRepository, UserRepository } from './registration-repository';
import type { SessionRepository } from './session-repository';

/**
 * Daily login (D-07): email + password, phone + password, PIN on a returning
 * session, or Google.
 *
 * **Every failure returns the same generic error.** §5.3 is explicit: an
 * unrecognised identifier returns the same failure as a wrong password, never
 * "no such user". Distinguishing them turns this endpoint into a directory of
 * which shops have accounts.
 *
 * OTP is *not* a login method — it verifies identity at signup and at password
 * recovery only, which is what keeps SMS cost proportional to new accounts
 * rather than to daily usage (D-07).
 */
export interface LoginWithPasswordCommand {
  readonly identifier: string;
  readonly password: string;
}

export interface LoginWithGoogleCommand {
  readonly idToken: string;
}

export interface LoginWithPinCommand {
  readonly refreshToken: string;
  readonly pin: string;
}

/** 30 days (§5.3). */
const REFRESH_TOKEN_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_TIMEZONE = 'Asia/Dhaka';

function invalidCredentials(): AppError {
  return new AppError(ErrorCode.UNAUTHENTICATED, 'That login is not correct');
}

export class LoginService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly identifiers: UserIdentifierRepository,
    private readonly users: UserRepository,
    private readonly sessions: SessionRepository,
    private readonly hasher: PasswordHasher,
    private readonly tokens: TokenIssuer,
    private readonly google: GoogleVerifier,
    private readonly audit: AuditWriter,
    private readonly clock: Clock,
  ) {}

  async withPassword(command: LoginWithPasswordCommand): Promise<LoginResponse> {
    const channel = classifyIdentifier(command.identifier.trim());
    // A malformed identifier is still just a failed login, not a hint that the
    // format was the problem.
    if (channel === null) throw invalidCredentials();
    const identifier = normalizeIdentifier(command.identifier, channel);

    return this.signIn(identifier, async (credentials) => {
      if (credentials.passwordHash === null) return false;
      return this.hasher.verify(command.password, credentials.passwordHash);
    });
  }

  /**
   * Google sign-in. If the verified email already has an account, this signs
   * that user in.
   *
   * If it does not, the answer is `GOOGLE_ACCOUNT_UNKNOWN` rather than the
   * generic failure every other login path returns — the caller is then sent to
   * the one-field signup that creates the business (§5.3, D-07 revised
   * 2026-08-17). **This is not the enumeration leak the generic answer exists
   * to prevent:** reaching this line requires a Google ID token for the address,
   * which only its owner can obtain, so it discloses nothing the caller could
   * not already learn about their own mailbox.
   */
  async withGoogle(command: LoginWithGoogleCommand): Promise<LoginResponse> {
    const identity = await this.google.verify(command.idToken);
    const identifier = normalizeIdentifier(identity.email, 'EMAIL');

    const known = await this.uow.runWithoutTenant((tx) =>
      this.identifiers.findOwner(tx, identifier),
    );
    if (known === null) {
      throw new AppError(
        ErrorCode.GOOGLE_ACCOUNT_UNKNOWN,
        'This Google account has no business here yet.',
      );
    }

    return this.signIn(identifier, () => Promise.resolve(true));
  }

  /**
   * PIN login (§5.3): a convenience credential for a returning session on a
   * known device. "Known device" is proved by presenting that device's own
   * unexpired refresh token — the PIN alone is never enough, which is what
   * stops four digits from being a password on a stranger's browser.
   */
  async withPin(command: LoginWithPinCommand): Promise<LoginResponse> {
    const tokenHash = this.tokens.hashRefreshToken(command.refreshToken);

    const outcome = await this.uow.runWithoutTenant<LoginResponse | null>(
      async (tx, adoptTenant) => {
        const session = await this.liveSession(tx, tokenHash);
        const ctx: TenantContext = {
          tenantId: session.tenantId,
          userId: session.userId,
          timezone: DEFAULT_TIMEZONE,
        };
        // The token proved the tenant; everything below is tenant-scoped.
        await adoptTenant(ctx.tenantId);

        const credentials = await this.users.findCredentials(tx, ctx, session.userId);
        // No user, or a user who has never set a PIN — both are simply "no".
        if (credentials === null || credentials.pinHash === null) return null;

        if (!(await this.hasher.verify(command.pin, credentials.pinHash))) {
          // Committed, not thrown — see `signIn`.
          await this.recordFailure(tx, ctx, 'PIN');
          return null;
        }

        // The device keeps its session; the PIN only mints a fresh access token.
        return this.issue(tx, ctx, credentials.username, session.id, 'PIN');
      },
    );

    if (outcome === null) throw invalidCredentials();
    return outcome;
  }

  /** Rotation (§5.3): the presented token is revoked and replaced, every time. */
  async refresh(refreshToken: string): Promise<LoginResponse> {
    const tokenHash = this.tokens.hashRefreshToken(refreshToken);

    return this.uow.runWithoutTenant(async (tx, adoptTenant) => {
      const session = await this.liveSession(tx, tokenHash);
      const ctx: TenantContext = {
        tenantId: session.tenantId,
        userId: session.userId,
        timezone: DEFAULT_TIMEZONE,
      };
      await adoptTenant(ctx.tenantId);

      const credentials = await this.users.findCredentials(tx, ctx, session.userId);
      if (credentials === null) throw invalidCredentials();

      return this.issue(tx, ctx, credentials.username, session.id, 'REFRESH');
    });
  }

  /** Revokes this device's session. Idempotent: logging out twice is not an error. */
  async logout(refreshToken: string): Promise<void> {
    const tokenHash = this.tokens.hashRefreshToken(refreshToken);

    await this.uow.runWithoutTenant(async (tx, adoptTenant) => {
      const session = await this.sessions.findByTokenHash(tx, tokenHash);
      if (session === null || session.revokedAt !== null) return;

      await adoptTenant(session.tenantId);
      await this.sessions.revoke(tx, session.id, null);
      await this.audit.append(
        tx,
        { tenantId: session.tenantId, userId: session.userId, timezone: DEFAULT_TIMEZONE },
        {
          entityType: 'session',
          entityId: session.id,
          action: 'LOGOUT',
          before: null,
          after: null,
          source: 'API',
        },
      );
    });
  }

  /**
   * The shared path for password and Google: resolve the identifier, check the
   * credential, mint a session. Both answer identically on failure.
   */
  private async signIn(
    identifier: string,
    check: (credentials: { passwordHash: string | null }) => Promise<boolean>,
  ): Promise<LoginResponse> {
    const outcome = await this.uow.runWithoutTenant<LoginResponse | null>(
      async (tx, adoptTenant) => {
        const owner = await this.identifiers.findOwner(tx, identifier);
        if (owner === null) return null;

        const ctx: TenantContext = {
          tenantId: owner.tenantId,
          userId: owner.userId,
          timezone: DEFAULT_TIMEZONE,
        };
        // The index proved the tenant; everything below is tenant-scoped.
        await adoptTenant(ctx.tenantId);

        const credentials = await this.users.findCredentials(tx, ctx, owner.userId);
        if (credentials === null) return null;

        if (!(await check(credentials))) {
          // Returned rather than thrown: a rejected login must still **commit**
          // its audit row (§5.22), and throwing here would roll it back with
          // the error that caused it.
          await this.recordFailure(tx, ctx, 'PASSWORD');
          return null;
        }

        return this.issue(tx, ctx, credentials.username, null, 'PASSWORD');
      },
    );

    if (outcome === null) throw invalidCredentials();
    return outcome;
  }

  private async liveSession(tx: Tx, tokenHash: string) {
    const session = await this.sessions.findByTokenHash(tx, tokenHash);
    if (session === null) throw invalidCredentials();
    if (session.revokedAt !== null) throw invalidCredentials();
    if (session.expiresAt.getTime() <= this.clock.now().getTime()) throw invalidCredentials();
    return session;
  }

  /**
   * Mints an access token and a fresh refresh token, rotating out the one that
   * was presented. `replaces` is null on a first login, where there is none.
   */
  private async issue(
    tx: Tx,
    ctx: TenantContext,
    username: string,
    replaces: string | null,
    method: string,
  ): Promise<LoginResponse> {
    const refreshToken = this.tokens.issueRefreshToken();
    const sessionId = Ulid.generate(this.clock);
    const expiresAt = addSeconds(this.clock.now(), REFRESH_TOKEN_SECONDS);

    await this.sessions.create(tx, {
      id: sessionId,
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      tokenHash: this.tokens.hashRefreshToken(refreshToken),
      expiresAt,
    });

    if (replaces !== null) await this.sessions.revoke(tx, replaces, sessionId);

    await this.audit.append(tx, ctx, {
      entityType: 'session',
      entityId: sessionId,
      action: 'LOGIN',
      before: null,
      after: { method },
      source: 'API',
    });

    return {
      accessToken: this.tokens.issueAccessToken(ctx),
      refreshToken,
      user: { id: ctx.userId, username },
    };
  }

  /** A failed attempt is auditable (§5.22) but never tells the caller why. */
  private async recordFailure(tx: Tx, ctx: TenantContext, method: string): Promise<void> {
    await this.audit.append(tx, ctx, {
      entityType: 'session',
      entityId: ctx.userId,
      action: 'LOGIN_FAILED',
      before: null,
      after: { method },
      source: 'API',
    });
  }
}
