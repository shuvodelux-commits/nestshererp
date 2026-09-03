import { accessSync, constants } from 'node:fs';

import type { ApiConfig } from '../config';
import { trustedLicenseKeys } from './license-keys';

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

/**
 * Said once at boot, to the console the installer is watching.
 *
 * A warning rather than a refusal, and deliberately: everything reported this
 * way is already visible in the running app as READ_ONLY, so stopping the boot
 * would only remove the screen that explains it.
 */
function warn(message: string): void {
  process.stderr.write(`[licence] ${message}\n`);
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

  /*
   * §4.4 listed "ENTITLEMENT_SOURCE=license with no readable license" as a boot
   * refusal. The owner's decision of 2026-09-02 supersedes that: licence mode
   * is now the default, and a **fresh install has no licence yet** — it has to
   * start, let the Owner sign in, and let them paste a key into Settings →
   * Licence. Refusing to boot would leave no screen on which to fix it.
   *
   * Nothing is lost by starting. A missing or unreadable licence is READ_ONLY
   * (D-35), which is visible on every screen and says what to do about it.
   *
   * What is still worth saying out loud is a deployment that could never
   * validate *any* licence, because no key was embedded at package time and
   * none configured. That is a packaging mistake rather than a licence that
   * lapsed, and it is reported here where whoever installed it will see it.
   */
  if (config.entitlementSource === 'license') {
    if (trustedLicenseKeys(config).length === 0) {
      warn(
        'No licence signing key is embedded in this build or set in LICENSE_TRUSTED_KEYS (D-35). ' +
          'No licence can be verified, so SherERP will run READ_ONLY until one is configured.',
      );
    } else {
      try {
        accessSync(config.licenseKeyPath, constants.R_OK);
      } catch {
        warn(
          `No licence is installed at ${config.licenseKeyPath}. ` +
            'SherERP starts READ_ONLY: sign in, open Settings → Licence and paste the licence key.',
        );
      }
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
