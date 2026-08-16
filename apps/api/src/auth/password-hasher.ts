import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

import type { PasswordHasher } from '@sher/core-application';

/**
 * scrypt via Node's built-in crypto — no bcrypt/argon2 dependency (A3), the same
 * reasoning that made `jwt.ts` hand-rolled.
 *
 * Parameters are the Node defaults with an explicit cost: N=2^15 is the current
 * commonly cited interactive-login setting and takes ~100ms on the hardware
 * §6.5 specifies. They are stored **in the hash string**, so raising the cost
 * later does not invalidate existing passwords — an old hash still verifies with
 * the parameters it was written with.
 */
const N = 32768;
const BLOCK_SIZE = 8;
const PARALLELIZATION = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

// scrypt needs memory proportional to 128 * N * r; Node's default cap is lower.
const MAX_MEMORY = 128 * N * BLOCK_SIZE * 2;

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

export class ScryptPasswordHasher implements PasswordHasher {
  async hash(plain: string): Promise<string> {
    const salt = randomBytes(SALT_LENGTH);
    const derived = await derive(plain, salt, N, BLOCK_SIZE, PARALLELIZATION);
    return [
      'scrypt',
      String(N),
      String(BLOCK_SIZE),
      String(PARALLELIZATION),
      salt.toString('base64'),
      derived.toString('base64'),
    ].join('$');
  }

  async verify(plain: string, hash: string): Promise<boolean> {
    const parsed = parse(hash);
    if (parsed === null) return false;

    const derived = await derive(plain, parsed.salt, parsed.n, parsed.r, parsed.p);
    // Constant time: a length check first, because timingSafeEqual throws on a
    // mismatch and the throw itself would be a timing signal.
    if (derived.length !== parsed.key.length) return false;
    return timingSafeEqual(derived, parsed.key);
  }
}

function derive(plain: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return scryptAsync(plain, salt, KEY_LENGTH, { N: n, r, p, maxmem: MAX_MEMORY });
}

interface ParsedHash {
  readonly n: number;
  readonly r: number;
  readonly p: number;
  readonly salt: Buffer;
  readonly key: Buffer;
}

/** Returns null for anything that is not a hash this class wrote. */
function parse(hash: string): ParsedHash | null {
  const parts = hash.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;

  const [, rawN, rawR, rawP, rawSalt, rawKey] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const n = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return null;

  return {
    n,
    r,
    p,
    salt: Buffer.from(rawSalt, 'base64'),
    key: Buffer.from(rawKey, 'base64'),
  };
}
