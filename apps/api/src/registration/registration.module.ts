import { Module } from '@nestjs/common';
import type {
  AuditWriter,
  IdentityVerifier,
  OtpCodeGenerator,
  OtpRepository,
  PasswordHasher,
  RoleRepository,
  TenantRepository,
  TokenIssuer,
  UnitOfWork,
  UserIdentifierRepository,
  UserRepository,
} from '@sher/core-application';
import {
  CompleteRegistrationService,
  GetDashboardSummaryService,
  RequestSignupOtpService,
  VerifySignupOtpService,
} from '@sher/core-application';
import type { Clock } from '@sher/shared-utils';

import {
  AUDIT_WRITER,
  CLOCK,
  IDENTITY_VERIFIER,
  OTP_CODE_GENERATOR,
  OTP_REPOSITORY,
  PASSWORD_HASHER,
  ROLE_REPOSITORY,
  TENANT_REPOSITORY,
  TOKEN_ISSUER,
  UNIT_OF_WORK,
  USER_IDENTIFIER_REPOSITORY,
  USER_REPOSITORY,
} from '../infrastructure/tokens';
import { DashboardController } from './dashboard.controller';
import { RegistrationController } from './registration.controller';
import {
  COMPLETE_REGISTRATION_SERVICE,
  GET_DASHBOARD_SUMMARY_SERVICE,
  REQUEST_SIGNUP_OTP_SERVICE,
  VERIFY_SIGNUP_OTP_SERVICE,
} from './tokens';

@Module({
  controllers: [RegistrationController, DashboardController],
  providers: [
    {
      provide: REQUEST_SIGNUP_OTP_SERVICE,
      useFactory: (
        uow: UnitOfWork,
        otps: OtpRepository,
        identifiers: UserIdentifierRepository,
        codes: OtpCodeGenerator,
        hasher: PasswordHasher,
        verifier: IdentityVerifier,
        audit: AuditWriter,
        clock: Clock,
      ): RequestSignupOtpService =>
        new RequestSignupOtpService(uow, otps, identifiers, codes, hasher, verifier, audit, clock),
      inject: [
        UNIT_OF_WORK,
        OTP_REPOSITORY,
        USER_IDENTIFIER_REPOSITORY,
        OTP_CODE_GENERATOR,
        PASSWORD_HASHER,
        IDENTITY_VERIFIER,
        AUDIT_WRITER,
        CLOCK,
      ],
    },
    {
      provide: VERIFY_SIGNUP_OTP_SERVICE,
      useFactory: (
        uow: UnitOfWork,
        otps: OtpRepository,
        hasher: PasswordHasher,
        clock: Clock,
      ): VerifySignupOtpService => new VerifySignupOtpService(uow, otps, hasher, clock),
      inject: [UNIT_OF_WORK, OTP_REPOSITORY, PASSWORD_HASHER, CLOCK],
    },
    {
      provide: COMPLETE_REGISTRATION_SERVICE,
      useFactory: (
        uow: UnitOfWork,
        otps: OtpRepository,
        identifiers: UserIdentifierRepository,
        tenants: TenantRepository,
        roles: RoleRepository,
        users: UserRepository,
        hasher: PasswordHasher,
        tokens: TokenIssuer,
        audit: AuditWriter,
        clock: Clock,
      ): CompleteRegistrationService =>
        new CompleteRegistrationService(
          uow,
          otps,
          identifiers,
          tenants,
          roles,
          users,
          hasher,
          tokens,
          audit,
          clock,
        ),
      inject: [
        UNIT_OF_WORK,
        OTP_REPOSITORY,
        USER_IDENTIFIER_REPOSITORY,
        TENANT_REPOSITORY,
        ROLE_REPOSITORY,
        USER_REPOSITORY,
        PASSWORD_HASHER,
        TOKEN_ISSUER,
        AUDIT_WRITER,
        CLOCK,
      ],
    },
    {
      provide: GET_DASHBOARD_SUMMARY_SERVICE,
      useFactory: (uow: UnitOfWork, tenants: TenantRepository): GetDashboardSummaryService =>
        new GetDashboardSummaryService(uow, tenants),
      inject: [UNIT_OF_WORK, TENANT_REPOSITORY],
    },
  ],
})
export class RegistrationModule {}
