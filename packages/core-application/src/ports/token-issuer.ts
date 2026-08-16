import type { TenantContext } from './tenant-context';

/**
 * Issues the 15-minute access token a signup or login ends with (§5.3).
 *
 * A port because signing needs `node:crypto`. Permissions are deliberately not
 * a parameter: they are **not in the token** and are resolved server-side per
 * request, so a role change takes effect immediately (§5.3).
 *
 * Refresh tokens — 30 days, rotating, revocable, server-stored — belong to the
 * login/logout slice (1.2), where session lifecycle is actually built.
 */
export interface TokenIssuer {
  issueAccessToken(ctx: TenantContext): string;
}
