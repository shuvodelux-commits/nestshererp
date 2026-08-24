import { Global, Module } from '@nestjs/common';
import {
  createDatabase,
  createPool,
  PostgresAccessControl,
  PostgresAuditQueryRepository,
  PostgresAuditWriter,
  PostgresBusinessProfileRepository,
  PostgresCatalogRepository,
  PostgresIdempotencyStore,
  PostgresInventoryRepository,
  PostgresNoteRepository,
  PostgresNumberingService,
  PostgresOtpRepository,
  PostgresMoneyRepository,
  PostgresPartyRepository,
  PostgresProductRepository,
  PostgresOutbox,
  PostgresPeriodGuard,
  PostgresRoleRepository,
  PostgresSessionRepository,
  PostgresSettingsRepository,
  PostgresTenantRepository,
  PostgresUnitOfWork,
  PostgresUserIdentifierRepository,
  PostgresUserRepository,
} from '@sher/adapter-postgres';
import type { EntitlementProvider, GoogleVerifier, IdentityVerifier } from '@sher/core-application';
import type { Clock } from '@sher/shared-utils';
import { SystemClock } from '@sher/shared-utils';
import type pg from 'pg';

import { DevIdentityVerifier } from '../auth/dev-identity-verifier';
import { NoOpIdentityVerifier } from '../auth/noop-identity-verifier';
import { LicenseKeyEntitlementProvider } from '../deployment/license-entitlement-provider';
import { SubscriptionEntitlementProvider } from '../deployment/subscription-entitlement-provider';
import { GoogleIdTokenVerifier, UnconfiguredGoogleVerifier } from '../auth/google-verifier';
import { CryptoOtpCodeGenerator } from '../auth/otp-code-generator';
import { ScryptPasswordHasher } from '../auth/password-hasher';
import { JwtTokenIssuer } from '../auth/token-issuer';
import { loadConfig } from '../config';
import type { ApiConfig } from '../config';
import {
  ACCESS_CONTROL,
  API_CONFIG,
  AUDIT_QUERY_REPOSITORY,
  ENTITLEMENT_PROVIDER,
  AUDIT_WRITER,
  BUSINESS_PROFILE_REPOSITORY,
  CATALOG_REPOSITORY,
  CLOCK,
  DATABASE_POOL,
  IDEMPOTENCY_STORE,
  INVENTORY_REPOSITORY,
  IDENTITY_VERIFIER,
  NOTE_REPOSITORY,
  NUMBERING_SERVICE,
  OTP_CODE_GENERATOR,
  OTP_REPOSITORY,
  OUTBOX,
  PASSWORD_HASHER,
  PERIOD_GUARD,
  MONEY_REPOSITORY,
  PARTY_REPOSITORY,
  PRODUCT_REPOSITORY,
  ROLE_REPOSITORY,
  TENANT_REPOSITORY,
  TOKEN_ISSUER,
  GOOGLE_VERIFIER,
  SESSION_REPOSITORY,
  SETTINGS_REPOSITORY,
  UNIT_OF_WORK,
  USER_IDENTIFIER_REPOSITORY,
  USER_REPOSITORY,
} from './tokens';

/**
 * D-33's verifier, chosen by `IDENTITY_VERIFIER` (§4.4) rather than by
 * `NODE_ENV` — a deployment mode is configuration, not an environment guess.
 *
 * `otp` is the SaaS transport and is **not implemented**: it needs a chosen SMS
 * provider, an account and a sender id (§5.24, D-33), none of which exist yet.
 * It throws here rather than falling back to `dev`, because a silent fallback
 * would accept any code the caller invents. Boot validation refuses the
 * combination in production before this is ever reached.
 */
function selectIdentityVerifier(config: ApiConfig): IdentityVerifier {
  switch (config.identityVerifier) {
    case 'none':
      return new NoOpIdentityVerifier();
    case 'dev':
      return new DevIdentityVerifier();
    case 'otp':
      throw new Error(
        'IDENTITY_VERIFIER=otp is not implemented: no SMS/email transport has been chosen ' +
          '(D-33, §5.24). Use IDENTITY_VERIFIER=none for on-premise, or dev outside production.',
      );
  }
}

/**
 * D-35's entitlement source. On-premise answers from a signed licence file
 * validated offline; SaaS answers from the subscription, which is a permissive
 * stub until Phase 10 (§5.4).
 *
 * On-premise does **not** skip entitlement checks — it answers them from the
 * licence. That is why this is a provider choice and not an `if (isOnPrem)`.
 */
function selectEntitlementProvider(config: ApiConfig): EntitlementProvider {
  return config.entitlementSource === 'license'
    ? new LicenseKeyEntitlementProvider(config.licenseKeyPath, config.licensePublicKey)
    : new SubscriptionEntitlementProvider();
}

/**
 * The single wiring point between the application layer and PostgreSQL.
 *
 * Use cases depend on interfaces only; this module decides which implementation
 * satisfies them. Swapping in the SQLite WASM adapter in Phase 12 is a change
 * here and nowhere else (D-14).
 */
@Global()
@Module({
  providers: [
    { provide: API_CONFIG, useFactory: loadConfig },
    { provide: CLOCK, useFactory: (): Clock => new SystemClock() },
    {
      provide: DATABASE_POOL,
      useFactory: (config: ApiConfig): pg.Pool => createPool(config.databaseUrl),
      inject: [API_CONFIG],
    },
    {
      provide: UNIT_OF_WORK,
      useFactory: (pool: pg.Pool): PostgresUnitOfWork =>
        new PostgresUnitOfWork(createDatabase(pool)),
      inject: [DATABASE_POOL],
    },
    { provide: ACCESS_CONTROL, useFactory: (): PostgresAccessControl => new PostgresAccessControl() },
    { provide: PERIOD_GUARD, useFactory: (): PostgresPeriodGuard => new PostgresPeriodGuard() },
    {
      provide: AUDIT_WRITER,
      useFactory: (clock: Clock): PostgresAuditWriter => new PostgresAuditWriter(clock),
      inject: [CLOCK],
    },
    {
      provide: IDEMPOTENCY_STORE,
      useFactory: (clock: Clock): PostgresIdempotencyStore => new PostgresIdempotencyStore(clock),
      inject: [CLOCK],
    },
    {
      provide: OUTBOX,
      useFactory: (clock: Clock): PostgresOutbox => new PostgresOutbox(clock),
      inject: [CLOCK],
    },
    {
      provide: NUMBERING_SERVICE,
      useFactory: (clock: Clock): PostgresNumberingService => new PostgresNumberingService(clock),
      inject: [CLOCK],
    },
    {
      provide: NOTE_REPOSITORY,
      useFactory: (clock: Clock): PostgresNoteRepository => new PostgresNoteRepository(clock),
      inject: [CLOCK],
    },
    { provide: PASSWORD_HASHER, useFactory: (): ScryptPasswordHasher => new ScryptPasswordHasher() },
    {
      provide: OTP_CODE_GENERATOR,
      useFactory: (): CryptoOtpCodeGenerator => new CryptoOtpCodeGenerator(),
    },
    { provide: IDENTITY_VERIFIER, useFactory: selectIdentityVerifier, inject: [API_CONFIG] },
    {
      provide: ENTITLEMENT_PROVIDER,
      useFactory: selectEntitlementProvider,
      inject: [API_CONFIG],
    },
    {
      provide: TOKEN_ISSUER,
      useFactory: (config: ApiConfig, clock: Clock): JwtTokenIssuer =>
        new JwtTokenIssuer(config.jwtSecret, clock),
      inject: [API_CONFIG, CLOCK],
    },
    {
      provide: OTP_REPOSITORY,
      useFactory: (clock: Clock): PostgresOtpRepository => new PostgresOtpRepository(clock),
      inject: [CLOCK],
    },
    {
      provide: TENANT_REPOSITORY,
      useFactory: (clock: Clock): PostgresTenantRepository => new PostgresTenantRepository(clock),
      inject: [CLOCK],
    },
    {
      provide: ROLE_REPOSITORY,
      useFactory: (clock: Clock): PostgresRoleRepository => new PostgresRoleRepository(clock),
      inject: [CLOCK],
    },
    {
      provide: USER_REPOSITORY,
      useFactory: (clock: Clock): PostgresUserRepository => new PostgresUserRepository(clock),
      inject: [CLOCK],
    },
    {
      provide: USER_IDENTIFIER_REPOSITORY,
      useFactory: (clock: Clock): PostgresUserIdentifierRepository =>
        new PostgresUserIdentifierRepository(clock),
      inject: [CLOCK],
    },
    {
      provide: SESSION_REPOSITORY,
      useFactory: (clock: Clock): PostgresSessionRepository => new PostgresSessionRepository(clock),
      inject: [CLOCK],
    },
    {
      provide: GOOGLE_VERIFIER,
      useFactory: (config: ApiConfig, clock: Clock): GoogleVerifier =>
        config.googleClientId === ''
          ? new UnconfiguredGoogleVerifier()
          : new GoogleIdTokenVerifier(config.googleClientId, clock),
      inject: [API_CONFIG, CLOCK],
    },
    {
      provide: SETTINGS_REPOSITORY,
      useFactory: (clock: Clock): PostgresSettingsRepository =>
        new PostgresSettingsRepository(clock),
      inject: [CLOCK],
    },
    {
      provide: BUSINESS_PROFILE_REPOSITORY,
      useFactory: (clock: Clock): PostgresBusinessProfileRepository =>
        new PostgresBusinessProfileRepository(clock),
      inject: [CLOCK],
    },
    {
      provide: AUDIT_QUERY_REPOSITORY,
      useFactory: (): PostgresAuditQueryRepository => new PostgresAuditQueryRepository(),
    },
    {
      provide: CATALOG_REPOSITORY,
      useFactory: (clock: Clock): PostgresCatalogRepository => new PostgresCatalogRepository(clock),
      inject: [CLOCK],
    },
    {
      provide: PRODUCT_REPOSITORY,
      useFactory: (clock: Clock): PostgresProductRepository => new PostgresProductRepository(clock),
      inject: [CLOCK],
    },
    {
      provide: PARTY_REPOSITORY,
      useFactory: (clock: Clock): PostgresPartyRepository => new PostgresPartyRepository(clock),
      inject: [CLOCK],
    },
    {
      provide: MONEY_REPOSITORY,
      useFactory: (clock: Clock): PostgresMoneyRepository => new PostgresMoneyRepository(clock),
      inject: [CLOCK],
    },
    {
      provide: INVENTORY_REPOSITORY,
      useFactory: (clock: Clock): PostgresInventoryRepository => new PostgresInventoryRepository(clock),
      inject: [CLOCK],
    },
  ],
  exports: [
    API_CONFIG,
    CLOCK,
    DATABASE_POOL,
    UNIT_OF_WORK,
    ACCESS_CONTROL,
    PERIOD_GUARD,
    AUDIT_WRITER,
    IDEMPOTENCY_STORE,
    OUTBOX,
    NUMBERING_SERVICE,
    NOTE_REPOSITORY,
    INVENTORY_REPOSITORY,
    PASSWORD_HASHER,
    OTP_CODE_GENERATOR,
    IDENTITY_VERIFIER,
    TOKEN_ISSUER,
    OTP_REPOSITORY,
    TENANT_REPOSITORY,
    ROLE_REPOSITORY,
    USER_REPOSITORY,
    USER_IDENTIFIER_REPOSITORY,
    SESSION_REPOSITORY,
    GOOGLE_VERIFIER,
    SETTINGS_REPOSITORY,
    BUSINESS_PROFILE_REPOSITORY,
    AUDIT_QUERY_REPOSITORY,
    ENTITLEMENT_PROVIDER,
    CATALOG_REPOSITORY,
    PRODUCT_REPOSITORY,
    PARTY_REPOSITORY,
    MONEY_REPOSITORY,
  ],
})
export class PersistenceModule {}
