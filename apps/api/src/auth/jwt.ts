import { createHmac, timingSafeEqual } from 'node:crypto';

import type { TenantContext } from '@sher/core-application';
import { AppError, ErrorCode } from '@sher/core-contracts';
import type { Clock } from '@sher/shared-utils';

/**
 * Minimal HS256 verification. Token issuance is Phase 1 (M02 / D-07); this
 * verifies what that phase will issue, so the tenant context has exactly one
 * source: the signed token. `tenant_id` is NEVER read from a body or URL (R-C4).
 *
 * Claims: sub = user id, tid = tenant id, tz = tenant timezone, exp = seconds.
 */
interface JwtClaims {
  sub?: unknown;
  tid?: unknown;
  tz?: unknown;
  exp?: unknown;
}

function base64UrlDecode(segment: string): string {
  return Buffer.from(segment, 'base64url').toString('utf8');
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

/** Access tokens live 15 minutes (§5.3). Refresh tokens arrive with login, slice 1.2. */
const ACCESS_TOKEN_SECONDS = 15 * 60;

/**
 * Issues what `verifyToken` below expects — the two halves are kept in one file
 * so a claim can never be added to one and forgotten in the other.
 *
 * Permissions are deliberately absent from the token: they are resolved
 * server-side per request so a role change takes effect immediately (§5.3).
 */
export function signToken(ctx: TenantContext, secret: string, clock: Clock): string {
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64UrlEncode(
    JSON.stringify({
      sub: ctx.userId,
      tid: ctx.tenantId,
      tz: ctx.timezone,
      exp: Math.floor(clock.now().getTime() / 1000) + ACCESS_TOKEN_SECONDS,
    }),
  );

  return `${header}.${payload}.${sign(secret, `${header}.${payload}`).toString('base64url')}`;
}

function sign(secret: string, signingInput: string): Buffer {
  return createHmac('sha256', secret).update(signingInput).digest();
}

export function verifyToken(token: string, secret: string, clock: Clock): TenantContext {
  const parts = token.split('.');
  if (parts.length !== 3) throw new AppError(ErrorCode.UNAUTHENTICATED, 'Malformed token');

  const [header, payload, signature] = parts as [string, string, string];
  const expected = sign(secret, `${header}.${payload}`);
  const provided = Buffer.from(signature, 'base64url');

  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    throw new AppError(ErrorCode.UNAUTHENTICATED, 'Invalid token signature');
  }

  let claims: JwtClaims;
  try {
    claims = JSON.parse(base64UrlDecode(payload)) as JwtClaims;
  } catch {
    throw new AppError(ErrorCode.UNAUTHENTICATED, 'Malformed token payload');
  }

  const { sub, tid, tz, exp } = claims;
  if (typeof sub !== 'string' || typeof tid !== 'string' || typeof tz !== 'string') {
    throw new AppError(ErrorCode.UNAUTHENTICATED, 'Token is missing required claims');
  }
  if (typeof exp !== 'number' || exp * 1000 <= clock.now().getTime()) {
    throw new AppError(ErrorCode.UNAUTHENTICATED, 'Token expired');
  }

  return { tenantId: tid, userId: sub, timezone: tz };
}
