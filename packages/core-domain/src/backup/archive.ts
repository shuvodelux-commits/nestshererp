/**
 * What a `.sherdb` archive claims about itself, and what may be done with it
 * (Phase 10, §5.25, owner decisions 2026-08-30).
 *
 * Pure rules only. Reading a file, decrypting it and writing rows all belong to
 * the adapter; deciding whether a given file may be restored onto this build
 * belongs here, because it is the rule that stops a shop overwriting good books
 * with a file the software does not understand.
 */

/**
 * The archive layout version. Bumped only when the *shape* of the archive
 * changes — a new table is not a shape change, because the reader discovers
 * tables from the manifest rather than from a list compiled into the build.
 */
export const ARCHIVE_VERSION = 1;

export interface ArchiveManifest {
  readonly archiveVersion: number;
  /** The last migration applied when the archive was written, e.g. `0040_backup_and_license.sql`. */
  readonly schemaVersion: string;
  readonly appVersion: string;
  readonly tenantId: string;
  readonly businessName: string;
  /** ISO instant. */
  readonly takenAt: string;
  /** Table name → rows written. The reader trusts this for nothing; it compares. */
  readonly rowCounts: Readonly<Record<string, number>>;
  /** Bytes of statement evidence carried inside the archive. */
  readonly evidenceBytes: number;
  /** SHA-256 over the archive body, hex. */
  readonly checksum: string;
}

export type ArchiveCompatibility =
  /** Written by this same schema version — restore as-is. */
  | { readonly kind: 'SAME' }
  /** Older, and every step between is known — restore, then migrate forward. */
  | { readonly kind: 'FORWARD_MIGRATE'; readonly steps: readonly string[] }
  /** Newer than this build. Refused: a build cannot invent a shape it postdates. */
  | { readonly kind: 'TOO_NEW'; readonly archiveSchema: string; readonly buildSchema: string }
  /** The archive layout itself is from another era of the format. */
  | { readonly kind: 'UNSUPPORTED_FORMAT'; readonly archiveVersion: number };

/**
 * Whether this build may restore this archive, and what it must do afterwards.
 *
 * `appliedMigrations` is the ordered list this build ships — the same filenames
 * `schema_migrations` records. An archive is older when its schema version
 * appears in that list before the end; the steps that follow it are what must
 * run after the rows land. An archive naming a version this build has never
 * heard of is either from the future or from a fork, and both are refused with
 * the two versions named rather than with "incompatible".
 */
export function archiveCompatibility(
  manifest: Pick<ArchiveManifest, 'archiveVersion' | 'schemaVersion'>,
  appliedMigrations: readonly string[],
): ArchiveCompatibility {
  if (manifest.archiveVersion !== ARCHIVE_VERSION) {
    return { kind: 'UNSUPPORTED_FORMAT', archiveVersion: manifest.archiveVersion };
  }

  const buildSchema = appliedMigrations.at(-1) ?? '';
  const index = appliedMigrations.indexOf(manifest.schemaVersion);
  if (index === -1) {
    return { kind: 'TOO_NEW', archiveSchema: manifest.schemaVersion, buildSchema };
  }

  const steps = appliedMigrations.slice(index + 1);
  return steps.length === 0 ? { kind: 'SAME' } : { kind: 'FORWARD_MIGRATE', steps };
}

/**
 * How many automatic archives are kept (owner decision 2026-08-30).
 *
 * Successful ones. A failed run leaves no file to retain and must never push a
 * good archive out of the window — that would turn one bad night into the loss
 * of the oldest backup the shop still had.
 */
export const AUTOMATIC_BACKUP_RETENTION = 14;

/**
 * Which files the nightly job should delete, newest kept.
 *
 * Takes the successful archives it knows about, newest first is not assumed —
 * the caller may pass them in any order, because a directory listing has no
 * inherent one.
 */
export function archivesToDelete<T extends { readonly takenAt: string; readonly fileName: string }>(
  archives: readonly T[],
  keep: number = AUTOMATIC_BACKUP_RETENTION,
): readonly T[] {
  const newestFirst = [...archives].sort((a, b) => b.takenAt.localeCompare(a.takenAt));
  return newestFirst.slice(Math.max(keep, 0));
}

/**
 * How long the shop may go without pulling a copy off this machine before the
 * dashboard says so (owner decision 2026-08-30).
 */
export const MANUAL_EXPORT_REMINDER_DAYS = 7;

/**
 * The archive's file name: the business, the day, and nothing else.
 *
 * A shopkeeper picking a file off a pen drive months later reads the name, so
 * it carries the shop's own name rather than a tenant ULID. Anything that is
 * not a letter, digit or dash becomes a dash, because this string reaches a
 * `Content-Disposition` header and a FAT32 filesystem.
 */
export function archiveFileName(businessName: string, takenAt: Date): string {
  const slug =
    businessName
      .normalize('NFKD')
      .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .toLowerCase() || 'sher';
  const day = takenAt.toISOString().slice(0, 10);
  const time = takenAt.toISOString().slice(11, 16).replace(':', '');
  return `${slug}-${day}-${time}.sherdb`;
}
