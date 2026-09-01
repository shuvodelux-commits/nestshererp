-- Phase 12.3 — what the offline computer actually used (§5.23, open item O-6,
-- owner direction 2026-08-31).
-- Forward-only and additive (§3.10).
--
-- The owner's instruction was explicit: do not block the snapshot on a lab
-- measurement, and do not invent a fixed storage ceiling — but **record the
-- real numbers**, so O-6 is closed later by shops rather than by a guess.
--
-- These four columns are that record. They sit on `device_authorizations`
-- rather than in a table of their own because there is exactly one current
-- answer per machine, and a history of every refresh would be a growing table
-- nobody reads. When a shop's numbers are wanted, they are on the row that
-- already says which machine it is.
--
-- **None of them holds a business figure**, and none of them may ever decide
-- anything. The D-24 gate is measured live in the browser against the server's
-- own estimate; a stored byte count from last Tuesday deciding whether a device
-- may work today would be exactly the stale gate D-24 exists to prevent.

ALTER TABLE device_authorizations
  -- Bytes the local SQLite database occupies once the snapshot is written.
  ADD COLUMN snapshot_bytes bigint,
  -- `navigator.storage.estimate()` right after the write — what this browser
  -- profile is using in total, and what it is allowed. Nullable because a
  -- browser is entitled to refuse the question.
  ADD COLUMN snapshot_usage_bytes bigint,
  ADD COLUMN snapshot_quota_bytes bigint,
  -- Download and store, end to end. The number O-6 asks for as "snapshot
  -- import time" on a low-end shop PC.
  ADD COLUMN snapshot_elapsed_ms integer,
  ADD COLUMN snapshot_reported_at timestamptz;

COMMENT ON COLUMN device_authorizations.snapshot_bytes IS
  'Phase 12.3 / O-6: measured size of this machine''s local copy. A report, never a gate.';
