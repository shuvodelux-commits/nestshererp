import type { LicenseNotice, LicenseStatusResponse } from '@sher/core-contracts';

import { request } from './client';

/** What the licence says (Phase 10, §5.4, D-36). Read-only: there is no write route. */
export function fetchLicenseStatus(token: string): Promise<LicenseStatusResponse> {
  return request('/api/v1/license', { token });
}

/** The banner. Every signed-in user may read it, whatever their role. */
export function fetchLicenseNotice(token: string): Promise<LicenseNotice> {
  return request('/api/v1/license/notice', { token });
}
