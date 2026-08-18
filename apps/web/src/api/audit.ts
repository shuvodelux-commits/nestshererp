import type { AuditListResponse, AuditQuery } from '@sher/core-contracts';

import { request } from './client';

/**
 * The audit trail (slice 1.6, §5.22). Read-only: there is no write function
 * here, because the trail is append-only and nothing may forge a row.
 */
export function fetchAuditEvents(
  token: string,
  query: Partial<Record<keyof AuditQuery, string>> = {},
): Promise<AuditListResponse> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') params.set(key, value);
  }
  const suffix = params.toString();
  return request(`/api/v1/audit-events${suffix === '' ? '' : `?${suffix}`}`, { token });
}
