import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { BackupSecretStore } from '@sher/core-application';

/**
 * The one customer-controlled secret every archive is encrypted with (Phase 10,
 * D-15, owner decision 2026-08-30).
 *
 * **Outside PostgreSQL, and that is the whole point.** It lives in a restricted
 * installation-level key file, never a database row — so a stolen database, or
 * a stolen `pg_dump` of one, does not carry the key that opens its own backups.
 * It is never written to a log, never returned by an endpoint, never placed in
 * an archive, and never shown on a screen.
 *
 * **There is no `reveal`, on this class or on any route.** An Owner may replace
 * the secret under step-up, warned that existing archives stay under the
 * previous one. No server-managed recovery exists in V1: a lost secret means
 * those files are unrecoverable, which is D-15's stated consequence and is said
 * plainly on the screen rather than discovered later.
 */
export class FileBackupSecretStore implements BackupSecretStore {
  constructor(private readonly keyPath: string) {}

  async isConfigured(): Promise<boolean> {
    if (this.keyPath === '') return false;
    try {
      return (await readFile(this.keyPath, 'utf8')).trim().length > 0;
    } catch {
      return false;
    }
  }

  async read(): Promise<string> {
    if (this.keyPath === '') {
      throw new Error('BACKUP_KEY_PATH is not configured');
    }
    const secret = (await readFile(this.keyPath, 'utf8')).trim();
    if (secret === '') throw new Error(`the backup key file at ${this.keyPath} is empty`);
    return secret;
  }

  async replace(secret: string): Promise<void> {
    if (this.keyPath === '') {
      throw new Error('BACKUP_KEY_PATH is not configured');
    }
    await mkdir(dirname(this.keyPath), { recursive: true });
    // 0600 before anything is written, not after: a secret that spent a
    // millisecond world-readable has been world-readable.
    await writeFile(this.keyPath, `${secret}\n`, { mode: 0o600, flag: 'w' });
    await chmod(this.keyPath, 0o600);
  }
}
