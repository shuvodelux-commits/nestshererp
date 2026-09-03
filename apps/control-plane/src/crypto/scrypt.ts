import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * Operator password hashing.
 *
 * The encoding is byte-for-byte the ERP's own — `scrypt$N$r$p$salt$key`, from
 * `apps/api/src/auth/password-hasher.ts` — even though the two never share a
 * database. Same reasoning, and one extra: when two hand-written
 * implementations of the same primitive exist in one repository, the only way
 * to keep them honest is to make a hash written by either verifiable by the
 * other. Different formats would hide a divergence until the day it mattered.
 *
 * The cost parameters live inside the hash string, so raising them later leaves
 * existing operator passwords verifiable with the parameters they were written
 * with.
 */
const N = 32768;
const BLOCK_SIZE = 8;
const PARALLELIZATION = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const MAX_MEMORY = 128 * N * BLOCK_SIZE * 2;

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await derive(plain, salt, N, BLOCK_SIZE, PARALLELIZATION);
  return ['scrypt', String(N), String(BLOCK_SIZE), String(PARALLELIZATION), salt.toString('base64'), derived.toString('base64')].join('$');
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  const parts = hash.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  const derived = await derive(plain, Buffer.from(parts[4] ?? '', 'base64'), n, r, p);
  const expected = Buffer.from(parts[5] ?? '', 'base64');
  // Length first: timingSafeEqual throws on a mismatch, and the throw would
  // itself be a timing signal.
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

function derive(plain: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return scryptAsync(plain, salt, KEY_LENGTH, { N: n, r, p, maxmem: MAX_MEMORY });
}
