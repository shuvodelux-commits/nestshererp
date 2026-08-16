import { Global, Module } from '@nestjs/common';
import {
  createDatabase,
  createPool,
  PostgresAccessControl,
  PostgresAuditWriter,
  PostgresIdempotencyStore,
  PostgresNoteRepository,
  PostgresNumberingService,
  PostgresOtpRepository,
  PostgresOutbox,
  PostgresPeriodGuard,
  PostgresRoleRepository,
  PostgresSessionRepository,
  PostgresTenantRepository,
  PostgresUnitOfWork,
  PostgresUserIdentifierRepository,
  PostgresUserRepository,
} from '@sher/adapter-postgres';
import type { GoogleVerifier, IdentityVerifier } from '@sher/core-application';
import type { Clock } from '@sher/shared-utils';
import { SystemClock } from '@sher/shared-utils';
import type pg from 'pg';

import { DevIdentityVerifier } from '../auth/dev-identity-verifier';
import { GoogleIdTokenVerifier, UnconfiguredGoogleVerifier } from '../auth/google-verifier';
import { CryptoOtpCodeGenerator } from '../auth/otp-code-generator';
import { ScryptPasswordHasher } from '../auth/password-hasher';
import { JwtTokenIssuer } from '../auth/token-issuer';
import { loadConfig } from '../config';
import type { ApiConfig } from '../config';
import {
  ACCESS_CONTROL,
  API_CONFIG,
  AUDIT_WRITER,
  CLOCK,
  DATABASE_POOL,
  IDEMPOTENCY_STORE,
  IDENTITY_VERIFIER,
  NOTE_REPOSITORY,
  NUMBERING_SERVICE,
  OTP_CODE_GENERATOR,
  OTP_REPOSITORY,
  OUTBOX,
  PASSWORD_HASHER,
  PERIOD_GUARD,
  ROLE_REPOSITORY,
  TENANT_REPOSITORY,
  TOKEN_ISSUER,
  GOOGLE_VERIFIER,
  SESSION_REPOSITORY,
  UNIT_OF_WORK,
  USER_IDENTIFIER_REPOSITORY,
  USER_REPOSITORY,
} from './tokens';

/**
 * D-33 ships three verifiers; slice 1.1 ships only the development one. Picking
 * it in production would accept any code a caller invents, so boot fails loudly
 * instead — the real transports arrive in slice 1.7.
 */
function selectIdentityVerifier(): IdentityVerifier {
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error(
      'No production IdentityVerifier is implemented yet (D-33 / slice 1.7). ' +
        'Refusing to start with the development OTP transport.',
    );
  }
  return new DevIdentityVerifier();
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
    { provide: IDENTITY_VERIFIER, useFactory: selectIdentityVerifier },
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
  ],
})
export class PersistenceModule {}
