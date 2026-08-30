import { parseInstant } from '@sher/shared-utils';
import { describe, expect, it } from 'vitest';

import {
  archiveCompatibility,
  archiveFileName,
  archivesToDelete,
  ARCHIVE_VERSION,
  AUTOMATIC_BACKUP_RETENTION,
} from '../src/backup/archive';

/**
 * The rules that decide whether a backup file may be written into a shop's
 * database (Phase 10, §5.25).
 *
 * These are small functions and they are the ones standing between a recovery
 * and a database written by software that did not understand the file. Every
 * case here is a way that could go wrong in a real shop.
 */

const migrations = [
  '0001_foundation.sql',
  '0002_auth_registration.sql',
  '0039_reconciliation.sql',
  '0040_backup_and_license.sql',
];

function mustParse(iso: string): Date {
  const parsed = parseInstant(iso);
  if (parsed === null) throw new Error(`${iso} is not an instant`);
  return parsed;
}

function manifest(schemaVersion: string, archiveVersion = ARCHIVE_VERSION) {
  return { archiveVersion, schemaVersion };
}

describe('archiveCompatibility', () => {
  it('restores as-is when the archive was written by this same schema', () => {
    expect(archiveCompatibility(manifest('0040_backup_and_license.sql'), migrations)).toEqual({
      kind: 'SAME',
    });
  });

  it('names the steps that must run when the archive is older', () => {
    const result = archiveCompatibility(manifest('0002_auth_registration.sql'), migrations);

    expect(result).toEqual({
      kind: 'FORWARD_MIGRATE',
      steps: ['0039_reconciliation.sql', '0040_backup_and_license.sql'],
    });
  });

  /**
   * The one that protects a shop from itself: a backup taken after an upgrade,
   * carried to a computer that was never upgraded. Restoring it would write
   * rows this build cannot read back.
   */
  it('refuses an archive from a newer build, naming both versions', () => {
    const result = archiveCompatibility(manifest('0099_from_the_future.sql'), migrations);

    expect(result).toEqual({
      kind: 'TOO_NEW',
      archiveSchema: '0099_from_the_future.sql',
      buildSchema: '0040_backup_and_license.sql',
    });
  });

  it('refuses a file whose archive format this build does not know', () => {
    const result = archiveCompatibility(manifest('0040_backup_and_license.sql', 99), migrations);

    expect(result).toEqual({ kind: 'UNSUPPORTED_FORMAT', archiveVersion: 99 });
  });
});

describe('archivesToDelete', () => {
  const archives = Array.from({ length: 20 }, (_, index) => ({
    fileName: `shop-2026-08-${String(index + 1).padStart(2, '0')}.sherdb`,
    takenAt: `2026-08-${String(index + 1).padStart(2, '0')}T02:00:00.000Z`,
  }));

  it('keeps the newest fourteen and deletes the rest', () => {
    const deleted = archivesToDelete(archives);

    expect(deleted).toHaveLength(20 - AUTOMATIC_BACKUP_RETENTION);
    expect(deleted.map((entry) => entry.fileName)).toEqual([
      'shop-2026-08-06.sherdb',
      'shop-2026-08-05.sherdb',
      'shop-2026-08-04.sherdb',
      'shop-2026-08-03.sherdb',
      'shop-2026-08-02.sherdb',
      'shop-2026-08-01.sherdb',
    ]);
  });

  /** A directory listing has no inherent order, so the sort has to do the work. */
  it('does not depend on the order it is given', () => {
    const shuffled = [...archives].reverse();

    expect(archivesToDelete(shuffled).map((entry) => entry.fileName)).toEqual(
      archivesToDelete(archives).map((entry) => entry.fileName),
    );
  });

  it('deletes nothing while fewer than fourteen exist', () => {
    expect(archivesToDelete(archives.slice(0, 14))).toEqual([]);
  });
});

describe('archiveFileName', () => {
  // Parsed through the shared helper rather than `new Date(...)`: the boundary
  // checker bans an ambient clock read anywhere outside `shared-utils/clock.ts`,
  // and a test is not an exception to a rule about where time comes from.
  const takenAt = mustParse('2026-08-31T02:00:00.000Z');

  it('carries the shop name a person will read off a pen drive months later', () => {
    expect(archiveFileName('Rahim Store', takenAt)).toBe('rahim-store-2026-08-31-0200.sherdb');
  });

  /** The name reaches a Content-Disposition header and a FAT32 pen drive. */
  it('strips anything that is not a letter or a digit', () => {
    expect(archiveFileName('Rahim & Sons / Dhaka', takenAt)).toBe(
      'rahim-sons-dhaka-2026-08-31-0200.sherdb',
    );
  });

  it('still produces a usable name for a business written in Bangla', () => {
    expect(archiveFileName('রহিম স্টোর', takenAt)).toMatch(/-2026-08-31-0200\.sherdb$/);
  });

  it('falls back rather than producing a file called .sherdb', () => {
    expect(archiveFileName('!!!', takenAt)).toBe('sher-2026-08-31-0200.sherdb');
  });
});
