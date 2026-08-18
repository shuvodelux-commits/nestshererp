import type { IdentityVerifier, OtpDelivery } from '@sher/core-application';

/**
 * D-33's on-premise verifier: it sends nothing, because on-premise never asks.
 *
 * An on-premise install has no signup flow — the installer seeds the admin
 * account with a forced password change (D-33), and `SINGLE_TENANT_MODE=true`
 * makes the registration routes return 404 (D-34). Nothing should ever reach
 * this class.
 *
 * So it **throws** rather than returning quietly. A verifier that silently
 * succeeded would mean any OTP a caller invented was accepted, and that is
 * precisely the combination boot validation refuses to start with when the
 * deployment is multi-tenant. If a code path does reach here, the install is
 * misconfigured and the loud failure is the useful outcome.
 *
 * It never returns `devCode`: nothing here is a development convenience.
 */
export class NoOpIdentityVerifier implements IdentityVerifier {
  // Parameters are omitted rather than underscore-prefixed: a method may satisfy
  // an interface with fewer parameters, and there is nothing here to name.
  sendOtp(): Promise<OtpDelivery> {
    return Promise.reject(
      new Error(
        'NoOpIdentityVerifier was asked to send an OTP. On-premise installs have no signup ' +
          'flow (D-33/D-34) — the installer seeds the admin account. This is a misconfiguration.',
      ),
    );
  }
}
