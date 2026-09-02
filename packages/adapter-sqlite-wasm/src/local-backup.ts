import { LIVE_FILE, sahPool } from './local-database';

/**
 * The machine's own database, taken off the machine (§5.23, §20, Phase 12.4).
 *
 * OPFS can be evicted by the browser without asking anybody, and a counter PC
 * can die. Either takes a day's unsynced takings with it, so a shop must be
 * able to put that day in a file it keeps — and put it back.
 *
 * **`.sherbak` is encrypted, and deliberately not a raw SQLite file.** The
 * database holds every customer, every price and every sale the machine has
 * made; a copy of it on a USB stick in a drawer is a copy of the shop. AES-256-
 * GCM with a key derived from a passphrase the owner chooses, and the manifest
 * is authenticated along with the body, so a tampered file fails to open rather
 * than opening wrong.
 *
 * The whole file is one archive: the live database — which is the outbox, the
 * operation ids, the document ids, the device sequence, the cash-day state, the
 * offline master data and the origin trail together, because they all live in
 * the same database — plus a manifest naming the shop, the machine and the
 * cursor to resume from.
 */

/** Bumped when the archive's own shape changes, never for a schema change. */
const BACKUP_FORMAT = 1;
const MAGIC = 'SHERBAK1';
/**
 * PBKDF2 rounds. High enough to make a stolen file expensive to attack, low
 * enough that a shopkeeper on a slow counter PC does not think the app hung.
 */
const KDF_ITERATIONS = 310_000;

export interface BackupManifest {
  readonly format: number;
  readonly tenantId: string;
  readonly deviceId: string | null;
  readonly deviceCode: string | null;
  readonly takenAt: string;
  readonly schemaVersion: number;
  /** What was still waiting to be sent when the file was made. */
  readonly pendingOperations: number;
  readonly syncCursor: string | null;
}

export interface LocalBackup {
  readonly manifest: BackupManifest;
  readonly bytes: Uint8Array;
}

/**
 * Exports the live database into an encrypted archive.
 *
 * Reads the file whole through the pool rather than re-running the schema: what
 * has to survive is everything, including rows this build does not know about,
 * and a hand-written export would quietly drop the first table somebody adds.
 */
export async function exportBackup(options: {
  readonly passphrase: string;
  readonly tenantId: string;
  readonly deviceId: string | null;
  readonly deviceCode: string | null;
  readonly schemaVersion: number;
  readonly pendingOperations: number;
  readonly syncCursor: string | null;
  readonly takenAt: string;
}): Promise<LocalBackup> {
  const pool = await sahPool();
  const database = await pool.exportFile(LIVE_FILE);

  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    tenantId: options.tenantId,
    deviceId: options.deviceId,
    deviceCode: options.deviceCode,
    takenAt: options.takenAt,
    schemaVersion: options.schemaVersion,
    pendingOperations: options.pendingOperations,
    syncCursor: options.syncCursor,
  };

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(options.passphrase, salt);
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));

  /*
   * The manifest is additional authenticated data, not a plaintext header
   * beside the ciphertext. Changing a single byte of it — swapping in another
   * shop's tenant id, moving the cursor forward — makes the whole file fail to
   * decrypt, which is what "tamper-detectable" has to mean if it is to mean
   * anything.
   */
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: manifestBytes },
    key,
    database,
  );

  const header = new TextEncoder().encode(MAGIC);
  const bytes = new Uint8Array(
    header.length + 4 + manifestBytes.length + salt.length + iv.length + cipher.byteLength,
  );
  let at = 0;
  bytes.set(header, at);
  at += header.length;
  new DataView(bytes.buffer).setUint32(at, manifestBytes.length, false);
  at += 4;
  bytes.set(manifestBytes, at);
  at += manifestBytes.length;
  bytes.set(salt, at);
  at += salt.length;
  bytes.set(iv, at);
  at += iv.length;
  bytes.set(new Uint8Array(cipher), at);

  return { manifest, bytes };
}

/** Reads the manifest without the passphrase, so a screen can show what a file is. */
export function readManifest(bytes: Uint8Array): BackupManifest | null {
  try {
    const magic = new TextDecoder().decode(bytes.subarray(0, MAGIC.length));
    if (magic !== MAGIC) return null;
    const length = new DataView(bytes.buffer, bytes.byteOffset).getUint32(MAGIC.length, false);
    const json = new TextDecoder().decode(
      bytes.subarray(MAGIC.length + 4, MAGIC.length + 4 + length),
    );
    return JSON.parse(json) as BackupManifest;
  } catch {
    return null;
  }
}

/**
 * Restores an archive over this profile's live database.
 *
 * **Restoring does not make this machine the offline writer again** (§21). The
 * queue, the operation ids, the document ids, the device sequence and the
 * printed numbers all come back exactly as they were — but authority to write
 * new work is granted by the shop through the ordinary drain-and-transfer flow,
 * never by opening a file. Counter A's documents restored onto Counter B are
 * still Counter A's documents; only work created after an authorised transfer
 * carries B's identity.
 */
export async function importBackup(
  bytes: Uint8Array,
  passphrase: string,
  expectedTenantId: string,
): Promise<BackupManifest> {
  const manifest = readManifest(bytes);
  if (manifest === null) throw new Error('This is not a SherERP backup file');
  if (manifest.format !== BACKUP_FORMAT) {
    throw new Error('This backup was made by a different version of the app');
  }
  if (manifest.tenantId !== expectedTenantId) {
    throw new Error('This backup belongs to a different business');
  }

  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  let at = MAGIC.length + 4 + manifestBytes.length;
  const salt = bytes.subarray(at, at + 16);
  at += 16;
  const iv = bytes.subarray(at, at + 12);
  at += 12;
  const cipher = bytes.subarray(at);

  const key = await deriveKey(passphrase, salt);
  let database: ArrayBuffer;
  try {
    database = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: manifestBytes },
      key,
      cipher,
    );
  } catch {
    // One message for a wrong passphrase and for a damaged file, because the
    // decryption cannot tell them apart and guessing would be a lie.
    throw new Error('That passphrase does not open this backup, or the file is damaged');
  }

  const pool = await sahPool();
  await pool.importDb(LIVE_FILE, new Uint8Array(database));
  return manifest;
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: KDF_ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}
