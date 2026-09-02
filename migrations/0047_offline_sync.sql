-- Phase 12.4 — the offline shop that trades and comes back (§5.23, D-01,
-- owner decisions 2026-09-02). Forward-only and additive (§3.10).
--
--   `sync_operations`     every operation a device has pushed, and what
--                         became of it
--   `sync_conflicts`      the ones the books would not accept, and what a
--                         person decided about each
--   `device_user_access`  which people may sign in on a given machine while
--                         it is disconnected
--
-- plus a permanent short code on every registered device, a device column on
-- the numbering counters, and the origin trail on twelve document tables.
--
-- **Nothing here posts.** Replay runs the ordinary application services inside
-- the ordinary transaction; these tables only record what was sent, in what
-- order, and what the server did with it. A table that held a business figure
-- of its own would be the first thing to disagree with the ledger (INV-10).

-- ------------------------------------------------- the device's short code
--
-- `S-2026-A-000123`. The code is assigned once, at registration, and never
-- changes or is reused — an invoice number is printed on paper the shop files,
-- so the letter in it must mean the same machine forever. `0` is reserved for
-- the shop's own central counter: a sale typed on a browser that never
-- registered itself is `S-2026-0-000123`, which cannot collide with any device
-- because assigned codes are always letters.
ALTER TABLE device_authorizations
  ADD COLUMN device_code TEXT,
  -- Where this machine's pull got to, so a reconnect resumes rather than
  -- re-downloads. A timestamp, not a row count: the change feed is served from
  -- the master tables' own `updated_at`, which cannot drift from them.
  ADD COLUMN sync_cursor TIMESTAMPTZ,
  ADD COLUMN last_push_at TIMESTAMPTZ,
  ADD COLUMN last_pull_at TIMESTAMPTZ;

-- Existing rows get their codes in `backfill-seed-roles`, which is where ULIDs
-- and per-tenant sequences are allowed to come from (R-C1). A code may not be
-- blank once set, and no two devices in one shop share one.
ALTER TABLE device_authorizations
  ADD CONSTRAINT device_authorizations_device_code_shape
    CHECK (device_code IS NULL OR device_code ~ '^[A-Z]{1,3}$');

CREATE UNIQUE INDEX device_authorizations_code_unique
  ON device_authorizations (tenant_id, device_code)
  WHERE device_code IS NOT NULL;

-- --------------------------------------------------- device numbering scope
--
-- The counter becomes per (tenant, doc_type, year, **device**). Existing rows
-- take `0`, the central code, so every number already issued keeps meaning
-- exactly what it meant and the next central sale continues the same run.
ALTER TABLE numbering_counters
  ADD COLUMN device_code TEXT NOT NULL DEFAULT '0';

ALTER TABLE numbering_counters DROP CONSTRAINT numbering_counters_unique;
ALTER TABLE numbering_counters
  ADD CONSTRAINT numbering_counters_unique UNIQUE (tenant_id, doc_type, year, device_code);

-- ------------------------------------------------------- device_user_access
--
-- Who may open the counter on a machine that cannot reach the server (§9 of the
-- owner's specification). Kept apart from roles on purpose: a role says what a
-- person may do, this says where they may do it without the server watching,
-- and the second question has a different answer for the same cashier on the
-- shop's counter PC and on a phone left in a drawer.
CREATE TABLE device_user_access (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL REFERENCES tenants (id),
  device_id CHAR(26) NOT NULL REFERENCES device_authorizations (id),
  user_id CHAR(26) NOT NULL REFERENCES users (id),
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  created_by CHAR(26) NOT NULL, updated_by CHAR(26) NOT NULL,
  CONSTRAINT device_user_access_unique UNIQUE (tenant_id, device_id, user_id)
);

CREATE INDEX device_user_access_by_device ON device_user_access (tenant_id, device_id);

-- ---------------------------------------------------------- sync_operations
--
-- One row per operation a device has pushed, kept forever. This is the shop's
-- own record that the thing was sent, so a document that was refused, retried
-- and finally posted can be read end to end afterwards; and it is what makes a
-- second push of the same batch cost nothing (§2: replaying an accepted
-- `operation_id` performs zero further effects and returns the first answer).
--
-- The permanent idempotency guarantee is **not** this table — it is the
-- `(tenant_id, operation_id)` unique index each document table already carries
-- (R-C10). This row is the fast path and the audit trail.
CREATE TABLE sync_operations (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL REFERENCES tenants (id),
  device_id CHAR(26) NOT NULL REFERENCES device_authorizations (id),
  -- The idempotency key the online API would have received in the header. The
  -- device generated it when the cashier pressed the button, and it never
  -- changes through any number of retries.
  operation_id CHAR(26) NOT NULL,
  -- The device's own strictly increasing counter. Two operations from one
  -- machine can share a millisecond; they cannot share a `local_seq`.
  local_seq BIGINT NOT NULL,
  op_type TEXT NOT NULL,
  -- The exact zod-validated command DTO the online endpoint takes. Stored whole
  -- rather than spread into columns, for the reason §5.23 gives: a column per
  -- field would be a second definition of the command, and the day it drifted a
  -- replayed sale would differ from the sale that was printed.
  payload JSONB NOT NULL,
  -- `user_id`, `business_date`, `device_created_at`, `permissions_snapshot_hash`.
  context JSONB NOT NULL,
  -- `local_seq` values this operation may not be replayed before: the product
  -- a sale names, the purchase that put its stock on the shelf.
  depends_on JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- What the device believed the customer-facing money was. Compared, never
  -- trusted (§5.23: the server never trusts device-computed totals).
  client_result_digest TEXT,
  -- Preserved through replay and used for costing order (§7 of the owner's
  -- specification). Reconnect time may never reorder business history.
  device_created_at TIMESTAMPTZ NOT NULL,
  business_date DATE NOT NULL,
  status TEXT NOT NULL,
  -- What it became, when it became something.
  result_document_id CHAR(26),
  result_document_number TEXT,
  server_result_digest TEXT,
  -- Divergence between the two digests, recorded rather than discarded.
  divergence JSONB,
  -- The shop-wide order in which the server accepted things, which is what a
  -- pull cursor and a resumed push count against.
  server_seq BIGINT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  last_error_message TEXT,
  received_at TIMESTAMPTZ NOT NULL,
  applied_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  created_by CHAR(26) NOT NULL, updated_by CHAR(26) NOT NULL,
  CONSTRAINT sync_operations_status_known
    CHECK (status IN ('APPLIED', 'DUPLICATE', 'QUARANTINED', 'DISCARDED', 'BLOCKED')),
  -- One operation id per shop, whatever it took to get it in. This is what
  -- makes a repeated batch a no-op rather than a second sale.
  CONSTRAINT sync_operations_operation_unique UNIQUE (tenant_id, operation_id),
  -- §8's uniqueness invariant: shop + device + device sequence. A machine
  -- cannot issue two operations under one sequence number, whatever it thinks
  -- it remembers after a restore.
  CONSTRAINT sync_operations_device_seq_unique UNIQUE (tenant_id, device_id, local_seq)
);

CREATE SEQUENCE sync_operations_server_seq;

CREATE INDEX sync_operations_by_status
  ON sync_operations (tenant_id, status, received_at DESC);
CREATE INDEX sync_operations_by_device
  ON sync_operations (tenant_id, device_id, local_seq);
CREATE INDEX sync_operations_by_document
  ON sync_operations (tenant_id, result_document_id)
  WHERE result_document_id IS NOT NULL;

-- ----------------------------------------------------------- sync_conflicts
--
-- Quarantine, never auto-discard (§5.23). A row here means the server would not
-- take the operation and no person has decided what to do about it yet. It
-- carries both sides — what the device sent and what the shop's books say now —
-- because the manager resolving it cannot open two screens at the counter.
CREATE TABLE sync_conflicts (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL REFERENCES tenants (id),
  sync_operation_id CHAR(26) NOT NULL REFERENCES sync_operations (id),
  reason_code TEXT NOT NULL,
  reason_message TEXT NOT NULL,
  -- What the shop's books hold for the thing the operation names, at the moment
  -- of the refusal. A snapshot for the reader, never read back to decide
  -- anything: resolution re-runs the operation against live state.
  server_state JSONB,
  local_state JSONB,
  -- Only the actions that make sense for this reason. A closed period cannot be
  -- merged; a duplicate phone number cannot be kept both ways without an edit.
  suggested_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'OPEN',
  resolution TEXT,
  resolution_reason TEXT,
  resolved_at TIMESTAMPTZ,
  resolved_by CHAR(26),
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  created_by CHAR(26) NOT NULL, updated_by CHAR(26) NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT sync_conflicts_status_known
    CHECK (status IN ('OPEN', 'RESOLVED', 'DISCARDED')),
  CONSTRAINT sync_conflicts_resolution_known
    CHECK (resolution IS NULL OR resolution IN ('RETRY', 'MERGE', 'KEEP_BOTH_EDIT', 'DISCARD_WITH_REASON')),
  -- §16: discarding is a decision, and a decision without a reason is not one.
  CONSTRAINT sync_conflicts_discard_has_reason
    CHECK (resolution <> 'DISCARD_WITH_REASON'
           OR (resolution_reason IS NOT NULL AND length(btrim(resolution_reason)) >= 3)),
  -- One open conflict per operation. A retry that fails again updates the row
  -- it already has rather than growing a pile the manager has to read twice.
  CONSTRAINT sync_conflicts_one_per_operation UNIQUE (tenant_id, sync_operation_id)
);

CREATE INDEX sync_conflicts_open
  ON sync_conflicts (tenant_id, created_at DESC)
  WHERE status = 'OPEN';

-- ------------------------------------------------------------ origin trail
--
-- Permanent, on the document itself (§18). Never cleared — not on sync, not on
-- a later correction. `origin_mode` is the fact; `origin_device_id` alone could
-- not carry it, because an online sale from the counter PC also names a device.
--
-- Informational only. A synced offline document is an ordinary posted document:
-- it posts the same journal, corrects through Phase 9.2's paths, and counts in
-- every report without qualification.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'sales', 'purchases', 'sales_returns', 'purchase_returns',
    'customer_receipts', 'supplier_payments', 'expenses', 'stock_adjustments',
    'cash_sessions', 'cash_session_closes', 'parties', 'products'
  ] LOOP
    EXECUTE format('ALTER TABLE %I
      ADD COLUMN origin_mode TEXT NOT NULL DEFAULT ''ONLINE'',
      ADD COLUMN origin_device_id CHAR(26) REFERENCES device_authorizations (id),
      ADD COLUMN device_created_at TIMESTAMPTZ,
      ADD COLUMN synced_at TIMESTAMPTZ,
      ADD COLUMN device_seq BIGINT', t);

    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I
      CHECK (origin_mode IN (''ONLINE'', ''OFFLINE''))', t, t || '_origin_mode_known');

    -- A document that says it was made offline must say which machine made it
    -- and when it was typed, because those are the two facts the tag shows and
    -- the costing order needs.
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I
      CHECK (origin_mode <> ''OFFLINE''
             OR (origin_device_id IS NOT NULL AND device_created_at IS NOT NULL))',
      t, t || '_offline_has_origin');

    EXECUTE format('CREATE INDEX %I ON %I (tenant_id, origin_mode) WHERE origin_mode = ''OFFLINE''',
      t || '_offline_origin_idx', t);
  END LOOP;
END $$;

ALTER TABLE sync_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sync_operations
  USING (tenant_id = current_setting('app.tenant_id')::char(26));

ALTER TABLE sync_conflicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_conflicts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sync_conflicts
  USING (tenant_id = current_setting('app.tenant_id')::char(26));

ALTER TABLE device_user_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_user_access FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON device_user_access
  USING (tenant_id = current_setting('app.tenant_id')::char(26));
