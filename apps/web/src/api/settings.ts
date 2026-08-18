import type {
  SettingsResponse,
  UpdateBusinessProfileRequest,
  UpdateSettingRequest,
} from '@sher/core-contracts';

import { request } from './client';

/** Settings and feature controls (slice 1.5, §5.21). */
export function fetchSettings(token: string): Promise<SettingsResponse> {
  return request('/api/v1/settings', { token });
}

/**
 * A cascade is a `warnings` array on a `200`, not an error (§5.26) — the save
 * succeeded, and something else went off with it that the owner must be told
 * about. `request` returns `data` alone, so this one call reads the envelope.
 */
export interface SavedSettings {
  readonly settings: SettingsResponse;
  readonly warnings: readonly { readonly code: string; readonly message: string }[];
}

export async function saveSetting(
  token: string,
  payload: UpdateSettingRequest,
): Promise<SavedSettings> {
  const envelope = await request<{
    data: SettingsResponse;
    warnings: readonly { code: string; message: string }[];
  }>('/api/v1/settings/value', { method: 'POST', token, body: payload, envelope: true });

  return { settings: envelope.data, warnings: envelope.warnings };
}

export function saveBusinessProfile(
  token: string,
  payload: UpdateBusinessProfileRequest,
): Promise<SettingsResponse> {
  return request('/api/v1/settings/business', { method: 'PATCH', token, body: payload });
}
