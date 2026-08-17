import type {
  CreateRoleRequest,
  RoleDetailResponse,
  RoleListResponse,
  UpdateRoleRequest,
} from '@sher/core-contracts';

import { request } from './client';

/**
 * Roles and their permissions (slice 1.4). `confirmPassword` is the caller's
 * own — changing what a role may do re-privileges everyone holding it.
 */
export function fetchRoles(token: string): Promise<RoleListResponse> {
  return request('/api/v1/roles', { token });
}

export function createRole(token: string, payload: CreateRoleRequest): Promise<RoleDetailResponse> {
  return request('/api/v1/roles', { method: 'POST', token, body: payload });
}

export function updateRole(
  token: string,
  roleId: string,
  payload: UpdateRoleRequest,
): Promise<RoleDetailResponse> {
  return request(`/api/v1/roles/${roleId}`, { method: 'PATCH', token, body: payload });
}

/** Carries a body: the step-up password must not travel in a query string. */
export function deleteRole(token: string, roleId: string, confirmPassword: string): Promise<void> {
  return request(`/api/v1/roles/${roleId}`, {
    method: 'DELETE',
    token,
    body: { confirmPassword },
  });
}
