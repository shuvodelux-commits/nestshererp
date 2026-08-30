import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { BackupFileStore, StoredArchive } from '@sher/core-application';

/**
 * Where the nightly archives live (Phase 10, owner decision 2026-08-30).
 *
 * A plain directory on the machine, fourteen files deep. Deliberately not a
 * database table: an archive whose only copy is inside the database it exists
 * to recover is not a backup, and a shop pulling a disk out of a dead computer
 * needs to find files, not rows.
 *
 * **A write lands under a temporary name and is renamed only once complete.**
 * A disk that fills halfway through leaves `.part` behind rather than a
 * truncated `.sherdb` that a later restore could pick up believing it whole,
 * and the listing never shows a file that is still being written.
 */
export class DirectoryBackupFileStore implements BackupFileStore {
  constructor(private readonly directory: string) {}

  async write(fileName: string, bytes: Uint8Array): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const finalPath = this.pathOf(fileName);
    const partialPath = `${finalPath}.part`;

    try {
      await writeFile(partialPath, bytes, { mode: 0o600 });
      const { rename } = await import('node:fs/promises');
      await rename(partialPath, finalPath);
    } catch (error) {
      await rm(partialPath, { force: true });
      throw error;
    }
  }

  async read(fileName: string): Promise<Uint8Array> {
    return readFile(this.pathOf(fileName));
  }

  async list(): Promise<readonly StoredArchive[]> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch {
      // No directory yet means no backups yet, which is a fact rather than a
      // failure — a fresh installation reaches this on its first status read.
      return [];
    }

    const archives: StoredArchive[] = [];
    for (const name of names) {
      if (!name.endsWith('.sherdb')) continue;
      const info = await stat(join(this.directory, name));
      archives.push({
        fileName: name,
        takenAt: info.mtime.toISOString(),
        byteSize: info.size,
      });
    }
    return archives;
  }

  async delete(fileName: string): Promise<void> {
    await rm(this.pathOf(fileName), { force: true });
  }

  /**
   * A file name never leaves this directory.
   *
   * Every caller today passes a name this module generated, but the one that
   * does not — a future restore-from-folder, a support script — must not be
   * able to reach `../../etc` through a value that looks like a file name.
   */
  private pathOf(fileName: string): string {
    if (fileName.includes('/') || fileName.includes('\\') || fileName.includes('..')) {
      throw new Error(`refusing to use ${fileName} as a backup file name`);
    }
    return join(this.directory, fileName);
  }
}
