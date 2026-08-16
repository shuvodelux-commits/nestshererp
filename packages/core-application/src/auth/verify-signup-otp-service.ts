import { classifyIdentifier, normalizeIdentifier, rejectionFor } from '@sher/core-domain';
import type { OtpPurpose, OtpRejection } from '@sher/core-domain';
import { AppError, ErrorCode } from '@sher/core-contracts';
import type { Clock } from '@sher/shared-utils';

import type { PasswordHasher } from '../ports/password-hasher';
import type { Tx, UnitOfWork } from '../ports/unit-of-work';
import type { OtpRepository } from './otp-repository';

/**
 * Checks a signup code **without consuming it**, so the UI can tell someone
 * their code is wrong at the moment they type it rather than three fields later.
 *
 * Consumption stays in `CompleteRegistrationService`: a code is spent when it
 * creates an account, not when it is looked at. The 5-minute expiry and the
 * 5-attempt cap still apply here, so this is not a free brute-force oracle —
 * a wrong guess costs an attempt exactly as it does on the final submit.
 */
export interface VerifySignupOtpCommand {
  readonly identifier: string;
  readonly otpCode: string;
}

const SIGNUP: OtpPurpose = 'SIGNUP';

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
type Outcome = { readonly ok: true } | { readonly ok: false; readonly code: ErrorCode };

export class VerifySignupOtpService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly otps: OtpRepository,
    private readonly hasher: PasswordHasher,
    private readonly clock: Clock,
  ) {}

  async execute(command: VerifySignupOtpCommand): Promise<void> {
    const channel = classifyIdentifier(command.identifier.trim());
    if (channel === null) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        'Enter a valid mobile number or email address',
      );
    }
    const identifier = normalizeIdentifier(command.identifier, channel);

    const outcome = await this.uow.runWithoutTenant((tx) =>
      this.check(tx, identifier, command.otpCode),
    );

    if (!outcome.ok) {
      throw new AppError(
        outcome.code,
        outcome.code === ErrorCode.OTP_INCORRECT
          ? 'That code is not correct'
          : 'Request a new verification code',
      );
    }
  }

  private async check(tx: Tx, identifier: string, submitted: string): Promise<Outcome> {
    const otp = await this.otps.findLatest(tx, identifier, SIGNUP);
    if (otp === null) return { ok: false, code: ErrorCode.OTP_EXPIRED };

    const rejection = rejectionFor(otp, this.clock.now());
    if (rejection !== null) return { ok: false, code: REJECTION_ERRORS[rejection] };

    if (!(await this.hasher.verify(submitted, otp.codeHash))) {
      await this.otps.recordFailedAttempt(tx, otp.id);
      return { ok: false, code: ErrorCode.OTP_INCORRECT };
    }

    return { ok: true };
  }
}
