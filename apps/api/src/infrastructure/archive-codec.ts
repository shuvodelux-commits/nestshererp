import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';

import type { ArchiveBody, ArchiveCodec, EncodedArchive } from '@sher/core-application';
import { ArchiveOpenError } from '@sher/core-application';

/**
 * The `.sherdb` file itself (Phase 10, D-15, owner decision 2026-08-30).
 *
 * ```
 *   0..6    magic — 'SHERDB' and the format byte
 *   7..38   salt      (32 bytes, per file)
 *  39..50   nonce     (12 bytes, per file)
 *  51..66   auth tag  (16 bytes)
 *  67..98   plaintext SHA-256, authenticated but not encrypted
 *  99..     AES-256-GCM ciphertext of gzip(JSON body)
 * ```
 *
 * **AES-256-GCM**, so the file authenticates itself: a byte flipped anywhere in
 * a two-hundred-megabyte archive fails the tag rather than silently restoring a
 * changed figure. **scrypt** derives the key from the installation secret with a
 * per-file salt, so two archives never share a key and a secret shorter than it
 * should be still costs an attacker real time.
 *
 * **The three failures are kept apart on purpose.** A wrong secret fails the
 * GCM tag exactly as a damaged ciphertext does — cryptographically they are the
 * same event, and a cipher that could tell them apart would be an oracle. So
 * the magic prefix answers "is this even a SherERP backup", and the
 * authenticated checksum answers "did the bytes survive"; what is left is the
 * one sentence a shopkeeper can act on — this installation's password does not
 * open this file.
 */

const MAGIC = Buffer.from([0x53, 0x48, 0x45, 0x52, 0x44, 0x42, 0x01]);
const SALT_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const CHECKSUM_BYTES = 32;
const KEY_BYTES = 32;

/** scrypt cost: about 100 ms and 32 MB — an installation secret, opened once a night. */
const SCRYPT_COST = 32768;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_MEMORY = 64 * 1024 * 1024;

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export class AesArchiveCodec implements ArchiveCodec {
  async encode(body: ArchiveBody, secret: string): Promise<EncodedArchive> {
    const plain = Buffer.from(JSON.stringify(body), 'utf8');
    const checksum = createHash('sha256').update(plain).digest();
    const compressed = await gzipAsync(plain);

    const salt = randomBytes(SALT_BYTES);
    const nonce = randomBytes(NONCE_BYTES);
    const key = await deriveKey(secret, salt);

    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    // Authenticated, not encrypted: `decode` has to know what the plaintext
    // should hash to before it is in any position to trust the plaintext.
    cipher.setAAD(checksum);
    const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);

    return {
      bytes: Buffer.concat([MAGIC, salt, nonce, cipher.getAuthTag(), checksum, ciphertext]),
      checksum: checksum.toString('hex'),
    };
  }

  async decode(bytes: Uint8Array, secret: string): Promise<ArchiveBody & { checksum: string }> {
    const buffer = Buffer.from(bytes);
    const headerBytes = MAGIC.length + SALT_BYTES + NONCE_BYTES + TAG_BYTES + CHECKSUM_BYTES;
    if (buffer.length <= headerBytes || !buffer.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new ArchiveOpenError('NOT_AN_ARCHIVE');
    }

    let offset = MAGIC.length;
    const salt = buffer.subarray(offset, (offset += SALT_BYTES));
    const nonce = buffer.subarray(offset, (offset += NONCE_BYTES));
    const tag = buffer.subarray(offset, (offset += TAG_BYTES));
    const checksum = buffer.subarray(offset, (offset += CHECKSUM_BYTES));
    const ciphertext = buffer.subarray(offset);

    const key = await deriveKey(secret, salt);
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(checksum);
    decipher.setAuthTag(tag);

    let compressed: Buffer;
    try {
      compressed = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      throw new ArchiveOpenError('WRONG_SECRET');
    }

    let plain: Buffer;
    try {
      plain = Buffer.from(await gunzipAsync(compressed));
    } catch {
      throw new ArchiveOpenError('DAMAGED');
    }

    if (!createHash('sha256').update(plain).digest().equals(checksum)) {
      throw new ArchiveOpenError('DAMAGED');
    }

    let body: ArchiveBody;
    try {
      body = JSON.parse(plain.toString('utf8')) as ArchiveBody;
    } catch {
      throw new ArchiveOpenError('DAMAGED');
    }

    return { ...body, checksum: checksum.toString('hex') };
  }
}

async function deriveKey(secret: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      secret,
      salt,
      KEY_BYTES,
      { N: SCRYPT_COST, r: SCRYPT_BLOCK_SIZE, p: 1, maxmem: SCRYPT_MEMORY },
      (error, key) => {
        if (error) reject(error);
        else resolve(key);
      },
    );
  });
}
