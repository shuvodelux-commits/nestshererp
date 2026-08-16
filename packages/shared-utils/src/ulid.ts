/**
 * ULID: 48-bit timestamp + 80 bits of randomness, Crockford base32, 26 chars.
 *
 * Every primary key in SherERP is a ULID generated in application code (R-C1).
 * The timestamp prefix is what makes them sort by creation order, which keeps
 * index locality sane and keyset pagination meaningful.
 *
 * Time comes from the injected Clock, never from an ambient `Date.now()`:
 * callers write `Ulid.generate(clock)`.
 */
import type { Clock } from './clock';

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ENCODING_LEN = 32;
const TIME_LEN = 10;
const RANDOM_LEN = 16;
const MAX_TIME = 281474976710655; // 2^48 - 1
const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/**
 * Monotonic state, the one piece of mutable state in shared-utils. Two ULIDs
 * generated in the same millisecond must still sort in creation order, so the
 * random part is incremented instead of redrawn.
 */
let lastTime = -1;
let lastRandom: number[] = [];

function encodeTime(time: number): string {
  let remaining = time;
  let encoded = '';
  for (let index = 0; index < TIME_LEN; index += 1) {
    encoded = ENCODING.charAt(remaining % ENCODING_LEN) + encoded;
    remaining = Math.floor(remaining / ENCODING_LEN);
  }
  return encoded;
}

function drawRandom(): number[] {
  // 256 is an exact multiple of 32, so a byte maps to a symbol without bias.
  const bytes = new Uint8Array(RANDOM_LEN);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte % ENCODING_LEN);
}

function incrementRandom(symbols: readonly number[]): number[] {
  const next = [...symbols];
  for (let index = next.length - 1; index >= 0; index -= 1) {
    const value = next[index] ?? 0;
    if (value < ENCODING_LEN - 1) {
      next[index] = value + 1;
      return next;
    }
    next[index] = 0;
  }
  throw new RangeError('ULID random component overflowed within a single millisecond');
}

function generate(clock: Clock): string {
  const time = clock.now().getTime();
  if (time < 0 || time > MAX_TIME) throw new RangeError(`ULID timestamp out of range: ${String(time)}`);

  if (time > lastTime) {
    lastTime = time;
    lastRandom = drawRandom();
  } else {
    // Same millisecond, or a clock that moved backwards: keep the previous
    // timestamp so the sequence never goes backwards.
    lastRandom = incrementRandom(lastRandom);
  }

  const random = lastRandom.map((symbol) => ENCODING.charAt(symbol)).join('');
  return encodeTime(lastTime) + random;
}

function isValid(value: string): boolean {
  return ULID_PATTERN.test(value);
}

export const Ulid = { generate, isValid } as const;
