import { classifyIdentifier, normalizeIdentifier } from '@sher/core-domain';
import type { OtpPurpose } from '@sher/core-domain';
import { AppError, ErrorCode } from '@sher/core-contracts';
import type { RequestSignupOtpResponse } from '@sher/core-contracts';
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
 * Step one of signup (D-07): one field accepting mobile OR email, a 6-digit OTP
 * to that channel.
 *
 * This runs **before any tenant exists**, so the ten-step write path (R-D) does
 * not apply as written: there is no TenantContext to resolve, no permission to
 * check against a role that has not been created, and no business date to guard.
 * What does apply is the transaction boundary and the audit event — §5.3
 * requires every send, failure and lockout to be audited (R-13, SIM swap).
 *
 * **It is not idempotent, deliberately.** The idempotency store is tenant-scoped
 * and unusable here, and a resend must produce a *new* code — that is the
 * "invalidated on a new request" rule, not a bug to be de-duplicated away.
 */
export interface RequestSignupOtpCommand {
  readonly identifier: string;
}

/** Signup codes are scoped to this purpose; recovery codes cannot be spent here. */
const SIGNUP: OtpPurpose = 'SIGNUP';

export class RequestSignupOtpService {
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

  async execute(command: RequestSignupOtpCommand): Promise<RequestSignupOtpResponse> {
    const channel = classifyIdentifier(command.identifier.trim());
    if (channel === null) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        'Enter a valid mobile number or email address',
      );
    }
    const identifier = normalizeIdentifier(command.identifier, channel);

    return this.uow.runWithoutTenant(async (tx) => {
      // An identifier that already has an account gets the same response as one
      // that does not — and no code. Answering differently turns this endpoint
      // into a "does this shop have an account?" oracle (§5.3 identifier rules).
      const taken = await this.identifiers.isTaken(tx, identifier);
      if (taken) {
        await this.audit.appendPlatform(tx, {
          entityType: 'signup_otp',
          entityId: Ulid.generate(this.clock),
          action: 'SEND_SUPPRESSED',
          before: null,
          after: { channel, reason: 'IDENTIFIER_ALREADY_REGISTERED' },
          source: 'API',
        });
        return { channel };
      }

      // A new request kills the previous code, even inside its 5-minute window.
      await this.otps.invalidateAll(tx, identifier, SIGNUP);

      const code = this.codes.generate();
      const otpId = Ulid.generate(this.clock);
      await this.otps.insert(tx, {
        id: otpId,
        identifier,
        channel,
        purpose: SIGNUP,
        codeHash: await this.hasher.hash(code),
      });

      const delivery = await this.verifier.sendOtp(identifier, channel, code);

      // The code itself is never audited and never logged — only that one was sent.
      await this.audit.appendPlatform(tx, {
        entityType: 'signup_otp',
        entityId: otpId,
        action: 'SEND',
        before: null,
        after: { channel },
        source: 'API',
      });

      return delivery.devCode === undefined
        ? { channel }
        : { channel, devCode: delivery.devCode };
    });
  }
}
