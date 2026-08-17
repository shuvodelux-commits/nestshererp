// zod schemas, DTOs, error codes and permission codes shared by the API,
// the application layer and (from Phase 1) the Vue client.
export { AppError, ErrorCode, httpStatusFor } from './errors';
export { OWNER_ROLE_CODE, PERMISSION_CATALOGUE, Permission, SEED_ROLES } from './permissions';
export type { PermissionDescriptor, SeedRole } from './permissions';
export { createNoteRequestSchema, noteResponseSchema } from './notes';
export type { CreateNoteRequest, NoteResponse } from './notes';
export {
  changePasswordRequestSchema,
  changePinRequestSchema,
  securitySettingsResponseSchema,
  completeRegistrationRequestSchema,
  dashboardSummaryResponseSchema,
  requestPasswordResetRequestSchema,
  requestPasswordResetResponseSchema,
  resetPasswordRequestSchema,
  registrationResponseSchema,
  requestSignupOtpRequestSchema,
  loginResponseSchema,
  loginWithGoogleRequestSchema,
  loginWithPasswordRequestSchema,
  loginWithPinRequestSchema,
  refreshRequestSchema,
  registerWithGoogleRequestSchema,
  requestSignupOtpResponseSchema,
  verifySignupOtpRequestSchema,
} from './auth';
export type {
  ChangePasswordRequest,
  ChangePinRequest,
  SecuritySettingsResponse,
  CompleteRegistrationRequest,
  DashboardSummaryResponse,
  RequestPasswordResetRequest,
  RequestPasswordResetResponse,
  ResetPasswordRequest,
  RegistrationResponse,
  RequestSignupOtpRequest,
  LoginResponse,
  LoginWithGoogleRequest,
  LoginWithPasswordRequest,
  LoginWithPinRequest,
  RefreshRequest,
  RegisterWithGoogleRequest,
  RequestSignupOtpResponse,
  VerifySignupOtpRequest,
} from './auth';
export {
  createUserRequestSchema,
  roleSummarySchema,
  setUserDisabledRequestSchema,
  updateUserRequestSchema,
  userListResponseSchema,
  userResponseSchema,
} from './users';
export type {
  CreateUserRequest,
  RoleSummaryResponse,
  SetUserDisabledRequest,
  UpdateUserRequest,
  UserListResponse,
  UserResponse,
} from './users';
export {
  createRoleRequestSchema,
  deleteRoleRequestSchema,
  permissionDescriptorSchema,
  roleDetailSchema,
  roleListResponseSchema,
  updateRoleRequestSchema,
} from './roles';
export type {
  CreateRoleRequest,
  DeleteRoleRequest,
  PermissionDescriptorResponse,
  RoleDetailResponse,
  RoleListResponse,
  UpdateRoleRequest,
} from './roles';
