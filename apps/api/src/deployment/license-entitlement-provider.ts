import type { Entitlement, EntitlementProvider, LicenseKeyStore } from '@sher/core-application';
import { licenseStateAt } from '@sher/core-application';

import type { MachineLicenseState } from './license-machine-state';

/**
 * D-35's on-premise entitlement source: what the installed licence entitles
 * this machine to, right now.
 *
 * The parsing, the signature and the file all moved out — into
 * `Ed25519LicenseVerifier` and `FileLicenseKeyStore` — and what is left is the
 * one question this port exists to answer. Three things shape the answer:
 *
 *   **No licence is READ_ONLY, never a crash** (D-35). A deleted, truncated,
 *   forged or foreign key file all resolve here to the same safe floor, and the
 *   shop can still read its ledgers, sign in and export a backup (D-36).
 *
 *   **The clock is monotonic** (owner decision 2026-09-02). The state is judged
 *   at the later of the system clock and the latest instant this machine has
 *   seen, so winding the date back cannot buy a day of licence.
 *
 *   **The business binding is not checked here**, because this provider does
 *   not know which business is asking. It reports the licence's `businessId`
 *   and `entitlementFor` applies it where a request's tenant is known — the
 *   read-only guard and the access-control step.
 */
export class LicenseKeyEntitlementProvider implements EntitlementProvider {
  constructor(
    private readonly keys: LicenseKeyStore,
    private readonly state: MachineLicenseState,
  ) {}

  current(now: Date): Entitlement {
    const { effectiveNow, behindMs } = this.state.observe(now);
    const licence = this.keys.current();

    if (licence === null) {
      return {
        state: 'READ_ONLY',
        licensed: false,
        modules: [],
        validUntil: null,
        evaluatedAt: effectiveNow,
        businessId: null,
        licenceId: null,
        clockBehindMs: behindMs,
      };
    }

    const renewedFrom = this.state.renewalFrom();
    return {
      state: licenseStateAt(
        {
          validUntil: licence.validUntil,
          issuedAt: licence.issuedAt,
          ...(renewedFrom === null ? {} : { renewedFrom }),
        },
        effectiveNow,
      ),
      licensed: true,
      modules: licence.modules,
      validUntil: licence.validUntil,
      evaluatedAt: effectiveNow,
      businessId: licence.businessId,
      licenceId: licence.licenceId,
      clockBehindMs: behindMs,
    };
  }
}
