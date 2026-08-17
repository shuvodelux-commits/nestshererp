import type {
  CreateUserRequest,
  SetUserDisabledRequest,
  UpdateUserRequest,
  UserListResponse,
  UserResponse,
} from '@sher/core-contracts';

import { request } from './client';

/**
 * User administration (slice 1.3). `confirmPassword` on these calls is the
 * **caller's own** password — step-up (§5.3), never the other person's.
 */
export function fetchUsers(token: string): Promise<UserListResponse> {
  return request('/api/v1/users', { token });
}

export function createUser(token: string, payload: CreateUserRequest): Promise<UserResponse> {
  return request('/api/v1/users', { method: 'POST', token, body: payload });
}

export function updateUser(
  token: string,
  userId: string,
  payload: UpdateUserRequest,
): Promise<UserResponse> {
  return request(`/api/v1/users/${userId}`, { method: 'PATCH', token, body: payload });
}

export function setUserDisabled(
  token: string,
  userId: string,
  payload: SetUserDisabledRequest,
): Promise<UserResponse> {
  return request(`/api/v1/users/${userId}/disabled`, { method: 'POST', token, body: payload });
}
