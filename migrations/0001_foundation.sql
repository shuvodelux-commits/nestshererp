-- Phase 0, slice 0.3 — cross-cutting foundation tables.
--
-- Forward-only (SRS 3.10). Column classes per SRS 3.4:
--   Class A  mutable                 tenants, users, roles, role_permissions,
--                                    period_locks, numbering_counters
--   Class B  transactional document  notes
--   Class C  append-only ledger      audit_events, outbox, idempotency_keys
--            (no updated_at, no updated_by, no version, no deleted_at/by —
--             those columns on an append-only table are lies)
--
-- Every table carries tenant_id (SRS 3.2), every index starts with tenant_id,
-- every unique constraint includes tenant_id, and RLS is ENABLED and FORCED so
-- even the table owner is subject to it.

-- ---------------------------------------------------------------- tenants
-- Class A. `id` IS the tenant id, so there is no separate tenant_id column;
-- the RLS policy scopes on id instead.
CREATE TABLE tenants (
  id          CHAR(26)    PRIMARY KEY,
  name        TEXT        NOT NULL,
  timezone    TEXT        NOT NULL DEFAULT 'Asia/Dhaka',
  created_at  TIMESTAMPTZ NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL,
  created_by  CHAR(26)    NOT NULL,
  updated_by  CHAR(26)    NOT NULL,
  version     INTEGER     NOT NULL DEFAULT 1,
  deleted_at  TIMESTAMPTZ NULL,
  deleted_by  CHAR(26)    NULL
);

-- ------------------------------------------------------------------ roles
CREATE TABLE roles (
  id          CHAR(26)    PRIMARY KEY,
  tenant_id   CHAR(26)    NOT NULL REFERENCES tenants (id),
  code        TEXT        NOT NULL,
  name        TEXT        NOT NULL,
  is_system   BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL,
  created_by  CHAR(26)    NOT NULL,
  updated_by  CHAR(26)    NOT NULL,
  version     INTEGER     NOT NULL DEFAULT 1,
  deleted_at  TIMESTAMPTZ NULL,
  deleted_by  CHAR(26)    NULL,
  CONSTRAINT roles_tenant_code_unique UNIQUE (tenant_id, code)
);

-- ------------------------------------------------------- role_permissions
-- Permission codes are static constants in core-contracts; this table records
-- which role holds which code. Mutable config, so Class A.
CREATE TABLE role_permissions (
  id              CHAR(26)    PRIMARY KEY,
  tenant_id       CHAR(26)    NOT NULL REFERENCES tenants (id),
  role_id         CHAR(26)    NOT NULL REFERENCES roles (id),
  permission_code TEXT        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL,
  created_by      CHAR(26)    NOT NULL,
  updated_by      CHAR(26)    NOT NULL,
  version         INTEGER     NOT NULL DEFAULT 1,
  deleted_at      TIMESTAMPTZ NULL,
  deleted_by      CHAR(26)    NULL,
  CONSTRAINT role_permissions_unique UNIQUE (tenant_id, role_id, permission_code)
);

-- ------------------------------------------------------------------ users
CREATE TABLE users (
  id            CHAR(26)    PRIMARY KEY,
  tenant_id     CHAR(26)    NOT NULL REFERENCES tenants (id),
  role_id       CHAR(26)    NOT NULL REFERENCES roles (id),
  email         TEXT        NOT NULL,
  display_name  TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL,
  created_by    CHAR(26)    NOT NULL,
  updated_by    CHAR(26)    NOT NULL,
  version       INTEGER     NOT NULL DEFAULT 1,
  deleted_at    TIMESTAMPTZ NULL,
  deleted_by    CHAR(26)    NULL,
  CONSTRAINT users_tenant_email_unique UNIQUE (tenant_id, email)
);

-- ----------------------------------------------------------- period_locks
-- Calendar month per tenant (D-25). Absence of a row means OPEN.
CREATE TABLE period_locks (
  id            CHAR(26)    PRIMARY KEY,
  tenant_id     CHAR(26)    NOT NULL REFERENCES tenants (id),
  period_year   INTEGER     NOT NULL,
  period_month  INTEGER     NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  status        TEXT        NOT NULL CHECK (status IN ('OPEN', 'CLOSED')),
  reason        TEXT        NULL,
  created_at    TIMESTAMPTZ NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL,
  created_by    CHAR(26)    NOT NULL,
  updated_by    CHAR(26)    NOT NULL,
  version       INTEGER     NOT NULL DEFAULT 1,
  deleted_at    TIMESTAMPTZ NULL,
  deleted_by    CHAR(26)    NULL,
  CONSTRAINT period_locks_unique UNIQUE (tenant_id, period_year, period_month)
);

-- ------------------------------------------------------ numbering_counters
-- One counter row per (tenant, doc_type, year), held with SELECT ... FOR UPDATE
-- inside the document's own transaction (SRS 3.7). No `version` column: this row
-- is guarded pessimistically, and an optimistic lock here would produce gaps.
CREATE TABLE numbering_counters (
  id          CHAR(26)    PRIMARY KEY,
  tenant_id   CHAR(26)    NOT NULL REFERENCES tenants (id),
  doc_type    TEXT        NOT NULL,
  year        INTEGER     NOT NULL,
  next_value  INTEGER     NOT NULL,
  prefix      TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL,
  created_by  CHAR(26)    NOT NULL,
  updated_by  CHAR(26)    NOT NULL,
  CONSTRAINT numbering_counters_unique UNIQUE (tenant_id, doc_type, year)
);

-- --------------------------------------------------------- audit_events
-- Class C. Every mutation writes one, with before/after values for money and
-- stock fields (R-D4). Never updated, never deleted.
CREATE TABLE audit_events (
  id            CHAR(26)    PRIMARY KEY,
  tenant_id     CHAR(26)    NOT NULL REFERENCES tenants (id),
  created_at    TIMESTAMPTZ NOT NULL,
  created_by    CHAR(26)    NOT NULL,
  entity_type   TEXT        NOT NULL,
  entity_id     CHAR(26)    NOT NULL,
  action        TEXT        NOT NULL,
  before_json   JSONB       NULL,
  after_json    JSONB       NULL,
  reason        TEXT        NULL,
  source        TEXT        NOT NULL
);

-- ---------------------------------------------------------------- outbox
-- Class C. Nothing reads this until Phase 12 (D7) — it is written from Phase 0
-- deliberately, because a sync engine built later against a partial change
-- history cannot reconstruct what it missed. DO NOT REMOVE AS DEAD CODE.
CREATE TABLE outbox (
  id              CHAR(26)    PRIMARY KEY,
  tenant_id       CHAR(26)    NOT NULL REFERENCES tenants (id),
  created_at      TIMESTAMPTZ NOT NULL,
  created_by      CHAR(26)    NOT NULL,
  event_type      TEXT        NOT NULL,
  aggregate_type  TEXT        NOT NULL,
  aggregate_id    CHAR(26)    NOT NULL,
  payload         JSONB       NOT NULL
);

-- ------------------------------------------------------- idempotency_keys
-- Class C, 30-day fast path only. The permanent guarantee is the unique index
-- on (tenant_id, operation_id) of the document table itself (§5.26, R-C10).
CREATE TABLE idempotency_keys (
  id             CHAR(26)    PRIMARY KEY,
  tenant_id      CHAR(26)    NOT NULL REFERENCES tenants (id),
  created_at     TIMESTAMPTZ NOT NULL,
  created_by     CHAR(26)    NOT NULL,
  operation_id   CHAR(26)    NOT NULL,
  request_fingerprint TEXT  NOT NULL,
  response_json  JSONB       NOT NULL,
  CONSTRAINT idempotency_keys_unique UNIQUE (tenant_id, operation_id)
);

-- ----------------------------------------------------------------- notes
-- Class B transactional document. This is the reference document for the R-D
-- write path — the table CreateNoteService writes. It carries the reserved
-- columns every transaction table must have (R-C9); tax columns stay NULL in V1
-- (D-09) and device_prefix is empty until offline writes exist (SRS 3.7).
CREATE TABLE notes (
  id                CHAR(26)    PRIMARY KEY,
  tenant_id         CHAR(26)    NOT NULL REFERENCES tenants (id),
  note_number       TEXT        NOT NULL,
  title             TEXT        NOT NULL,
  amount_minor      BIGINT      NOT NULL,
  business_date     DATE        NOT NULL,
  entry_mode        TEXT        NOT NULL CHECK (entry_mode IN ('ON_TIME', 'LATE_ENTRY', 'BACKDATED', 'CORRECTED')),
  status            TEXT        NOT NULL CHECK (status IN ('DRAFT', 'POSTED', 'VOIDED')),
  operation_id      CHAR(26)    NOT NULL,
  -- reserved columns (R-C9), unused in V1
  location_id       CHAR(26)    NULL,
  tax_rate_id       CHAR(26)    NULL,
  tax_amount        BIGINT      NULL,
  is_tax_inclusive  BOOLEAN     NULL,
  pack_size         INTEGER     NULL,
  device_prefix     TEXT        NULL,
  created_at        TIMESTAMPTZ NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL,
  created_by        CHAR(26)    NOT NULL,
  updated_by        CHAR(26)    NOT NULL,
  version           INTEGER     NOT NULL DEFAULT 1,
  deleted_at        TIMESTAMPTZ NULL,
  deleted_by        CHAR(26)    NULL,
  CONSTRAINT notes_tenant_operation_unique UNIQUE (tenant_id, operation_id),
  CONSTRAINT notes_tenant_number_unique UNIQUE (tenant_id, note_number)
);

-- ---------------------------------------------------------------- indexes
-- Every index starts with tenant_id (SRS 3.2). Keyset pagination order for
-- documents is (business_date DESC, id DESC) per §5.26.
CREATE INDEX users_tenant_role_idx ON users (tenant_id, role_id);
CREATE INDEX role_permissions_tenant_role_idx ON role_permissions (tenant_id, role_id);
CREATE INDEX audit_events_tenant_entity_idx ON audit_events (tenant_id, entity_type, entity_id);
CREATE INDEX audit_events_tenant_created_idx ON audit_events (tenant_id, created_at DESC);
CREATE INDEX outbox_tenant_created_idx ON outbox (tenant_id, created_at);
CREATE INDEX idempotency_keys_tenant_created_idx ON idempotency_keys (tenant_id, created_at);
CREATE INDEX notes_tenant_business_date_idx ON notes (tenant_id, business_date DESC, id DESC);

-- -------------------------------------------------------------------- RLS
-- The second line of defence under tenant-scoped queries (SRS 3.2). FORCE is
-- required because the application connects as the table owner, and an owner
-- bypasses a policy unless the table forces it.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenants
  USING (id = current_setting('app.tenant_id', TRUE)::CHAR(26));

ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON roles
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::CHAR(26));

ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON role_permissions
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::CHAR(26));

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON users
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::CHAR(26));

ALTER TABLE period_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE period_locks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON period_locks
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::CHAR(26));

ALTER TABLE numbering_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE numbering_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON numbering_counters
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::CHAR(26));

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_events
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::CHAR(26));

ALTER TABLE outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON outbox
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::CHAR(26));

ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON idempotency_keys
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::CHAR(26));

ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE notes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notes
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::CHAR(26));
