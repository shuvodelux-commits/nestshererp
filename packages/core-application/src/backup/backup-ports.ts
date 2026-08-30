import type { ArchiveManifest } from '@sher/core-domain';

/**
 * Everything the backup module needs from outside the application layer
 * (Phase 10, §5.25, D-15).
 *
 * Four ports, because four genuinely different things are being talked to: a
 * cipher, a filesystem, a secret, and the `pg_dump` binary. Each of them is
 * Node-only or database-only and none may leak past this boundary — R-B3, and
 * the reason `core-application` still imports no `node:fs`.
 */

/** One table's rows, exactly as the database gave them. */
export interface ArchiveTable {
  readonly name: string;
  /** Column names, once, so the rows stay compact. */
  readonly columns: readonly string[];
  /** Values in column order. `null` is null; bytes arrive base64 with a marker. */
  readonly rows: readonly (readonly unknown[])[];
}

export interface ArchiveBody {
  readonly manifest: Omit<ArchiveManifest, 'checksum'>;
  readonly tables: readonly ArchiveTable[];
}

export interface EncodedArchive {
  readonly bytes: Uint8Array;
  readonly checksum: string;
}

/**
 * Why an archive could not be opened, distinguished on purpose.
 *
 * "Wrong password" and "damaged file" send a shopkeeper to two entirely
 * different places — one to try the other secret they wrote down, the other to
 * fetch a different copy — so the code that knows which it was must not flatten
 * them into "could not read the file" (owner decision 2026-08-30).
 */
export type ArchiveOpenFailure = 'WRONG_SECRET' | 'DAMAGED' | 'NOT_AN_ARCHIVE';

export class ArchiveOpenError extends Error {
  constructor(readonly failure: ArchiveOpenFailure) {
    super(failure);
    this.name = 'ArchiveOpenError';
  }
}

/**
 * Turning the business into an encrypted archive and back.
 *
 * AES-256-GCM with a per-file salt and IV, keyed from the installation secret.
 * `decode` throws `ArchiveOpenError` and never a raw crypto error — a stack
 * trace mentioning cipher internals is not an answer a shop can use.
 */
export interface ArchiveCodec {
  encode(body: ArchiveBody, secret: string): Promise<EncodedArchive>;
  decode(bytes: Uint8Array, secret: string): Promise<ArchiveBody & { checksum: string }>;
}

export interface StoredArchive {
  readonly fileName: string;
  readonly takenAt: string;
  readonly byteSize: number;
}

/** The directory the nightly archives live in. */
export interface BackupFileStore {
  write(fileName: string, bytes: Uint8Array): Promise<void>;
  read(fileName: string): Promise<Uint8Array>;
  list(): Promise<readonly StoredArchive[]>;
  delete(fileName: string): Promise<void>;
}

/**
 * The installation-level backup secret (owner decision 2026-08-30).
 *
 * Deliberately narrow: there is no `reveal` on this port and no endpoint that
 * could carry one. The UI never displays the secret; an Owner may replace it
 * under step-up, warned that existing archives stay under the old one.
 */
export interface BackupSecretStore {
  isConfigured(): Promise<boolean>;
  /** Throws when unconfigured — a caller must ask `isConfigured` first. */
  read(): Promise<string>;
  replace(secret: string): Promise<void>;
}

export interface DumpResult {
  readonly path: string;
  readonly byteSize: number;
}

/**
 * `pg_dump` and `pg_restore`, the operational recovery artifact (owner decision
 * 2026-08-30). Exact, same-version-only, never the owner's copy.
 *
 * `dump` returns only after the file has been **verified readable**; a dump
 * nobody could restore is not a safety net, and the reset that depends on one
 * must not proceed on the strength of a zero exit code alone.
 */
export interface DatabaseDumpTool {
  dumpAndVerify(label: string): Promise<DumpResult>;
}

/** What build this is, for the manifest and for the version gate. */
export interface BuildInfo {
  readonly appVersion: string;
  /** The last migration this build ships, e.g. `0040_backup_and_license.sql`. */
  readonly schemaVersion: string;
}
