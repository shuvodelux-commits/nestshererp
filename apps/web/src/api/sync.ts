import type {
  SyncConflictResponse,
  SyncPullResponse,
  SyncPushRequest,
  SyncPushResponse,
  SyncStatusResponse,
} from '@sher/core-contracts';

import { request } from './client';

/** Phase 12.4 — the wire between this machine and the shop's books (§5.23). */

export function pushOperations(
  token: string,
  deviceKey: string,
  body: SyncPushRequest,
): Promise<SyncPushResponse> {
  return request('/api/v1/sync/push', {
    method: 'POST',
    token,
    body,
    deviceKey,
    envelope: true,
  });
}

export function pullChanges(
  token: string,
  deviceKey: string,
  cursor: string | null,
  limit = 200,
): Promise<SyncPullResponse> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor !== null) params.set('cursor', cursor);
  return request(`/api/v1/sync/pull?${params.toString()}`, {
    token,
    deviceKey,
    envelope: true,
  });
}

export function fetchSyncStatus(token: string): Promise<SyncStatusResponse> {
  return request('/api/v1/sync/status', { token, envelope: true });
}

export function fetchSyncConflicts(
  token: string,
  status: 'OPEN' | 'RESOLVED' | 'DISCARDED' | 'ALL' = 'OPEN',
): Promise<{ data: readonly SyncConflictResponse[] }> {
  return request(`/api/v1/sync/conflicts?status=${status}`, { token, envelope: true });
}

export function resolveSyncConflict(
  token: string,
  conflictId: string,
  body: { resolution: string; reason?: string; patch?: unknown },
): Promise<SyncConflictResponse> {
  return request(`/api/v1/sync/conflicts/${conflictId}/resolve`, {
    method: 'POST',
    token,
    body,
  });
}
