import type { LicenseRejection } from '@sher/core-contracts';

/**
 * What the licence use case needs from the machine (§5.4, D-35).
 *
 * Two ports, both of them deliberately thin. Ed25519, base64 and file handles
 * are platform concerns and live in `apps/api/src/deployment`; what belongs
 * here is only "is this key genuine" and "put this key in place", so that the
 * install use case can be read without knowing either answer's mechanism — and
 * so the same use case works unchanged when a future runtime verifies licences
 * some other way.
 */

/** A licence whose signature has already been checked against a trusted key. */
export interface VerifiedLicense {
  readonly schemaVersion: number;
  readonly licenceId: string;
  readonly signingKeyId: string;
  /** `*` on a development licence, which matches any business on this machine. */
  readonly businessId: string;
  readonly issuedAt: Date;
  readonly validUntil: Date;
  /** Empty means every module. */
  readonly modules: readonly string[];
  readonly replacementOf: string | null;
}

export type LicenseVerification =
  | { readonly ok: true; readonly licence: VerifiedLicense }
  | { readonly ok: false; readonly reason: LicenseRejection; readonly message: string };

export interface LicenseVerifier {
  /**
   * Parse and check a pasted key.
   *
   * **Never throws.** A pasted key is user input on a screen a shopkeeper is
   * standing at, and every way it can be wrong — truncated, forged, from
   * another vendor, from a newer version of SherERP — is an answer they need to
   * read, not a stack trace.
   */
  verify(raw: string): LicenseVerification;
}

export interface LicenseKeyStore {
  /**
   * The licence installed on this machine right now, verified, or null when
   * there is none this build trusts.
   */
  current(): VerifiedLicense | null;

  /**
   * Put a verified key in place and make it the live one.
   *
   * Atomic: the file is written beside its destination and renamed over it, so
   * a machine that loses power mid-install still has exactly one of the two
   * licences and never half of either. Returns having refreshed the cached
   * state, so the very next request is judged by the new licence — a renewal
   * must not need a restart (§5.25's on-premise support reality).
   */
  install(raw: string): Promise<void>;
}
