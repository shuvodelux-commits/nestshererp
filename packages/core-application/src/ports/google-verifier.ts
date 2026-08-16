/**
 * Verifies a Google ID token and returns the identity inside it (D-07).
 *
 * A port because verification needs `node:crypto` and a network call to
 * Google's key set, neither of which this package may reach for.
 *
 * The implementation must check the signature against Google's published keys,
 * the issuer, the audience (our own client id) and the expiry — and must reject
 * an unverified email. Accepting `email` without `email_verified` would let
 * anyone claim any address by putting it in a Google profile.
 */
export interface GoogleIdentity {
  readonly email: string;
}

export interface GoogleVerifier {
  /** Rejects with an AppError when the token is not valid for this deployment. */
  verify(idToken: string): Promise<GoogleIdentity>;
}
