import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM at rest, for the few columns that hold something worth stealing.
 *
 * Today that is exactly one thing: the TOTP shared secret. A database backup
 * that leaks should cost the vendor a password reset, not the second factor as
 * well — sealing the column is what keeps those two failures separate.
 *
 * GCM rather than CBC because the tag makes tampering detectable: a sealed
 * value that has been edited fails to open rather than opening to something
 * else. The nonce is random per seal and travels with the ciphertext, which is
 * safe here because the volume is tiny (one seal per operator enrolment) and
 * nowhere near GCM's birthday bound.
 */
const NONCE_BYTES = 12;

export function seal(plain: string, keyBase64: string): string {
  const key = Buffer.from(keyBase64, 'base64');
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [
    'v1',
    nonce.toString('base64url'),
    body.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
  ].join('.');
}

/** Returns null for anything this function did not write, or that was edited. */
export function open(sealed: string, keyBase64: string): string | null {
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  try {
    const key = Buffer.from(keyBase64, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1] ?? '', 'base64url'));
    decipher.setAuthTag(Buffer.from(parts[3] ?? '', 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(parts[2] ?? '', 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}
