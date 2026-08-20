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
export {
  brandResponseSchema,
  catalogFeaturesSchema,
  catalogNameSchema,
  catalogResponseSchema,
  categoryResponseSchema,
  createCategoryRequestSchema,
  removeCatalogEntryResponseSchema,
  renameCategoryRequestSchema,
  saveBrandRequestSchema,
  saveUnitRequestSchema,
  SEED_UNITS,
  unitResponseSchema,
} from './catalog';
export type {
  BrandResponse,
  CatalogFeatures,
  CatalogResponse,
  CategoryResponse,
  CreateCategoryRequest,
  RemoveCatalogEntryResponse,
  RenameCategoryRequest,
  SaveBrandRequest,
  SaveUnitRequest,
  UnitResponse,
} from './catalog';
export {
  discountTypeSchema,
  generatedBarcodeResponseSchema,
  productConversionSchema,
  productListResponseSchema,
  productQuerySchema,
  productResponseSchema,
  productStatusSchema,
  productSummarySchema,
  saveProductRequestSchema,
  setProductStatusRequestSchema,
  updateProductRequestSchema,
} from './products';
export type {
  DiscountTypeValue,
  GeneratedBarcodeResponse,
  ProductConversion,
  ProductListResponse,
  ProductQuery,
  ProductResponse,
  ProductStatusValue,
  ProductSummary,
  SaveProductRequest,
  SetProductStatusRequest,
  UpdateProductRequest,
} from './products';
export {
  customerGroupResponseSchema,
  partyFieldVisibilitySchema,
  partyListResponseSchema,
  partyQuerySchema,
  partyResponseSchema,
  partyRoleSchema,
  partySetupResponseSchema,
  partyStatusSchema,
  partySummarySchema,
  savePartyRequestSchema,
  saveCustomerGroupRequestSchema,
  setPartyStatusRequestSchema,
  updatePartyRequestSchema,
  WALK_IN_PARTY_NAME,
} from './parties';
export type {
  CustomerGroupResponse,
  PartyFieldVisibility,
  PartyListResponse,
  PartyQuery,
  PartyResponse,
  PartyRoleValue,
  PartySetupResponse,
  PartyStatusValue,
  PartySummary,
  SavePartyRequest,
  SaveCustomerGroupRequest,
  SetPartyStatusRequest,
  UpdatePartyRequest,
} from './parties';

/**
 * Caller-selected list sorting (UI-46, §3.9). The allow-lists live in one place
 * so the API and the Vue client cannot disagree about what a header may sort by.
 */
export {
  defaultDirectionFor,
  partySortSchema,
  productSortSchema,
  sortDirectionSchema,
} from './sorting';
export type { PartySort, ProductSort, SortDirection } from './sorting';
export {
  adjustStockRequestSchema,
  costAdjustmentRowSchema,
  inventoryMovementSchema,
  inventoryLotPageSchema,
  inventoryLotSchema,
  inventoryLotsQuerySchema,
  inventoryLotSortSchema,
  inventoryReportQuerySchema,
  inventoryValuationResponseSchema,
  inventoryValuationRowSchema,
  inventoryOverviewResponseSchema,
  inventoryStockRowSchema,
  openingStockResponseSchema,
  recordOpeningStockRequestSchema,
  stockAdjustmentReasonSchema,
  stockAdjustmentResponseSchema,
  stockAdjustmentRowSchema,
} from './inventory';
export type {
  AdjustStockRequest,
  CostAdjustmentRow,
  InventoryMovement,
  InventoryLot,
  InventoryLotPage,
  InventoryLotsQuery,
  InventoryLotSort,
  InventoryReportQuery,
  InventoryValuationResponse,
  InventoryValuationRow,
  InventoryOverviewResponse,
  InventoryStockRow,
  OpeningStockResponse,
  RecordOpeningStockRequest,
  StockAdjustmentReasonValue,
  StockAdjustmentResponse,
  StockAdjustmentRow,
} from './inventory';
