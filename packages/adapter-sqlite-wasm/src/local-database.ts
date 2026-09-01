/**
 * SQLite WASM over OPFS — the shop's data on the shop's own machine (D-23,
 * §5.23, Phase 12.3).
 *
 * **The SAH-pool VFS, not the plain OPFS one.** The plain VFS needs
 * `SharedArrayBuffer`, which needs `Cross-Origin-Opener-Policy` and
 * `Cross-Origin-Embedder-Policy` on the app origin — and those headers break
 * Google sign-in (D-07). §6.5 still tells a reader to set them "before Phase
 * 12, not during it"; Phase 12.1 measured the alternative on the storage-check
 * page and this is the decision that came out of it. The SAH pool needs no
 * headers at all, which is why the offline path can exist without breaking the
 * way most shopkeepers log in.
 *
 * One pool, opened once per page. The pool holds file handles open for as long
 * as it lives, so a second pool over the same directory is not a second
 * connection — it is a conflict.
 */
import type sqlite3InitModule from '@sqlite.org/sqlite-wasm';

type Sqlite3Static = Awaited<ReturnType<typeof sqlite3InitModule>>;
type SahPool = Awaited<ReturnType<Sqlite3Static['installOpfsSAHPoolVfs']>>;
export type LocalDb = InstanceType<SahPool['OpfsSAHPoolDb']>;

/**
 * The OPFS directory this pool owns. Distinct from the storage check's
 * `sher-storage-check`, because two pools may not share a directory and the
 * check is allowed to wipe its own.
 */
const POOL_NAME = 'sher-offline';

/** The live copy, and the one being built. Absolute paths, as the VFS requires. */
export const LIVE_FILE = '/shop.sqlite3';
export const STAGING_FILE = '/shop-staging.sqlite3';

/**
 * Two databases plus their journals. The default of 6 is enough, but a pool
 * that runs out of slots fails in the middle of a download rather than at the
 * start of one, so the minimum is asked for explicitly.
 */
const MIN_CAPACITY = 8;

let poolPromise: Promise<SahPool> | null = null;

/**
 * The pool, installed on first use.
 *
 * Deliberately not installed at startup: loading the WASM runtime costs a
 * moment and most machines in a shop are ordinary online computers that will
 * never hold a copy. The first caller who genuinely needs local storage pays
 * for it.
 */
export function sahPool(): Promise<SahPool> {
  poolPromise ??= install();
  return poolPromise;
}

async function install(): Promise<SahPool> {
  const init = (await import('@sqlite.org/sqlite-wasm')).default;
  const sqlite3 = await init();
  const pool = await sqlite3.installOpfsSAHPoolVfs({ name: POOL_NAME });
  await pool.reserveMinimumCapacity(MIN_CAPACITY);
  return pool;
}

/**
 * Whether this browser can hold a local database at all.
 *
 * Answered by trying, because every cheaper test lies: a private window has
 * `navigator.storage`, reports a quota, and then refuses the first write.
 */
export async function localStorageWorks(): Promise<boolean> {
  try {
    await sahPool();
    return true;
  } catch {
    return false;
  }
}

/** Opens a database in the pool, creating it if it is not there. */
export async function openLocalDb(file: string): Promise<LocalDb> {
  const pool = await sahPool();
  return new pool.OpfsSAHPoolDb(file);
}

/**
 * Deletes a file from the pool.
 *
 * Never throws: this is called when authority has been revoked and on the
 * failure path of a download, and in both cases something worse than a missing
 * file has already happened. Returns whether anything was actually removed.
 */
export async function unlinkLocal(file: string): Promise<boolean> {
  try {
    const pool = await sahPool();
    return pool.unlink(file);
  } catch {
    return false;
  }
}

/** Whether the live copy exists in the pool right now. */
export async function localDbExists(file: string): Promise<boolean> {
  try {
    const pool = await sahPool();
    return pool.getFileNames().includes(file);
  } catch {
    return false;
  }
}

/**
 * Replaces the live database with the staged one, whole.
 *
 * This is the swap the owner asked for on 2026-08-31: a refresh that fails
 * halfway must leave yesterday's copy untouched, because half a shop is worse
 * than an old one. The staged file is exported as bytes and imported over the
 * live name in one call — `importDb` overwrites, so there is no moment where
 * the live name holds a partial database. Everything before this point can
 * fail freely.
 */
export async function promoteStaging(): Promise<number> {
  const pool = await sahPool();
  const bytes = await pool.exportFile(STAGING_FILE);
  const written = await pool.importDb(LIVE_FILE, bytes);
  pool.unlink(STAGING_FILE);
  return written;
}

/** How many bytes the live copy occupies, or null when there is none. */
export async function localDbBytes(): Promise<number | null> {
  try {
    const pool = await sahPool();
    if (!pool.getFileNames().includes(LIVE_FILE)) return null;
    return (await pool.exportFile(LIVE_FILE)).byteLength;
  } catch {
    return null;
  }
}
