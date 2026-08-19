import { normalizeIdentifier, usernameFromEmail } from '@sher/core-domain';
import { AppError, ErrorCode } from '@sher/core-contracts';
import type { RegistrationResponse } from '@sher/core-contracts';
import type { Clock } from '@sher/shared-utils';
import { Ulid } from '@sher/shared-utils';

import type { CatalogRepository } from '../catalog/catalog-repository';
import type { PartyRepository } from '../parties/party-repository';
import type { AuditWriter } from '../ports/audit-writer';
import type { GoogleVerifier } from '../ports/google-verifier';
import type { TenantContext } from '../ports/tenant-context';
import type { TokenIssuer } from '../ports/token-issuer';
import type { UnitOfWork } from '../ports/unit-of-work';
import type {
  RoleRepository,
  TenantRepository,
  UserIdentifierRepository,
  UserRepository,
} from './registration-repository';
import type { SessionRepository } from './session-repository';
import { provisionTenant } from './tenant-provisioning';

/**
 * Signup by Google (§5.3, D-07 revised 2026-08-17).
 *
 * Google's `email_verified` claim is the identity proof that a signup OTP would
 * otherwise provide, so no code is sent on this path. Exactly one field is
 * collected — the business name — and everything else is derived.
 *
 * **The account gets no password and no PIN.** That is the owner's decision, not
 * an omission: `password_hash` and `pin_hash` stay NULL rather than holding a
 * placeholder nobody chose. Until the owner sets a password through
 * forgot-password, Google is the only way in — and forgot-password works,
 * because the Google address is a verified email that can receive an OTP.
 *
 * **The ID token is verified here, independently.** The browser has already had
 * one rejected as unknown by `LoginService.withGoogle`; this is a second,
 * separate request, and re-verifying is what stops the business-name step from
 * being an endpoint that creates a tenant for any email a caller names.
 *
 * The ten-step write path (R-D) applies from step 5 onward, exactly as in
 * `CompleteRegistrationService`: there is no role yet to hold a permission, no
 * tenant-scoped idempotency store to read, and no business date to guard. The
 * unique index on the identifier is what makes a double submit safe — the second
 * one loses the race and is reported as an existing account.
 */
export interface RegisterWithGoogleCommand {
  readonly idToken: string;
  readonly businessName: string;
}

/** D-29: every tenant starts in Bangladesh Standard Time; changeable in Settings (§5.21). */
const DEFAULT_TIMEZONE = 'Asia/Dhaka';

export class RegisterWithGoogleService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly google: GoogleVerifier,
    private readonly identifiers: UserIdentifierRepository,
    private readonly tenants: TenantRepository,
    private readonly roles: RoleRepository,
    private readonly users: UserRepository,
    private readonly sessions: SessionRepository,
    private readonly catalog: CatalogRepository,
    private readonly parties: PartyRepository,
    private readonly tokens: TokenIssuer,
    private readonly audit: AuditWriter,
    private readonly clock: Clock,
  ) {}

  async execute(command: RegisterWithGoogleCommand): Promise<RegistrationResponse> {
    const businessName = command.businessName.trim();
    if (businessName === '') {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Enter your business name');
    }

    // Verified before the transaction opens: a bad token must not even reach
    // the point of generating ids.
    const identity = await this.google.verify(command.idToken);
    const identifier = normalizeIdentifier(identity.email, 'EMAIL');
    const username = usernameFromEmail(identifier);

    const tenantId = Ulid.generate(this.clock);
    const userId = Ulid.generate(this.clock);
    const ctx: TenantContext = { tenantId, userId, timezone: DEFAULT_TIMEZONE };

    return this.uow.run(ctx, async (tx) => {
      // The unique index on the identifier is the real guarantee; this read
      // exists so the answer is a useful error rather than a constraint
      // violation. Unlike the login path, saying "this email already has an
      // account" here reveals nothing: the caller just proved they own it.
      if (await this.identifiers.isTaken(tx, identifier)) {
        throw new AppError(
          ErrorCode.IDENTIFIER_ALREADY_REGISTERED,
          'This Google account already has a business. Sign in instead.',
        );
      }

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
          channel: 'EMAIL',
          // NULL, deliberately — see the class comment.
          passwordHash: null,
          pinHash: null,
          verifiedBy: 'GOOGLE',
        },
      );

      return {
        accessToken: provisioned.accessToken,
        refreshToken: provisioned.refreshToken,
        tenant: { id: ctx.tenantId, name: businessName },
        user: { id: ctx.userId, username },
      };
    });
  }
}
