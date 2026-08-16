import type { TenantContext } from './tenant-context';

/**
 * Issues the credentials a signup or login ends with (§5.3).
 *
 * A port because signing needs `node:crypto`. Permissions are deliberately not
 * a parameter: they are **not in the token** and are resolved server-side per
 * request, so a role change takes effect immediately (§5.3).
 */
export interface TokenIssuer {
  /** 15-minute access token. */
  issueAccessToken(ctx: TenantContext): string;
  /**
   * An opaque 30-day refresh token. Random, not a JWT: it is looked up in the
   * database on every use, so it carries no claims worth forging, and a stolen
   * one is revocable — which a self-describing token is not.
   */
  issueRefreshToken(): string;
  /** One-way hash of a refresh token; only the hash is ever stored. */
  hashRefreshToken(token: string): string;
}
