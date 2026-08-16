import { createPublicKey, verify as verifySignature } from 'node:crypto';

import type { GoogleIdentity, GoogleVerifier } from '@sher/core-application';
import { AppError, ErrorCode } from '@sher/core-contracts';
import type { Clock } from '@sher/shared-utils';

/**
 * Verifies a Google ID token (D-07).
 *
 * No new dependency: Node can build a public key straight from a JWK
 * (`createPublicKey({ format: 'jwk' })`) and check an RS256 signature, so the
 * cryptography is the platform's, not hand-rolled. What this file adds is the
 * fetching, caching and claim checking around it.
 *
 * Every check below matters:
 *   - signature, against Google's currently published keys
 *   - `iss`, so a token from another issuer cannot pass
 *   - `aud`, so a token minted for a *different* application cannot be replayed
 *     into ours — this is the check whose absence is the classic Google-login
 *     vulnerability
 *   - `exp`, so an old token cannot be reused
 *   - `email_verified`, because an unverified address is a claim, not a fact
 */
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
/** Google rotates keys slowly; a short cache keeps a login from being a round trip. */
const JWKS_CACHE_SECONDS = 3600;

interface JsonWebKey {
  readonly kid?: string;
  readonly kty?: string;
  readonly alg?: string;
  readonly n?: string;
  readonly e?: string;
}

interface GoogleClaims {
  readonly iss?: unknown;
  readonly aud?: unknown;
  readonly exp?: unknown;
  readonly email?: unknown;
  readonly email_verified?: unknown;
}

function rejected(reason: string): AppError {
  // The caller learns only that the sign-in failed; the reason is for our logs.
  return new AppError(ErrorCode.UNAUTHENTICATED, `Google sign-in failed: ${reason}`);
}

export class GoogleIdTokenVerifier implements GoogleVerifier {
  private cachedKeys: JsonWebKey[] = [];
  private cacheExpiresAtMs = 0;

  constructor(
    private readonly clientId: string,
    private readonly clock: Clock,
  ) {}

  async verify(idToken: string): Promise<GoogleIdentity> {
    const parts = idToken.split('.');
    if (parts.length !== 3) throw rejected('malformed token');
    const [header, payload, signature] = parts as [string, string, string];

    const kid = this.headerKid(header);
    const key = await this.keyFor(kid);

    const ok = verifySignature(
      'RSA-SHA256',
      Buffer.from(`${header}.${payload}`),
      createPublicKey({ key: key as Record<string, unknown>, format: 'jwk' }),
      Buffer.from(signature, 'base64url'),
    );
    if (!ok) throw rejected('bad signature');

    return this.identityFrom(payload);
  }

  private headerKid(header: string): string {
    let parsed: { kid?: unknown; alg?: unknown };
    try {
      parsed = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as typeof parsed;
    } catch {
      throw rejected('malformed header');
    }
    // Pinning the algorithm stops the "alg: none" and HS256-confusion attacks.
    if (parsed.alg !== 'RS256') throw rejected('unexpected algorithm');
    if (typeof parsed.kid !== 'string') throw rejected('no key id');
    return parsed.kid;
  }

  private identityFrom(payload: string): GoogleIdentity {
    let claims: GoogleClaims;
    try {
      claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as GoogleClaims;
    } catch {
      throw rejected('malformed payload');
    }

    if (typeof claims.iss !== 'string' || !GOOGLE_ISSUERS.includes(claims.iss)) {
      throw rejected('wrong issuer');
    }
    if (claims.aud !== this.clientId) throw rejected('token was issued for another application');
    if (typeof claims.exp !== 'number' || claims.exp * 1000 <= this.clock.now().getTime()) {
      throw rejected('token expired');
    }
    if (claims.email_verified !== true) throw rejected('email is not verified');
    if (typeof claims.email !== 'string' || claims.email === '') throw rejected('no email');

    return { email: claims.email };
  }

  private async keyFor(kid: string): Promise<JsonWebKey> {
    const found = this.cachedKeys.find((key) => key.kid === kid);
    if (found !== undefined && this.clock.now().getTime() < this.cacheExpiresAtMs) return found;

    await this.refreshKeys();

    const key = this.cachedKeys.find((candidate) => candidate.kid === kid);
    if (key === undefined) throw rejected('unknown signing key');
    return key;
  }

  private async refreshKeys(): Promise<void> {
    let response: Response;
    try {
      response = await fetch(GOOGLE_JWKS_URL);
    } catch {
      throw rejected('cannot reach Google');
    }
    if (!response.ok) throw rejected('cannot read Google signing keys');

    const body = (await response.json()) as { keys?: JsonWebKey[] };
    this.cachedKeys = body.keys ?? [];
    this.cacheExpiresAtMs = this.clock.now().getTime() + JWKS_CACHE_SECONDS * 1000;
  }
}

/**
 * Used when no `GOOGLE_CLIENT_ID` is configured. It refuses every token rather
 * than pretending Google sign-in works — a deployment that has not set the
 * client id has no way to check the `aud` claim, and skipping that check is
 * exactly the vulnerability described above.
 */
export class UnconfiguredGoogleVerifier implements GoogleVerifier {
  verify(): Promise<GoogleIdentity> {
    return Promise.reject(
      new AppError(ErrorCode.UNAUTHENTICATED, 'Google sign-in is not configured on this server'),
    );
  }
}
