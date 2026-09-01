/**
 * `@sher/adapter-sqlite-wasm` — the shop's own machine as a database (D-23,
 * §5.23, Phase 12.3).
 *
 * The SRS reserved this package for Phase 12 and told nobody to create it
 * early. This is that phase, and it is deliberately the smallest thing that
 * earns the name: it stores a downloaded snapshot and reads it back in the
 * shape the screens already render.
 *
 * **It writes nothing of the shop's own making.** No sale, no document, no
 * journal line, no outbox. `OFFLINE_READY` stays reserved for the build where
 * those exist and genuinely work — a package that could quietly grow a write
 * path is exactly how a shopkeeper ends up trusting a till that cannot bill.
 */
export {
  LIVE_FILE,
  localDbBytes,
  localDbExists,
  localStorageWorks,
  STAGING_FILE,
} from './local-database';
export type { LocalDb } from './local-database';
export { localParties, localProducts } from './local-reads';
export { eraseLocalCopy, readStoredSnapshot, storeSnapshot } from './snapshot-store';
export type { StoredSnapshot } from './snapshot-store';
