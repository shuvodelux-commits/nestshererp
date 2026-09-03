/**
 * Checking a PIN on a machine that cannot ask the server (§5.23, D-01, §9).
 *
 * The snapshot carries each permitted user's **PIN hash** — never their
 * password hash, which is the decision written down in `core-contracts/devices`
 * — so a counter opened cold during an outage can still tell the cashier from
 * anybody who found the computer. Checking that hash means running the server's
 * own key-derivation here, in the browser, and WebCrypto does not implement
 * scrypt: `crypto.subtle` offers PBKDF2, HKDF and nothing else that derives a
 * key from a password.
 *
 * So this is RFC 7914 scrypt, written out, matching `apps/api/auth/
 * password-hasher.ts` byte for byte at the parameters that file uses
 * (N=32768, r=8, p=1, 32-byte key). It is the same house rule the hand-rolled
 * `jwt.ts` follows — no bcrypt, no argon2, no dependency (A3) — and the same
 * rule keeps it honest: the parameters are read out of the stored hash, so a
 * server that raises N tomorrow is still verified correctly by a machine that
 * downloaded its snapshot today.
 *
 * **This never grants anything.** A PIN accepted here opens the local copy and
 * the outbox on this one machine. Every queued operation is replayed by the
 * server through the online service, under the server's own authority checks,
 * and a device whose authority was revoked is refused there whatever this said.
 *
 * The derivation costs roughly a second of main thread at the production
 * parameters — that cost *is* the protection, and it is paid once per sign-in.
 * Callers show a "Checking…" state and let a frame paint before calling in.
 */

/** Salsa20/8 core, unrolled — the inner loop of the whole derivation. */
function salsa20_8(block: Uint32Array): void {
  const j0 = block[0]!, j1 = block[1]!, j2 = block[2]!, j3 = block[3]!;
  const j4 = block[4]!, j5 = block[5]!, j6 = block[6]!, j7 = block[7]!;
  const j8 = block[8]!, j9 = block[9]!, j10 = block[10]!, j11 = block[11]!;
  const j12 = block[12]!, j13 = block[13]!, j14 = block[14]!, j15 = block[15]!;

  let x0 = j0, x1 = j1, x2 = j2, x3 = j3;
  let x4 = j4, x5 = j5, x6 = j6, x7 = j7;
  let x8 = j8, x9 = j9, x10 = j10, x11 = j11;
  let x12 = j12, x13 = j13, x14 = j14, x15 = j15;

  for (let round = 0; round < 8; round += 2) {
    let t: number;
    // Columns.
    t = x0 + x12; x4 ^= (t << 7) | (t >>> 25);
    t = x4 + x0; x8 ^= (t << 9) | (t >>> 23);
    t = x8 + x4; x12 ^= (t << 13) | (t >>> 19);
    t = x12 + x8; x0 ^= (t << 18) | (t >>> 14);

    t = x5 + x1; x9 ^= (t << 7) | (t >>> 25);
    t = x9 + x5; x13 ^= (t << 9) | (t >>> 23);
    t = x13 + x9; x1 ^= (t << 13) | (t >>> 19);
    t = x1 + x13; x5 ^= (t << 18) | (t >>> 14);

    t = x10 + x6; x14 ^= (t << 7) | (t >>> 25);
    t = x14 + x10; x2 ^= (t << 9) | (t >>> 23);
    t = x2 + x14; x6 ^= (t << 13) | (t >>> 19);
    t = x6 + x2; x10 ^= (t << 18) | (t >>> 14);

    t = x15 + x11; x3 ^= (t << 7) | (t >>> 25);
    t = x3 + x15; x7 ^= (t << 9) | (t >>> 23);
    t = x7 + x3; x11 ^= (t << 13) | (t >>> 19);
    t = x11 + x7; x15 ^= (t << 18) | (t >>> 14);

    // Rows.
    t = x0 + x3; x1 ^= (t << 7) | (t >>> 25);
    t = x1 + x0; x2 ^= (t << 9) | (t >>> 23);
    t = x2 + x1; x3 ^= (t << 13) | (t >>> 19);
    t = x3 + x2; x0 ^= (t << 18) | (t >>> 14);

    t = x5 + x4; x6 ^= (t << 7) | (t >>> 25);
    t = x6 + x5; x7 ^= (t << 9) | (t >>> 23);
    t = x7 + x6; x4 ^= (t << 13) | (t >>> 19);
    t = x4 + x7; x5 ^= (t << 18) | (t >>> 14);

    t = x10 + x9; x11 ^= (t << 7) | (t >>> 25);
    t = x11 + x10; x8 ^= (t << 9) | (t >>> 23);
    t = x8 + x11; x9 ^= (t << 13) | (t >>> 19);
    t = x9 + x8; x10 ^= (t << 18) | (t >>> 14);

    t = x15 + x14; x12 ^= (t << 7) | (t >>> 25);
    t = x12 + x15; x13 ^= (t << 9) | (t >>> 23);
    t = x13 + x12; x14 ^= (t << 13) | (t >>> 19);
    t = x14 + x13; x15 ^= (t << 18) | (t >>> 14);
  }

  block[0] = (j0 + x0) | 0;
  block[1] = (j1 + x1) | 0;
  block[2] = (j2 + x2) | 0;
  block[3] = (j3 + x3) | 0;
  block[4] = (j4 + x4) | 0;
  block[5] = (j5 + x5) | 0;
  block[6] = (j6 + x6) | 0;
  block[7] = (j7 + x7) | 0;
  block[8] = (j8 + x8) | 0;
  block[9] = (j9 + x9) | 0;
  block[10] = (j10 + x10) | 0;
  block[11] = (j11 + x11) | 0;
  block[12] = (j12 + x12) | 0;
  block[13] = (j13 + x13) | 0;
  block[14] = (j14 + x14) | 0;
  block[15] = (j15 + x15) | 0;
}

/** RFC 7914 §4: 2r 64-byte blocks in, the even ones then the odd ones out. */
function blockMix(b: Uint32Array, out: Uint32Array, r: number, x: Uint32Array): void {
  const last = (2 * r - 1) * 16;
  for (let i = 0; i < 16; i += 1) x[i] = b[last + i]!;

  for (let i = 0; i < 2 * r; i += 1) {
    const from = i * 16;
    for (let j = 0; j < 16; j += 1) x[j] = x[j]! ^ b[from + j]!;
    salsa20_8(x);
    const to = (i % 2 === 0 ? i / 2 : r + (i - 1) / 2) * 16;
    for (let j = 0; j < 16; j += 1) out[to + j] = x[j]!;
  }
}

/**
 * RFC 7914 §5: the memory-hard half.
 *
 * `v` is the whole cost — N blocks of 128r bytes, 128 MB at the production
 * parameters. That is the point of scrypt and the reason a stolen hash cannot
 * be brute-forced cheaply; it is also why this runs once, on a button press,
 * and never in a loop.
 */
function roMix(b: Uint32Array, r: number, n: number): void {
  const words = 32 * r;
  const v = new Uint32Array(words * n);
  const out = new Uint32Array(words);
  const x = new Uint32Array(16);

  for (let i = 0; i < n; i += 1) {
    v.set(b, i * words);
    blockMix(b, out, r, x);
    b.set(out);
  }
  for (let i = 0; i < n; i += 1) {
    // Integerify: the first word of the last 64-byte block, little-endian.
    const from = (b[words - 16]! >>> 0) % n * words;
    for (let k = 0; k < words; k += 1) b[k] = b[k]! ^ v[from + k]!;
    blockMix(b, out, r, x);
    b.set(out);
  }
}

/** PBKDF2-HMAC-SHA256 at one iteration, which is what scrypt asks of it. */
async function pbkdf2(password: Uint8Array, salt: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', password, 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 1 },
    key,
    bytes * 8,
  );
  return new Uint8Array(bits);
}

/** scrypt(P, S, N, r, p, dkLen), RFC 7914 §6. */
export async function scrypt(
  password: Uint8Array,
  salt: Uint8Array,
  n: number,
  r: number,
  p: number,
  keyLength: number,
): Promise<Uint8Array> {
  const blockBytes = 128 * r;
  const b = await pbkdf2(password, salt, p * blockBytes);
  for (let i = 0; i < p; i += 1) {
    const chunk = new Uint32Array(b.buffer.slice(i * blockBytes, (i + 1) * blockBytes));
    roMix(chunk, r, n);
    b.set(new Uint8Array(chunk.buffer), i * blockBytes);
  }
  return pbkdf2(password, b, keyLength);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Equal-length comparison that does not stop at the first difference.
 *
 * A timing side channel on an offline PIN check is a small risk — the attacker
 * is holding the computer — but the server's verifier is constant-time and this
 * is the same check, so it would be an odd place to become the weaker one.
 */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

const ENCODING = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([^$]+)\$([^$]+)$/;

/**
 * Whether this PIN produces the hash the snapshot brought down.
 *
 * A hash in any other shape is `false`, never a throw: an unreadable stored
 * hash means this user cannot sign in offline, which the screen says, and it
 * must not become an error that blocks the person standing next to them.
 */
export async function verifyPin(pin: string, encoded: string): Promise<boolean> {
  const parts = ENCODING.exec(encoded);
  if (parts === null) return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isSafeInteger(n) || n < 2 || (n & (n - 1)) !== 0) return false;
  if (!Number.isSafeInteger(r) || r < 1 || !Number.isSafeInteger(p) || p < 1) return false;

  try {
    const salt = fromBase64(parts[4]!);
    const expected = fromBase64(parts[5]!);
    const derived = await scrypt(new TextEncoder().encode(pin), salt, n, r, p, expected.length);
    return sameBytes(derived, expected);
  } catch {
    return false;
  }
}
