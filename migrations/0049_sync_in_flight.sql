-- Phase 12.4. A fourth thing an operation can be: **in flight**.
--
-- Replay does not wrap the posting service in a transaction of its own — the
-- service opens exactly one, does the whole document in it, and rolls the whole
-- document back if anything refuses (R-D1). That is what keeps a replayed sale
-- identical to a counter sale. But it leaves one gap: if the machine running
-- the API dies between the service's COMMIT and the row that records what
-- happened, the shop has the document and sync does not know it.
--
-- So the row is written **before** the service is called, as IN_FLIGHT. Finding
-- one on a later push is the signal that an operation was interrupted:
--
--   * ten of the thirteen operation types carry an `operation_id` all the way
--     into their own document table's unique index, so re-running is provably
--     free — the service returns the document it already wrote;
--   * the three that do not — opening a day, closing a day, moving money —
--     are quarantined for a person to look at instead, because re-running one
--     of those could post it twice and nothing in the schema would stop it.
ALTER TABLE sync_operations DROP CONSTRAINT sync_operations_status_known;
ALTER TABLE sync_operations
  ADD CONSTRAINT sync_operations_status_known
    CHECK (status IN ('IN_FLIGHT', 'APPLIED', 'DUPLICATE', 'QUARANTINED', 'DISCARDED', 'BLOCKED'));
