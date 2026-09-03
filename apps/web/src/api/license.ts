import type {
  LicenseInstallResponse,
  LicenseNotice,
  LicenseStatusResponse,
} from '@sher/core-contracts';

import { request } from './client';

/**
 * The licence (Phase 10, §5.4, D-36, owner decisions 2026-09-02).
 *
 * `envelope: true` on every call: these routes answer with the object itself
 * rather than the `{ data }` wrapper most of the API uses, so the client is
 * told not to unwrap.
 */
export function fetchLicenseStatus(token: string): Promise<LicenseStatusResponse> {
  return request('/api/v1/license', { token, envelope: true });
}

/** The banner. Every signed-in user may read it, whatever their role. */
export function fetchLicenseNotice(token: string): Promise<LicenseNotice> {
  return request('/api/v1/license/notice', { token, envelope: true });
}

/**
 * Install or renew. The pasted key is all that is sent — every decision about
 * what it grants is taken by the server, from the vendor's signature.
 */
export function installLicense(token: string, key: string): Promise<LicenseInstallResponse> {
  return request('/api/v1/license', {
    method: 'POST',
    token,
    envelope: true,
    body: { key },
  });
}
