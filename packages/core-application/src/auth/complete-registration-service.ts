import {
  classifyIdentifier,
  isValidPassword,
  isValidPin,
  normalizeIdentifier,
  rejectionFor,
} from '@sher/core-domain';
import type { IdentifierChannel, OtpPurpose, OtpRejection } from '@sher/core-domain';
import { AppError, ErrorCode } from '@sher/core-contracts';
import type { RegistrationResponse } from '@sher/core-contracts';
import type { Clock } from '@sher/shared-utils';
import { Ulid } from '@sher/shared-utils';

import type { CatalogRepository } from '../catalog/catalog-repository';
import type { PartyRepository } from '../parties/party-repository';
import type { AuditWriter } from '../ports/audit-writer';
import type { PasswordHasher } from '../ports/password-hasher';
import type { TenantContext } from '../ports/tenant-context';
import type { TokenIssuer } from '../ports/token-issuer';
import type { Tx, UnitOfWork } from '../ports/unit-of-work';
import type { OtpRepository } from './otp-repository';
import type {
  RoleRepository,
  TenantRepository,
  UserIdentifierRepository,
  UserRepository,
} from './registration-repository';
import type { SessionRepository } from './session-repository';
import { provisionTenant } from './tenant-provisioning';

/**
 * Step two of signup (D-07): verify the OTP, then set username, password and PIN
 * in the same flow. Succeeding creates the tenant, its Owner role and its first
 * user, and logs that user in.
 *
 * This is the one use case in SherERP that **creates** a tenant rather than
 * acting inside one, so the transaction is opened with the tenant id generated
 * here rather than one resolved from a token. `tenant_id` still never comes from
 * the request payload (R-C4) — the payload has no such field and could not be
 * believed if it did.
 *
 * The ten-step write path (R-D) applies from step 5 onward. Steps 2–4 do not:
 * there is no role yet to hold a permission, no prior operation to replay
 * against a tenant-scoped idempotency store, and no business date to guard. What
 * makes a replay safe instead is the unique index on the identifier plus
 * single-use OTPs — a repeated submit hits one or the other, never a second shop.
 */
export interface CompleteRegistrationCommand {
  readonly identifier: string;
  readonly otpCode: string;
  readonly businessName: string;
  readonly username: string;
  readonly password: string;
  readonly pin: string;
}

/** D-29: every tenant starts in Bangladesh Standard Time; changeable in Settings (§5.21). */
const DEFAULT_TIMEZONE = 'Asia/Dhaka';
const SIGNUP: OtpPurpose = 'SIGNUP';

const REJECTION_ERRORS: Record<OtpRejection, ErrorCode> = {
  // A consumed code is reported as expired: saying "already used" tells an
  // attacker that this identifier finished signing up.
  CONSUMED: ErrorCode.OTP_EXPIRED,
  EXPIRED: ErrorCode.OTP_EXPIRED,
  MAX_ATTEMPTS: ErrorCode.OTP_MAX_ATTEMPTS_EXCEEDED,
};

/**
 * Either the registration succeeded, or it failed in a way the transaction must
 * still **commit** — a wrong code costs an attempt, and a counter that rolls
 * back with the error it caused would let an attacker retry forever. So the
 * failure is carried out of the transaction as a value and thrown outside it,
 * rather than thrown inside and lost on rollback (R-D5: still one transaction).
 */
type Outcome =
  | { readonly ok: true; readonly response: RegistrationResponse }
  | { readonly ok: false; readonly code: ErrorCode; readonly message: string };

export class CompleteRegistrationService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly otps: OtpRepository,
    private readonly identifiers: UserIdentifierRepository,
    private readonly tenants: TenantRepository,
    private readonly roles: RoleRepository,
    private readonly users: UserRepository,
    private readonly sessions: SessionRepository,
    private readonly catalog: CatalogRepository,
    private readonly parties: PartyRepository,
    private readonly hasher: PasswordHasher,
    private readonly tokens: TokenIssuer,
    private readonly audit: AuditWriter,
    private readonly clock: Clock,
  ) {}

  async execute(command: CompleteRegistrationCommand): Promise<RegistrationResponse> {
    const channel = classifyIdentifier(command.identifier.trim());
    if (channel === null) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        'Enter a valid mobile number or email address',
      );
    }
    if (!isValidPassword(command.password)) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        'Password must be at least 8 characters and contain a letter and a number',
      );
    }
    if (!isValidPin(command.pin)) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'PIN must be exactly 4 digits');
    }

    const identifier = normalizeIdentifier(command.identifier, channel);
    const tenantId = Ulid.generate(this.clock);
    const userId = Ulid.generate(this.clock);
    const ctx: TenantContext = { tenantId, userId, timezone: DEFAULT_TIMEZONE };

    const outcome = await this.uow.run(ctx, (tx) =>
      this.register(tx, ctx, command, identifier, channel),
    );

    if (!outcome.ok) throw new AppError(outcome.code, outcome.message);
    return outcome.response;
  }

  private async register(
    tx: Tx,
    ctx: TenantContext,
    command: CompleteRegistrationCommand,
    identifier: string,
    channel: IdentifierChannel,
  ): Promise<Outcome> {
    const verification = await this.verifyOtp(tx, identifier, command.otpCode);
    if (verification !== null) return verification;

    // The unique index on the identifier is what actually prevents two shops on
    // one phone number; this read exists so the answer is a useful error rather
    // than a constraint violation.
    if (await this.identifiers.isTaken(tx, identifier)) {
      return {
        ok: false,
        code: ErrorCode.IDENTIFIER_ALREADY_REGISTERED,
        message: 'This mobile number or email already has an account. Log in instead.',
      };
    }

    const businessName = command.businessName.trim();
    const username = command.username.trim();

    // The shared rule (`provisionTenant`): what it means to create a business
    // is written once and used by both signup paths — OTP here, Google in
    // RegisterWithGoogleService. Only the proof of identity differs.
    const provisioned = await provisionTenant(
      tx,
      ctx,
      {
        tenants: this.tenants,
        roles: this.roles,
        users: this.users,
        identifiers: this.identifiers,
        sessions: this.sessions,
        catalog: this.catalog,
        parties: this.parties,
        tokens: this.tokens,
        audit: this.audit,
        clock: this.clock,
      },
      {
        businessName,
        username,
        identifier,
        channel,
        passwordHash: await this.hasher.hash(command.password),
        pinHash: await this.hasher.hash(command.pin),
        verifiedBy: 'OTP',
      },
    );

    return {
      ok: true,
      response: {
        accessToken: provisioned.accessToken,
        refreshToken: provisioned.refreshToken,
        tenant: { id: ctx.tenantId, name: businessName },
        user: { id: ctx.userId, username },
      },
    };
  }

  /** Returns null when the code is good and now consumed, or the failure to report. */
  private async verifyOtp(tx: Tx, identifier: string, submitted: string): Promise<Outcome | null> {
    const expired = {
      ok: false,
      code: ErrorCode.OTP_EXPIRED,
      message: 'Request a new verification code',
    } as const;

    const otp = await this.otps.findLatest(tx, identifier, SIGNUP);
    if (otp === null) return expired;

    const rejection = rejectionFor(otp, this.clock.now());
    if (rejection !== null) {
      return { ok: false, code: REJECTION_ERRORS[rejection], message: expired.message };
    }

    if (!(await this.hasher.verify(submitted, otp.codeHash))) {
      await this.otps.recordFailedAttempt(tx, otp.id);
      return { ok: false, code: ErrorCode.OTP_INCORRECT, message: 'That code is not correct' };
    }

    await this.otps.consume(tx, otp.id);
    return null;
  }
}
