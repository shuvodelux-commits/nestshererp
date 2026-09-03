import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * RFC 6238 TOTP, hand-written for the same reason `apps/api/src/auth/jwt.ts`
 * is: one small, auditable file beats a dependency in the path to every
 * customer's books.
 *
 * **Mandatory, not optional** (§23). This console can revoke a licence, deploy
 * a build to every shop in the fleet and open any customer's ERP; a password
 * alone protecting that is not a considered risk, it is an oversight. An
 * operator row exists in a state where it has a password but no enrolled TOTP,
 * and in that state it can do nothing but finish enrolling.
 */
const PERIOD_SECONDS = 30;
const DIGITS = 6;

/**
 * How many windows either side of now are accepted.
 *
 * One. That is 90 seconds of tolerance in total, which covers a phone whose
 * clock has drifted and a person typing slowly, and nothing else. Widening it
 * widens the window in which a shoulder-surfed code still works.
 */
const DRIFT_WINDOWS = 1;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** A fresh secret, in the base32 an authenticator app expects. */
export function generateTotpSecret(): string {
  const bytes = randomBytes(20);
  let bits = '';
  for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');
  let out = '';
  for (let index = 0; index + 5 <= bits.length; index += 5) {
    out += BASE32[Number.parseInt(bits.slice(index, index + 5), 2)];
  }
  return out;
}

/** The `otpauth://` URI an authenticator app scans. */
export function totpUri(secret: string, email: string, issuer = 'SherERP Control'): string {
  const label = encodeURIComponent(`${issuer}:${email}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&digits=${String(DIGITS)}&period=${String(PERIOD_SECONDS)}`;
}

function base32Decode(secret: string): Buffer {
  let bits = '';
  for (const char of secret.toUpperCase().replace(/=+$/u, '')) {
    const index = BASE32.indexOf(char);
    if (index === -1) continue;
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  }
  return Buffer.from(bytes);
}

function codeAt(secret: string, counter: number): string {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', base32Decode(secret)).update(buffer).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    (((digest[offset + 1] ?? 0) & 0xff) << 16) |
    (((digest[offset + 2] ?? 0) & 0xff) << 8) |
    ((digest[offset + 3] ?? 0) & 0xff);
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

/**
 * Constant-time comparison across the accepted windows.
 *
 * The loop does not break on a match: returning early would leak, through
 * timing, *which* window matched, and the drift window is small enough that
 * checking all three costs nothing.
 */
export function verifyTotp(secret: string, code: string, now: Date): boolean {
  const trimmed = code.trim();
  if (!/^[0-9]{6}$/u.test(trimmed)) return false;
  const counter = Math.floor(now.getTime() / 1000 / PERIOD_SECONDS);
  let matched = false;
  for (let drift = -DRIFT_WINDOWS; drift <= DRIFT_WINDOWS; drift += 1) {
    const expected = Buffer.from(codeAt(secret, counter + drift), 'utf8');
    const given = Buffer.from(trimmed, 'utf8');
    if (expected.length === given.length && timingSafeEqual(expected, given)) matched = true;
  }
  return matched;
}
