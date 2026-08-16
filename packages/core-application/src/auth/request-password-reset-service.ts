import { classifyIdentifier, normalizeIdentifier } from '@sher/core-domain';
import type { OtpPurpose } from '@sher/core-domain';
import { AppError, ErrorCode } from '@sher/core-contracts';
import type { RequestPasswordResetResponse } from '@sher/core-contracts';
import type { Clock } from '@sher/shared-utils';
import { Ulid } from '@sher/shared-utils';

import type { AuditWriter } from '../ports/audit-writer';
import type { IdentityVerifier } from '../ports/identity-verifier';
import type { OtpCodeGenerator } from '../ports/otp-code-generator';
import type { PasswordHasher } from '../ports/password-hasher';
import type { UnitOfWork } from '../ports/unit-of-work';
import type { OtpRepository } from './otp-repository';
import type { UserIdentifierRepository } from './registration-repository';

/**
 * Step one of forgot-password (D-07): enter email or phone, get a 6-digit OTP.
 *
 * The mirror image of `RequestSignupOtpService`: that one sends a code when the
 * identifier is **free**, this one sends when it is **taken**. Both answer
 * identically in either case, so neither can be used to ask "does this shop have
 * an account?" (§5.3 identifier rules).
 *
 * The ten-step write path (R-D) does not apply as written — this runs before
 * authentication, so there is no TenantContext to resolve, no role to check a
 * permission against, and no business date to guard. What does apply is the one
 * transaction and the audit event: §5.3 requires every send, failure and lockout
 * to be audited (R-13, SIM swap).
 *
 * **Not idempotent, deliberately.** A resend must produce a *new* code — that is
 * the "invalidated on a new request" rule, not a duplicate to be collapsed.
 */
export interface RequestPasswordResetCommand {
  readonly identifier: string;
}

const PASSWORD_RESET: OtpPurpose = 'PASSWORD_RESET';

export class RequestPasswordResetService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly otps: OtpRepository,
    private readonly identifiers: UserIdentifierRepository,
    private readonly codes: OtpCodeGenerator,
    private readonly hasher: PasswordHasher,
    private readonly verifier: IdentityVerifier,
    private readonly audit: AuditWriter,
    private readonly clock: Clock,
  ) {}

  async execute(command: RequestPasswordResetCommand): Promise<RequestPasswordResetResponse> {
    const channel = classifyIdentifier(command.identifier.trim());
    if (channel === null) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        'Enter a valid mobile number or email address',
      );
    }
    const identifier = normalizeIdentifier(command.identifier, channel);

    return this.uow.runWithoutTenant(async (tx, adoptTenant) => {
      // An identifier with no account gets the same response as one that has
      // it — and no code. The channel is known from the *format* of what was
      // typed, so answering with it reveals nothing about who exists.
      const owner = await this.identifiers.findOwner(tx, identifier);
      if (owner === null) {
        await this.audit.appendPlatform(tx, {
          entityType: 'password_reset_otp',
          entityId: Ulid.generate(this.clock),
          action: 'SEND_SUPPRESSED',
          before: null,
          after: { channel, reason: 'IDENTIFIER_NOT_REGISTERED' },
          source: 'API',
        });
        return { channel };
      }

      // The index proved the tenant, so the audit row below can be written
      // inside it — the only widening this transaction does (R-C4).
      await adoptTenant(owner.tenantId);

      // A new request kills the previous reset code, even inside its 5 minutes.
      await this.otps.invalidateAll(tx, identifier, PASSWORD_RESET);

      const code = this.codes.generate();
      const otpId = Ulid.generate(this.clock);
      await this.otps.insert(tx, {
        id: otpId,
        identifier,
        channel,
        purpose: PASSWORD_RESET,
        codeHash: await this.hasher.hash(code),
      });

      const delivery = await this.verifier.sendOtp(identifier, channel, code);

      // The identifier resolved to a real account, so this send belongs to that
      // tenant and is auditable inside it — unlike a signup code, which belongs
      // to no tenant because none exists yet. The code itself is never audited.
      await this.audit.append(
        tx,
        { tenantId: owner.tenantId, userId: owner.userId, timezone: DEFAULT_TIMEZONE },
        {
          entityType: 'password_reset_otp',
          entityId: otpId,
          action: 'SEND',
          before: null,
          after: { channel },
          source: 'API',
        },
      );

      return delivery.devCode === undefined ? { channel } : { channel, devCode: delivery.devCode };
    });
  }
}

/**
 * The audit row is written before the tenant's own timezone has been read — and
 * an audit event stores an instant, not a business date, so the timezone here
 * decides nothing about a stored number (D-29 default).
 */
const DEFAULT_TIMEZONE = 'Asia/Dhaka';
