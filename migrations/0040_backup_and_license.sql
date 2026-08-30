-- Phase 10 — backup, restore and licence visibility.
--
-- Two tables, and neither of them holds a business figure. This module posts
-- nothing: it copies the business out, puts it back, and reports what the
-- licence says. Every table it writes describes an *operation on the database*,
-- never a transaction inside it.
--
--   `backup_runs`     one row per archive attempt, automatic or manual
--   `restore_events`  one row per restore, kept as the record of where the
--                     current data came from
--
-- Both are deliberately **excluded from the `.sherdb` archive itself**. They
-- describe files that live on one machine — a restore onto a new machine that
-- claimed fourteen nightly backups existed would be lying about the only thing
-- an owner consults this screen to find out.

-- ------------------------------------------------------------- backup_runs
-- A run is only SUCCESS once the archive has been written, reopened, decrypted
-- and checked against its own manifest. Verification is not a separate status
-- because a backup nobody could read is not a backup that half-worked.
--
-- The nightly run has no user, so it is written by `SYSTEM_ACTOR_ID` — the
-- reserved ULID-shaped constant Phase 0 already uses for platform events that
-- no person performed. Same convention, so `created_by` stays NOT NULL like
-- every other table and nothing has to special-case a null actor.
CREATE TABLE backup_runs (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL REFERENCES tenants (id),
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,
  file_name TEXT,
  byte_size BIGINT,
  checksum TEXT,
  archive_version INTEGER,
  schema_version TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  created_by CHAR(26) NOT NULL, updated_by CHAR(26) NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT backup_runs_kind_known CHECK (kind IN ('AUTO', 'MANUAL')),
  CONSTRAINT backup_runs_status_known CHECK (status IN ('RUNNING', 'SUCCESS', 'FAILED')),
  CONSTRAINT backup_runs_success_is_verified
    CHECK (status <> 'SUCCESS' OR (verified_at IS NOT NULL AND checksum IS NOT NULL))
);

-- The dashboard asks two questions of this table on every load — "did the last
-- automatic run fail" and "how long since a manual export" — and both are a
-- descending scan of the same index.
CREATE INDEX backup_runs_by_kind_time ON backup_runs (tenant_id, kind, started_at DESC);

ALTER TABLE backup_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE backup_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON backup_runs USING (tenant_id = current_setting('app.tenant_id')::char(26));

-- ---------------------------------------------------------- restore_events
-- Written **after** the restore, under the restored business's own tenant id,
-- so it survives as part of that business's record. A row written before the
-- wipe would belong to the temporary seeded identity and be deleted by the very
-- operation it documents.
CREATE TABLE restore_events (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL REFERENCES tenants (id),
  source_file_name TEXT NOT NULL,
  archive_version INTEGER NOT NULL,
  archive_schema_version TEXT NOT NULL,
  archive_taken_at TIMESTAMPTZ NOT NULL,
  business_name TEXT NOT NULL,
  row_count BIGINT NOT NULL,
  restored_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  created_by CHAR(26) NOT NULL, updated_by CHAR(26) NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);

ALTER TABLE restore_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE restore_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON restore_events USING (tenant_id = current_setting('app.tenant_id')::char(26));
