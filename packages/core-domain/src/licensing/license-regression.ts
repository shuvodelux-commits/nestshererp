/**
 * Never let a licence go quietly backwards (owner decision 2026-09-02).
 *
 * A shop's licence key arrives in a message, and messages are scrolled back
 * through. Pasting last year's key must not shorten this year's term, and a key
 * that drops a module the shop is using must not silently take it away. Both
 * are refused outright, and the installed licence is left exactly as it was.
 *
 * **The one way down is signed.** A vendor who genuinely means to issue
 * something smaller says so *in the licence*: `replacement_of` naming the
 * licence being replaced. That is a decision the vendor takes with their
 * signing key, not one an Owner takes by clicking through a warning — a
 * confirmation dialog is exactly how the wrong key gets installed anyway.
 *
 * Pure: two licences in, a verdict out.
 */

/** What a comparison needs. Both the candidate and what is already installed. */
export interface LicenseTerms {
  readonly licenceId: string;
  readonly validUntil: Date;
  /** Empty means every module — an unrestricted licence. */
  readonly modules: readonly string[];
  /** The licence this one is a deliberate, vendor-signed replacement for. */
  readonly replacementOf?: string | null;
}

export type LicenseRegression = 'NONE' | 'EARLIER_EXPIRY' | 'FEWER_MODULES';

/**
 * What installing `candidate` over `current` would take away.
 *
 * `current` is null on a machine with no readable licence — nothing can be lost
 * that is not there, so anything valid is an improvement.
 */
export function licenseRegression(
  candidate: LicenseTerms,
  current: LicenseTerms | null,
): LicenseRegression {
  if (current === null) return 'NONE';

  // The vendor signed "this replaces that", so the shrinking is intended.
  if (candidate.replacementOf !== undefined && candidate.replacementOf === current.licenceId) {
    return 'NONE';
  }

  if (candidate.validUntil.getTime() < current.validUntil.getTime()) return 'EARLIER_EXPIRY';
  if (dropsModules(candidate.modules, current.modules)) return 'FEWER_MODULES';
  return 'NONE';
}

/**
 * Whether the candidate covers less than what is installed.
 *
 * An empty list means *everything*, which is why this cannot be a plain subset
 * check: going from a list to unrestricted is a gain, and going from
 * unrestricted to a list is a loss of every module not on it.
 */
function dropsModules(candidate: readonly string[], current: readonly string[]): boolean {
  if (candidate.length === 0) return false;
  if (current.length === 0) return true;
  return current.some((code) => !candidate.includes(code));
}
