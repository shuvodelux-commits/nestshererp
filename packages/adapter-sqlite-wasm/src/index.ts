/**
 * `@sher/adapter-sqlite-wasm` — the shop's own machine as a database (D-23,
 * §5.23, Phase 12.3).
 *
 * The SRS reserved this package for Phase 12 and told nobody to create it
 * early. This is that phase, and it is deliberately the smallest thing that
 * earns the name: it stores a downloaded snapshot and reads it back in the
 * shape the screens already render.
 *
 * **Phase 12.4 is the build where it writes.** The outbox, the local documents
 * and the encrypted archive live here now, and `OFFLINE_READY` is earned rather
 * than reserved. What it still does not do is post: a row in `outbox` is the
 * command the online endpoint would have received, waiting to be replayed by
 * the server through the very service the counter calls. No journal line, no
 * lot, no cost — those belong to the books, and the books are on the server.
 */
export {
  LIVE_FILE,
  localDbBytes,
  localDbExists,
  localStorageWorks,
  sahPool,
  STAGING_FILE,
} from './local-database';
export type { LocalDb } from './local-database';
export { localParties, localProducts } from './local-reads';
export {
  exportBackup,
  importBackup,
  readManifest,
} from './local-backup';
export type { BackupManifest, LocalBackup } from './local-backup';
export {
  applyChange,
  localUsers,
  markSent,
  outboxCounts,
  peekSaleNumber,
  pendingOperations,
  queueOperation,
  readLocalState,
  recordCursor,
  rememberDevice,
  settleOperation,
} from './local-write';
export type {
  LocalState,
  LocalUser,
  OutboxCounts,
  OutboxRow,
  QueuedOperation,
  QueuedResult,
} from './local-write';
export { eraseLocalCopy, readStoredSnapshot, storeSnapshot } from './snapshot-store';
export type { StoredSnapshot } from './snapshot-store';
