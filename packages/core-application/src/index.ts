// Use cases and ports (repository interfaces). No Drizzle, no pg, no @nestjs/*,
// no Node built-ins — enforced by `pnpm test:boundaries`.
// Re-exported so apps/api reaches the domain through this layer rather than
// importing core-domain directly (§2.1: api → application → domain).
export { OTP_LENGTH } from '@sher/core-domain';
export type { IdentifierChannel } from '@sher/core-domain';

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
export type { IdentityVerifier, OtpDelivery } from './ports/identity-verifier';
export type { OtpCodeGenerator } from './ports/otp-code-generator';
export type { TokenIssuer } from './ports/token-issuer';
export type { EntryMode, Note, NoteRepository } from './notes/note-repository';
export { CreateNoteService, entryModeFor } from './notes/create-note-service';
export type { CreateNoteCommand } from './notes/create-note-service';
export { GetNoteService } from './notes/get-note-service';
export type { NewOtp, OtpRepository, StoredOtp } from './auth/otp-repository';
export type {
  NewRole,
  NewTenant,
  NewUser,
  RoleRepository,
  TenantRepository,
  UserIdentifierRepository,
  UserRepository,
} from './auth/registration-repository';
export { RequestSignupOtpService } from './auth/request-signup-otp-service';
export type { RequestSignupOtpCommand } from './auth/request-signup-otp-service';
export { CompleteRegistrationService } from './auth/complete-registration-service';
export type { CompleteRegistrationCommand } from './auth/complete-registration-service';
export { GetDashboardSummaryService } from './auth/get-dashboard-summary-service';
