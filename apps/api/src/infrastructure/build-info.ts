import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { BuildInfo } from '@sher/core-application';

/**
 * What build this is (Phase 10).
 *
 * **The schema version is the newest migration this build ships, read from the
 * directory rather than kept in a constant.** A constant is a number somebody
 * has to remember to bump, and the release where they forget is the release
 * that boots against a database it does not match and says everything is fine.
 * The directory cannot forget.
 *
 * Read once, at construction: the files on disk do not change while the process
 * runs, and a version that could drift mid-process would make the boot gate
 * meaningless.
 */
export function loadBuildInfo(migrationsDirectory: string, packageJsonPath: string): BuildInfo {
  return {
    appVersion: readVersion(packageJsonPath),
    schemaVersion: newestMigration(migrationsDirectory),
  };
}

export function newestMigration(directory: string): string {
  const files = readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));
  const newest = files.at(-1);
  if (newest === undefined) {
    throw new Error(`no migrations found in ${directory}`);
  }
  return newest;
}

function readVersion(packageJsonPath: string): string {
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: string };
    return parsed.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Where the API finds the repository-root migrations directory from `dist`. */
export const MIGRATIONS_DIRECTORY = join(__dirname, '../../../../migrations');
export const PACKAGE_JSON_PATH = join(__dirname, '../../../package.json');
