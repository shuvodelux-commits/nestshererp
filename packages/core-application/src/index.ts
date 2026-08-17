// Use cases and ports (repository interfaces). No Drizzle, no pg, no @nestjs/*,
// no Node built-ins — enforced by `pnpm test:boundaries`.
// Re-exported so apps/api reaches the domain through this layer rather than
// importing core-domain directly (§2.1: api → application → domain).
export { OTP_LENGTH } from '@sher/core-domain';
export type { IdentifierChannel, OtpPurpose } from '@sher/core-domain';

export type { TenantContext } from './ports/tenant-context';
export type { Tx, UnitOfWork } from './ports/unit-of-work';
export type { AccessControl } from './ports/access-control';
export type { PeriodGuard } from './ports/period-guard';
export { SYSTEM_ACTOR_ID } from './ports/audit-writer';
export type { AuditEvent, AuditValues, AuditWriter } from './ports/audit-writer';
export type { IdempotencyRecord, IdempotencyStore } from './ports/idempotency-store';
export type { Outbox, OutboxRecord } from './ports/outbox';
export type { NumberingService } from './ports/numbering-service';
export type { PasswordHasher } from './ports/password-hasher';
export type { GoogleIdentity, GoogleVerifier } from './ports/google-verifier';
export type { IdentityVerifier, OtpDelivery } from './ports/identity-verifier';
export type { OtpCodeGenerator } from './ports/otp-code-generator';
export type { TokenIssuer } from './ports/token-issuer';
export type { EntryMode, Note, NoteRepository } from './notes/note-repository';
export { CreateNoteService, entryModeFor } from './notes/create-note-service';
export type { CreateNoteCommand } from './notes/create-note-service';
export { GetNoteService } from './notes/get-note-service';
export type { NewOtp, OtpRepository, StoredOtp } from './auth/otp-repository';
export type {
  IdentifierOwner,
  NewRole,
  NewTenant,
  NewUser,
  RoleRepository,
  TenantRepository,
  RoleSummary,
  UserCredentials,
  UserEdit,
  UserIdentifierRepository,
  UserRepository,
  UserSummary,
} from './auth/registration-repository';
export type {
  NewSession,
  SessionRepository,
  StoredSession,
} from './auth/session-repository';
export { LoginService } from './auth/login-service';
export type {
  LoginWithGoogleCommand,
  LoginWithPasswordCommand,
  LoginWithPinCommand,
} from './auth/login-service';
export { RequestSignupOtpService } from './auth/request-signup-otp-service';
export type { RequestSignupOtpCommand } from './auth/request-signup-otp-service';
export { VerifySignupOtpService } from './auth/verify-signup-otp-service';
export type { VerifySignupOtpCommand } from './auth/verify-signup-otp-service';
export { CompleteRegistrationService } from './auth/complete-registration-service';
export type { CompleteRegistrationCommand } from './auth/complete-registration-service';
export { GetDashboardSummaryService } from './auth/get-dashboard-summary-service';
export { RegisterWithGoogleService } from './auth/register-with-google-service';
export type { RegisterWithGoogleCommand } from './auth/register-with-google-service';
export { provisionTenant } from './auth/tenant-provisioning';
export type {
  ProvisionedTenant,
  ProvisionTenantCommand,
  ProvisionTenantDeps,
} from './auth/tenant-provisioning';
export { RequestPasswordResetService } from './auth/request-password-reset-service';
export type { RequestPasswordResetCommand } from './auth/request-password-reset-service';
export { ResetPasswordService } from './auth/reset-password-service';
export type { ResetPasswordCommand } from './auth/reset-password-service';
export { ChangeCredentialsService } from './auth/change-credentials-service';
export type {
  ChangePasswordCommand,
  ChangePinCommand,
  SecuritySettings,
} from './auth/change-credentials-service';
export { ManageUsersService } from './users/manage-users-service';
export type {
  CreateUserCommand,
  ListUsersCommand,
  SetUserDisabledCommand,
  UpdateUserCommand,
} from './users/manage-users-service';
