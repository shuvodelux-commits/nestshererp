import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * HS256 for operator sessions — the same hand-rolled shape as the ERP's
 * `apps/api/src/auth/jwt.ts`, and the same reason (A3: no dependency in the
 * authentication path).
 *
 * **The token is not the session.** It carries a session id, and every request
 * looks that id up in `operator_sessions` to find out whether it has been
 * revoked and when it last re-authenticated. A JWT alone cannot be withdrawn
 * before it expires, and a console that can enter any customer's ERP needs
 * "sign that operator out now" to mean now.
 *
 * Permissions are deliberately absent from the claims: they are resolved from
 * the operator's current role on each request, so a role change or a
 * disablement takes effect immediately rather than at the next login.
 */
export interface OperatorClaims {
  /** Operator id. */
  readonly sub: string;
  /** Session id — the row that can be revoked. */
  readonly sid: string;
  /** Seconds since epoch. */
  readonly exp: number;
}

/**
 * Twelve hours.
 *
 * Long enough for a working day of support without re-typing a password;
 * short enough that a token lifted from a laptop is worthless tomorrow. The
 * genuinely dangerous actions do not rely on this at all — they demand a fresh
 * TOTP code regardless of session age (§24).
 */
export const OPERATOR_SESSION_SECONDS = 12 * 60 * 60;

export function signOperatorToken(claims: OperatorClaims, secret: string): string {
  const header = encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = encode(JSON.stringify(claims));
  return `${header}.${payload}.${mac(secret, `${header}.${payload}`).toString('base64url')}`;
}

export function verifyOperatorToken(token: string, secret: string, now: Date): OperatorClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts as [string, string, string];

  const expected = mac(secret, `${header}.${payload}`);
  const given = Buffer.from(signature, 'base64url');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;

  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<OperatorClaims>;
    if (typeof claims.sub !== 'string' || typeof claims.sid !== 'string' || typeof claims.exp !== 'number') {
      return null;
    }
    if (claims.exp * 1000 <= now.getTime()) return null;
    return { sub: claims.sub, sid: claims.sid, exp: claims.exp };
  } catch {
    return null;
  }
}

function mac(secret: string, data: string): Buffer {
  return createHmac('sha256', secret).update(data).digest();
}

function encode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}
