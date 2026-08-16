// zod schemas, DTOs, error codes and permission codes shared by the API,
// the application layer and (from Phase 1) the Vue client.
export { AppError, ErrorCode, httpStatusFor } from './errors';
export { Permission } from './permissions';
export { createNoteRequestSchema, noteResponseSchema } from './notes';
export type { CreateNoteRequest, NoteResponse } from './notes';
export {
  completeRegistrationRequestSchema,
  dashboardSummaryResponseSchema,
  registrationResponseSchema,
  requestSignupOtpRequestSchema,
  requestSignupOtpResponseSchema,
} from './auth';
export type {
  CompleteRegistrationRequest,
  DashboardSummaryResponse,
  RegistrationResponse,
  RequestSignupOtpRequest,
  RequestSignupOtpResponse,
} from './auth';
