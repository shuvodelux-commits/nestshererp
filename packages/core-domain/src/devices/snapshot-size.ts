/**
 * How much room this shop's offline snapshot will need (§5.23, owner decision
 * 2026-08-31: the space check is measured against the shop's own data, not a
 * fixed number).
 *
 * A flat "require 500 MB" is wrong in both directions: it locks a one-man
 * stationery shop out of a laptop that would have been fine, and it waves a
 * wholesaler with 40,000 products through onto a machine that will fill up in
 * March. So the estimate is built from what the tenant actually holds, and it
 * grows as the shop does.
 *
 * The per-row costs below are deliberate over-estimates of a SQLite row plus
 * its indexes — an estimate that is too small is the one that hurts, because it
 * passes the gate and then runs out of disk halfway through a business day.
 * They are replaced by the numbers the O-6 storage check measures on real
 * hardware; until then they are honest guesses, and the screen says so.
 *
 * Pure (R-C8).
 */
export interface SnapshotCounts {
  readonly products: number;
  readonly parties: number;
  /** Documents inside the snapshot window — sales, purchases, payments, etc. */
  readonly documents: number;
  /** Their lines, which outnumber the documents several times over. */
  readonly documentLines: number;
  /** Journal lines, the largest table in any shop that has been trading a while. */
  readonly journalLines: number;
  /** Open stock lots carried as movements. */
  readonly lots: number;
}

/** Bytes per row, indexes included. Over-estimates on purpose (see above). */
export const SNAPSHOT_ROW_BYTES = {
  products: 1024,
  parties: 768,
  documents: 768,
  documentLines: 384,
  journalLines: 320,
  lots: 320,
} as const;

/**
 * The application shell, the SQLite WASM runtime and the empty schema — what a
 * device needs before it holds a single row of the shop's data.
 */
export const SNAPSHOT_BASE_BYTES = 40 * 1024 * 1024;

/**
 * Headroom multiplier over the snapshot itself.
 *
 * Three times, because the snapshot is the *starting* size and a device is
 * expected to trade on it: a day's writes, the outbox holding them until they
 * are pushed, SQLite's own journal and free pages, and the growth between one
 * snapshot and the next all land in the same box. A gate that admitted a device
 * with exactly enough room for the snapshot would refuse its first sale.
 */
export const SNAPSHOT_HEADROOM_MULTIPLE = 3;

/** How many months of transactions the bootstrap snapshot carries (§5.23). */
export const SNAPSHOT_MONTHS = 12;

export function estimateSnapshotBytes(counts: SnapshotCounts): number {
  const rows =
    counts.products * SNAPSHOT_ROW_BYTES.products +
    counts.parties * SNAPSHOT_ROW_BYTES.parties +
    counts.documents * SNAPSHOT_ROW_BYTES.documents +
    counts.documentLines * SNAPSHOT_ROW_BYTES.documentLines +
    counts.journalLines * SNAPSHOT_ROW_BYTES.journalLines +
    counts.lots * SNAPSHOT_ROW_BYTES.lots;
  return SNAPSHOT_BASE_BYTES + rows;
}

/** The snapshot plus the room it needs to be worked in — what the gate checks. */
export function requiredOfflineBytes(counts: SnapshotCounts): number {
  return estimateSnapshotBytes(counts) * SNAPSHOT_HEADROOM_MULTIPLE;
}
