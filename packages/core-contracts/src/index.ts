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
  myAccessResponseSchema,
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
  MyAccessResponse,
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
export {
  SETTING_CATALOGUE,
  SettingKey,
  SUPPORTED_TIMEZONES,
  TOGGLE_OFF,
  TOGGLE_ON,
  settingDescriptorSchema,
  settingsResponseSchema,
  updateBusinessProfileRequestSchema,
  updateSettingRequestSchema,
} from './settings';
export type {
  SettingDescriptor,
  SettingDescriptorResponse,
  SettingKind,
  SettingsResponse,
  UpdateBusinessProfileRequest,
  UpdateSettingRequest,
} from './settings';
export {
  AUDIT_PAGE_DEFAULT,
  AUDIT_PAGE_MAX,
  auditEventSchema,
  auditListResponseSchema,
  auditPageSchema,
  auditQuerySchema,
} from './audit';
export type { AuditEventResponse, AuditListResponse, AuditQuery } from './audit';
