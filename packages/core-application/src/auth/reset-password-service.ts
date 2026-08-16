import {
  classifyIdentifier,
  isValidPassword,
  normalizeIdentifier,
  rejectionFor,
} from '@sher/core-domain';
import type { OtpPurpose, OtpRejection } from '@sher/core-domain';
import { AppError, ErrorCode } from '@sher/core-contracts';
import type { Clock } from '@sher/shared-utils';

import type { AuditWriter } from '../ports/audit-writer';
import type { PasswordHasher } from '../ports/password-hasher';
import type { TenantContext } from '../ports/tenant-context';
import type { Tx, UnitOfWork } from '../ports/unit-of-work';
import type { OtpRepository } from './otp-repository';
import type { UserIdentifierRepository, UserRepository } from './registration-repository';
import type { SessionRepository } from './session-repository';

/**
 * Step two of forgot-password (D-07): verify the code, set a new password.
 *
 * **It does not sign anyone in.** Recovery proves control of a phone number or
 * mailbox, which is weaker than knowing the password; handing back a session
 * would make an intercepted SMS a full account takeover in one step. The person
 * logs in afterwards with the password they just chose.
 *
 * **Every live session is revoked**, not merely the other ones. A forgotten
 * password is indistinguishable from a stolen account, and a session minted
 * before the reset is exactly the thing an attacker would be holding.
 *
 * The ten-step write path applies from step 5 onward. Steps 2–4 do not: the
 * caller is unauthenticated by definition, so there is no role to hold a
 * permission and no tenant-scoped idempotency store to read. Single use of the
 * OTP is what makes a replay harmless — the second submit finds a consumed code.
 */
export interface ResetPasswordCommand {
  readonly identifier: string;
  readonly otpCode: string;
  readonly password: string;
}

const PASSWORD_RESET: OtpPurpose = 'PASSWORD_RESET';
const DEFAULT_TIMEZONE = 'Asia/Dhaka';

const REJECTION_ERRORS: Record<OtpRejection, ErrorCode> = {
  CONSUMED: ErrorCode.OTP_EXPIRED,
  EXPIRED: ErrorCode.OTP_EXPIRED,
  MAX_ATTEMPTS: ErrorCode.OTP_MAX_ATTEMPTS_EXCEEDED,
};

/**
 * A wrong code must **commit** its attempt counter, so the failure leaves the
 * transaction as a value and is thrown outside it. Throwing inside would roll
 * the counter back with the error that caused it, and the 5-attempt cap would
 * never be reached (R-D5: still one transaction).
 */
type Outcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: ErrorCode; readonly message: string };

export class ResetPasswordService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly otps: OtpRepository,
    private readonly identifiers: UserIdentifierRepository,
    private readonly users: UserRepository,
    private readonly sessions: SessionRepository,
    private readonly hasher: PasswordHasher,
    private readonly audit: AuditWriter,
    private readonly clock: Clock,
  ) {}

  async execute(command: ResetPasswordCommand): Promise<void> {
    const channel = classifyIdentifier(command.identifier.trim());
    if (channel === null) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        'Enter a valid mobile number or email address',
      );
    }
    // Checked before the code is spent: rejecting a weak password afterwards
    // would burn the single-use OTP and force another SMS.
    if (!isValidPassword(command.password)) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        'Password must be at least 8 characters and contain a letter and a number',
      );
    }
    const identifier = normalizeIdentifier(command.identifier, channel);

    const outcome = await this.uow.runWithoutTenant<Outcome>((tx, adoptTenant) =>
      this.reset(tx, adoptTenant, identifier, command),
    );

    if (!outcome.ok) throw new AppError(outcome.code, outcome.message);
  }

  private async reset(
    tx: Tx,
    adoptTenant: (tenantId: string) => Promise<void>,
    identifier: string,
    command: ResetPasswordCommand,
  ): Promise<Outcome> {
    const expired = {
      ok: false,
      code: ErrorCode.OTP_EXPIRED,
      message: 'Request a new verification code',
    } as const;

    // An identifier with no account cannot have been sent a code, so it can only
    // fail as "no live code" — the same answer a stale code gets.
    const owner = await this.identifiers.findOwner(tx, identifier);
    if (owner === null) return expired;

    const otp = await this.otps.findLatest(tx, identifier, PASSWORD_RESET);
    if (otp === null) return expired;

    const rejection = rejectionFor(otp, this.clock.now());
    if (rejection !== null) {
      return { ok: false, code: REJECTION_ERRORS[rejection], message: expired.message };
    }

    if (!(await this.hasher.verify(command.otpCode, otp.codeHash))) {
      await this.otps.recordFailedAttempt(tx, otp.id);
      return { ok: false, code: ErrorCode.OTP_INCORRECT, message: 'That code is not correct' };
    }

    await this.otps.consume(tx, otp.id);

    // The index proved the tenant; the credential write below is tenant-scoped.
    await adoptTenant(owner.tenantId);
    const ctx: TenantContext = {
      tenantId: owner.tenantId,
      userId: owner.userId,
      timezone: DEFAULT_TIMEZONE,
    };

    await this.users.updatePasswordHash(
      tx,
      ctx,
      owner.userId,
      await this.hasher.hash(command.password),
    );
    // Null: no device is trusted through a recovery, including this one.
    await this.sessions.revokeAllForUser(tx, ctx.tenantId, ctx.userId, null);

    // Neither the old nor the new password appears here — an audit trail records
    // that a credential changed, never what it changed to (§5.3).
    await this.audit.append(tx, ctx, {
      entityType: 'user',
      entityId: ctx.userId,
      action: 'PASSWORD_RESET',
      before: null,
      after: { credential: 'PASSWORD', via: 'OTP' },
      source: 'API',
    });

    return { ok: true };
  }
}
