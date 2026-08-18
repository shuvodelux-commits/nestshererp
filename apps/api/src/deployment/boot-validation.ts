import { accessSync, constants } from 'node:fs';

import type { ApiConfig } from '../config';

/**
 * Boot-time validation (§4.4, D-33…D-36).
 *
 * §4.4: "**Boot-time validation is mandatory.** The app refuses to start on:
 * `SINGLE_TENANT_MODE=false` + `IDENTITY_VERIFIER=none` · `ENTITLEMENT_SOURCE=license`
 * with no readable license · `SINGLE_TENANT_MODE=true` + `BILLING_ENABLED=true`."
 *
 * Each of those is a combination that would run, look healthy, and be wrong:
 *
 *   A multi-tenant deployment with no identity verification accepts any signup
 *   for any phone number. `NoOpIdentityVerifier` exists because an on-premise
 *   installer seeds the admin directly; on SaaS it is an open door.
 *
 *   Licence-sourced entitlements with no readable licence would silently fall
 *   to READ_ONLY on every request. That is the correct behaviour for a licence
 *   that *lapses* while running, and the wrong thing to discover at 9am on
 *   install day.
 *
 *   Billing in a single-tenant install would invoice a customer who bought a
 *   perpetual on-premise licence.
 *
 * Refusing at boot is the whole point: these are misconfigurations that a
 * running system reports as ordinary behaviour.
 */
export class BootValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BootValidationError';
  }
}

/** The development transport echoes the OTP back; it is never a production one. */
function isProduction(): boolean {
  return process.env['NODE_ENV'] === 'production';
}

export function validateBootConfig(config: ApiConfig): void {
  if (!config.singleTenantMode && config.identityVerifier === 'none') {
    throw new BootValidationError(
      'IDENTITY_VERIFIER=none is only valid in single-tenant mode (D-33). ' +
        'A multi-tenant deployment with no identity verification would accept any signup. ' +
        'Set SINGLE_TENANT_MODE=true, or choose a real verifier.',
    );
  }

  if (config.singleTenantMode && config.billingEnabled) {
    throw new BootValidationError(
      'BILLING_ENABLED=true is not valid in single-tenant mode (D-34/§4.4). ' +
        'An on-premise install must not bill a customer who bought a licence. ' +
        'Set BILLING_ENABLED=false.',
    );
  }

  if (config.entitlementSource === 'license') {
    if (config.licenseKeyPath === '') {
      throw new BootValidationError(
        'ENTITLEMENT_SOURCE=license requires LICENSE_KEY_PATH (D-35).',
      );
    }
    try {
      accessSync(config.licenseKeyPath, constants.R_OK);
    } catch {
      throw new BootValidationError(
        `ENTITLEMENT_SOURCE=license but the licence at ${config.licenseKeyPath} cannot be read (D-35). ` +
          'A licence that lapses later drops to READ_ONLY; one that was never readable is a broken install.',
      );
    }
    if (config.licensePublicKey === '') {
      throw new BootValidationError(
        'ENTITLEMENT_SOURCE=license but no licence public key is embedded or configured (D-35). ' +
          'Without it every licence would fail verification and the install would run READ_ONLY.',
      );
    }
  }

  if (isProduction() && config.identityVerifier === 'dev') {
    throw new BootValidationError(
      'IDENTITY_VERIFIER=dev echoes the OTP back to the caller and must never run in production (D-33).',
    );
  }

  if (isProduction() && config.identityVerifier === 'otp' && config.smsProvider === 'none') {
    throw new BootValidationError(
      'IDENTITY_VERIFIER=otp requires SMS_PROVIDER (§5.24). ' +
        'No SMS transport is implemented yet — see the slice 1.7 report.',
    );
  }
}
