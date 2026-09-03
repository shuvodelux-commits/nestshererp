-- Phase 17.1 — the vendor control plane's own database.
--
-- This schema lives in a database of its own (`sher_control`), and that is the
-- most important line in the file. Not a schema inside a shop's database, not a
-- set of tables beside the ledger: a separate database, reached by a separate
-- pool, from a process that `pnpm test:boundaries` forbids from importing the
-- ERP's domain or its Postgres adapter.
--
-- The reason is §22. Everything here is metadata about installations — who
-- runs what version, whose licence expires when, which shops saw which error
-- code. None of it is a sale, a ledger line, a customer or a price, and there
-- is no table below into which such a thing could be written. A control plane
-- that shares a database with the data plane is one JOIN away from becoming the
-- data plane, and that is precisely the SaaS conversion the owner ruled out.
--
-- Note also what is *not* here: no signing key, of any kind, in any column.
-- §5 puts the licence private key outside ordinary application tables, and the
-- command and support keys follow it. They live with the signer service, on
-- disk at 0600, and nothing in this database can read them.

-- ---------------------------------------------------------------------------
-- Operators — the vendor's own people. Never a shop's users (§23).
-- ---------------------------------------------------------------------------

CREATE TABLE operators (
  id                TEXT        PRIMARY KEY,
  email             TEXT        NOT NULL UNIQUE,
  name              TEXT        NOT NULL,
  -- scrypt, in the same `scrypt$N$r$p$salt$key` encoding the ERP writes, so the
  -- two implementations can be checked against each other rather than diverging.
  password_hash     TEXT        NOT NULL,
  -- The TOTP shared secret, AES-256-GCM sealed with CONTROL_SECRET_KEY. Sealed
  -- rather than stored plainly because a database backup that leaks would
  -- otherwise hand over the second factor along with the first.
  totp_secret_sealed TEXT       NOT NULL,
  totp_enrolled     BOOLEAN     NOT NULL DEFAULT FALSE,
  role              TEXT        NOT NULL,
  disabled_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT operators_role_known CHECK (
    role IN ('PLATFORM_OWNER', 'SUPPORT_ENGINEER', 'RELEASE_OPERATOR', 'LICENCE_OPERATOR', 'AUDITOR')
  )
);

-- Sessions are rows, not just signed tokens, so that revoking one is immediate.
-- A JWT alone cannot be withdrawn before it expires; this table is what makes
-- "sign this operator out now" mean now.
CREATE TABLE operator_sessions (
  id             TEXT        PRIMARY KEY,
  operator_id    TEXT        NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  issued_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  -- Set when a sensitive action last re-checked TOTP (§24). Actions in
  -- REAUTH_ACTIONS require this to be recent, so a stolen session token is not
  -- on its own enough to revoke a licence or enter a customer's ERP.
  reauth_at      TIMESTAMPTZ,
  revoked_at     TIMESTAMPTZ,
  ip             TEXT        NOT NULL DEFAULT '',
  user_agent     TEXT        NOT NULL DEFAULT ''
);
CREATE INDEX operator_sessions_by_operator ON operator_sessions (operator_id, issued_at DESC);

-- ---------------------------------------------------------------------------
-- The audit trail (§15, §24). Append-only, and enforced as such.
-- ---------------------------------------------------------------------------

CREATE TABLE vendor_audit (
  id             BIGSERIAL   PRIMARY KEY,
  at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  operator_id    TEXT,
  operator_name  TEXT        NOT NULL DEFAULT '',
  action         TEXT        NOT NULL,
  tenant_id      TEXT,
  installation_id TEXT,
  -- Mandatory for everything in REAUTH_ACTIONS; the service refuses without it.
  reason         TEXT        NOT NULL DEFAULT '',
  subject        TEXT        NOT NULL DEFAULT '',
  before_value   JSONB,
  after_value    JSONB,
  ip             TEXT        NOT NULL DEFAULT '',
  user_agent     TEXT        NOT NULL DEFAULT ''
);
CREATE INDEX vendor_audit_by_time ON vendor_audit (at DESC);
CREATE INDEX vendor_audit_by_tenant ON vendor_audit (tenant_id, at DESC);
CREATE INDEX vendor_audit_by_operator ON vendor_audit (operator_id, at DESC);

-- An audit row that can be edited is not an audit row. The trigger refuses at
-- the database, below every service, so a bug or a console session cannot
-- quietly rewrite history — and a vendor who can erase evidence of what they
-- did inside a customer's ERP is exactly what §15 exists to prevent.
CREATE OR REPLACE FUNCTION vendor_audit_is_append_only() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'vendor_audit is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER vendor_audit_no_update
  BEFORE UPDATE OR DELETE ON vendor_audit
  FOR EACH ROW EXECUTE FUNCTION vendor_audit_is_append_only();

-- ---------------------------------------------------------------------------
-- Customers and their installations (§2).
-- ---------------------------------------------------------------------------

CREATE TABLE tenants (
  id             TEXT        PRIMARY KEY,
  name           TEXT        NOT NULL,
  contact_name   TEXT        NOT NULL DEFAULT '',
  contact_phone  TEXT        NOT NULL DEFAULT '',
  contact_email  TEXT        NOT NULL DEFAULT '',
  notes          TEXT        NOT NULL DEFAULT '',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at    TIMESTAMPTZ
);

CREATE TABLE installations (
  id                  TEXT        PRIMARY KEY,
  tenant_id           TEXT        NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  label               TEXT        NOT NULL DEFAULT '',
  -- The ERP's own tenant id, reported at enrolment. §2: identity is never
  -- inferred from a domain name, which the customer can change.
  erp_tenant_id       TEXT        NOT NULL DEFAULT '',
  -- The business id a licence must name for this installation. Copied from
  -- erp_tenant_id at enrolment and never guessed.
  business_id         TEXT        NOT NULL DEFAULT '',
  deployment_url      TEXT        NOT NULL DEFAULT '',
  local_url           TEXT        NOT NULL DEFAULT '',
  state               TEXT        NOT NULL DEFAULT 'PENDING_ENROLMENT',
  revoked_at          TIMESTAMPTZ,
  revoke_reason       TEXT        NOT NULL DEFAULT '',
  -- Last-known fleet metadata, overwritten by each check-in (§6).
  agent_version       TEXT        NOT NULL DEFAULT '',
  app_version         TEXT        NOT NULL DEFAULT '',
  release_id          TEXT        NOT NULL DEFAULT '',
  schema_version      TEXT        NOT NULL DEFAULT '',
  runtime             TEXT        NOT NULL DEFAULT '',
  licence_fingerprint TEXT        NOT NULL DEFAULT '',
  licence_state       TEXT        NOT NULL DEFAULT 'UNKNOWN',
  licence_valid_until TEXT        NOT NULL DEFAULT '',
  last_seen_at        TIMESTAMPTZ,
  last_backup_at      TEXT        NOT NULL DEFAULT '',
  last_backup_ok      BOOLEAN     NOT NULL DEFAULT FALSE,
  disk_used_percent   INTEGER     NOT NULL DEFAULT 0,
  sync_pending        INTEGER     NOT NULL DEFAULT 0,
  sync_conflicts_open INTEGER     NOT NULL DEFAULT 0,
  migration_state     TEXT        NOT NULL DEFAULT '',
  health              TEXT        NOT NULL DEFAULT 'UNKNOWN',
  uptime_seconds      BIGINT      NOT NULL DEFAULT 0,
  checkin_interval_seconds INTEGER NOT NULL DEFAULT 180,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX installations_by_tenant ON installations (tenant_id);
CREATE INDEX installations_by_last_seen ON installations (last_seen_at DESC NULLS LAST);
-- One installation per ERP tenant id, once enrolled. Two machines claiming the
-- same shop is either a cloned VM or an impersonation attempt; both need a
-- person to look, not a silent second row.
CREATE UNIQUE INDEX installations_one_per_erp_tenant
  ON installations (erp_tenant_id) WHERE erp_tenant_id <> '';

-- The installation's public key, with history, so rotation and revocation are
-- ordinary operations rather than surgery (§3). The private half is never here,
-- never anywhere on the vendor's side: it is generated on the shop's machine.
CREATE TABLE installation_keys (
  id             TEXT        PRIMARY KEY,
  installation_id TEXT       NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  key_id         TEXT        NOT NULL,
  public_key     TEXT        NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at     TIMESTAMPTZ,
  retire_reason  TEXT        NOT NULL DEFAULT ''
);
CREATE INDEX installation_keys_active
  ON installation_keys (installation_id) WHERE retired_at IS NULL;

-- Single-use enrolment tokens. Only the hash is stored: the token itself is
-- shown once, in the dashboard, and if this table leaked the hashes would not
-- let anyone enrol.
CREATE TABLE enrolment_tokens (
  token_hash     TEXT        PRIMARY KEY,
  tenant_id      TEXT        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  installation_id TEXT       NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  created_by     TEXT        NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  used_at        TIMESTAMPTZ,
  used_from_ip   TEXT        NOT NULL DEFAULT ''
);

-- Replay protection for signed agent requests. A nonce is remembered for longer
-- than the clock-skew window the guard accepts, so a captured request cannot be
-- replayed even at the very edge of that window.
CREATE TABLE agent_nonces (
  installation_id TEXT       NOT NULL,
  nonce          TEXT        NOT NULL,
  seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (installation_id, nonce)
);
CREATE INDEX agent_nonces_by_age ON agent_nonces (seen_at);

-- ---------------------------------------------------------------------------
-- Commands (§17, §18).
-- ---------------------------------------------------------------------------

CREATE TABLE commands (
  id              TEXT        PRIMARY KEY,
  tenant_id       TEXT        NOT NULL,
  installation_id TEXT        NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  type            TEXT        NOT NULL,
  payload         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  -- The exact signed bytes, kept so a dispute can be settled by re-verifying
  -- rather than by re-serialising and hoping it matches.
  envelope        JSONB       NOT NULL,
  signature       TEXT        NOT NULL,
  idempotency_key TEXT        NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'PENDING',
  rejection       TEXT,
  failure_code    TEXT,
  result          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_by      TEXT        NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  dispatched_at   TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ
);
-- §18: "replay of an already completed idempotent command must not perform the
-- action twice". This index is the guarantee — a second attempt to queue the
-- same logical command collides here and returns the first one's result.
CREATE UNIQUE INDEX commands_idempotent
  ON commands (installation_id, idempotency_key);
CREATE INDEX commands_pending
  ON commands (installation_id, created_at) WHERE status = 'PENDING';

-- ---------------------------------------------------------------------------
-- Check-ins and diagnostics (§6, §7).
-- ---------------------------------------------------------------------------

CREATE TABLE checkins (
  id              BIGSERIAL   PRIMARY KEY,
  installation_id TEXT        NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The reported metadata, as sent. Bounded by the schema in
  -- control-contracts, which has nowhere for business data to go.
  payload         JSONB       NOT NULL
);
CREATE INDEX checkins_by_installation ON checkins (installation_id, received_at DESC);

CREATE TABLE diagnostics (
  id              BIGSERIAL   PRIMARY KEY,
  installation_id TEXT        NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  code            TEXT        NOT NULL,
  module          TEXT        NOT NULL DEFAULT '',
  -- The route *pattern*, never a resolved URL: `/api/v1/purchases/:id` names
  -- the bug, `/api/v1/purchases/01J8...` names a customer's document.
  route           TEXT        NOT NULL DEFAULT '',
  http_status     INTEGER     NOT NULL DEFAULT 0,
  correlation_id  TEXT        NOT NULL DEFAULT '',
  app_version     TEXT        NOT NULL DEFAULT '',
  schema_version  TEXT        NOT NULL DEFAULT '',
  occurred_at     TIMESTAMPTZ NOT NULL,
  count           INTEGER     NOT NULL DEFAULT 1,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX diagnostics_by_installation ON diagnostics (installation_id, occurred_at DESC);
CREATE INDEX diagnostics_by_code ON diagnostics (code, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- Licences (§4). Metadata and the signed text — never the signing key.
-- ---------------------------------------------------------------------------

CREATE TABLE licences (
  id              TEXT        PRIMARY KEY,
  tenant_id       TEXT        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  installation_id TEXT        REFERENCES installations(id) ON DELETE SET NULL,
  licence_id      TEXT        NOT NULL,
  business_id     TEXT        NOT NULL,
  issued_at       TIMESTAMPTZ NOT NULL,
  valid_until     TIMESTAMPTZ NOT NULL,
  modules         JSONB       NOT NULL DEFAULT '[]'::jsonb,
  replacement_of  TEXT,
  -- The signed licence string. Not a secret: it grants nothing on any machine
  -- but the business it names, and it cannot be altered without breaking its
  -- own signature. Kept so it can be re-delivered or emailed after the fact.
  key_text        TEXT        NOT NULL,
  fingerprint     TEXT        NOT NULL DEFAULT '',
  delivery_state  TEXT        NOT NULL DEFAULT 'ISSUED',
  delivered_at    TIMESTAMPTZ,
  installed_at    TIMESTAMPTZ,
  failure_code    TEXT,
  -- A vendor-side revocation. It does NOT reach into the shop and switch
  -- anything off: the installed licence stays locally valid until its own
  -- expiry (§20). What it does is stop renewal and mark the fleet view.
  revoked_at      TIMESTAMPTZ,
  revoke_reason   TEXT        NOT NULL DEFAULT '',
  created_by      TEXT        NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX licences_by_tenant ON licences (tenant_id, issued_at DESC);
CREATE UNIQUE INDEX licences_licence_id ON licences (licence_id);

-- ---------------------------------------------------------------------------
-- Releases, deployments and known issues (§8, §9, §10, §11).
-- ---------------------------------------------------------------------------

CREATE TABLE releases (
  id                     TEXT        PRIMARY KEY,
  version                TEXT        NOT NULL,
  build_id               TEXT        NOT NULL,
  sha256                 TEXT        NOT NULL,
  size_bytes             BIGINT      NOT NULL,
  required_schema_version TEXT       NOT NULL,
  min_compatible_version TEXT        NOT NULL,
  migrations             JSONB       NOT NULL DEFAULT '[]'::jsonb,
  rollback_supported     BOOLEAN     NOT NULL DEFAULT FALSE,
  channel                TEXT        NOT NULL DEFAULT 'INTERNAL',
  notes                  TEXT        NOT NULL DEFAULT '',
  artifact_path          TEXT        NOT NULL,
  manifest               JSONB       NOT NULL,
  signature              TEXT        NOT NULL,
  published_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_by           TEXT        NOT NULL DEFAULT '',
  withdrawn_at           TIMESTAMPTZ
);
CREATE UNIQUE INDEX releases_version ON releases (version);

CREATE TABLE deployment_jobs (
  id            TEXT        PRIMARY KEY,
  release_id    TEXT        NOT NULL REFERENCES releases(id) ON DELETE RESTRICT,
  strategy      TEXT        NOT NULL,
  reason        TEXT        NOT NULL DEFAULT '',
  state         TEXT        NOT NULL DEFAULT 'QUEUED',
  -- §11: "a failed migration must stop further rollout". When one target fails
  -- a migration the job is halted here, and no queued target is dispatched
  -- until an operator clears it deliberately.
  halted_at     TIMESTAMPTZ,
  halt_reason   TEXT        NOT NULL DEFAULT '',
  created_by    TEXT        NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ
);

CREATE TABLE deployment_targets (
  id              TEXT        PRIMARY KEY,
  job_id          TEXT        NOT NULL REFERENCES deployment_jobs(id) ON DELETE CASCADE,
  installation_id TEXT        NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  state           TEXT        NOT NULL DEFAULT 'QUEUED',
  command_id      TEXT,
  -- Every stage transition the sidecar reported, in order, so a stalled update
  -- is visible as the stage it stalled in rather than as silence (§10).
  stages          JSONB       NOT NULL DEFAULT '[]'::jsonb,
  failure_code    TEXT,
  detail          TEXT        NOT NULL DEFAULT '',
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ
);
CREATE UNIQUE INDEX deployment_targets_once ON deployment_targets (job_id, installation_id);
CREATE INDEX deployment_targets_by_installation ON deployment_targets (installation_id);

CREATE TABLE known_issues (
  id                     TEXT        PRIMARY KEY,
  title                  TEXT        NOT NULL,
  description            TEXT        NOT NULL DEFAULT '',
  affected_from_version  TEXT        NOT NULL,
  affected_to_version    TEXT        NOT NULL,
  affected_schema_version TEXT       NOT NULL DEFAULT '',
  severity               TEXT        NOT NULL DEFAULT 'MEDIUM',
  workaround             TEXT        NOT NULL DEFAULT '',
  fixed_in_version       TEXT        NOT NULL DEFAULT '',
  status                 TEXT        NOT NULL DEFAULT 'OPEN',
  created_by             TEXT        NOT NULL DEFAULT '',
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Support sessions (§12, §15).
-- ---------------------------------------------------------------------------

CREATE TABLE support_sessions (
  id                  TEXT        PRIMARY KEY,
  tenant_id           TEXT        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  installation_id     TEXT        NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  operator_id         TEXT        NOT NULL REFERENCES operators(id) ON DELETE RESTRICT,
  operator_name       TEXT        NOT NULL,
  -- Mandatory, and inside the signed grant: an operator cannot open a session
  -- without saying why, and cannot change why afterwards (§12).
  reason              TEXT        NOT NULL,
  state               TEXT        NOT NULL DEFAULT 'REQUESTED',
  grant_payload       JSONB       NOT NULL,
  signature           TEXT        NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at          TIMESTAMPTZ NOT NULL,
  absolute_expires_at TIMESTAMPTZ NOT NULL,
  last_activity_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at           TIMESTAMPTZ,
  revoked_at          TIMESTAMPTZ,
  revoke_reason       TEXT        NOT NULL DEFAULT '',
  ip                  TEXT        NOT NULL DEFAULT ''
);
CREATE INDEX support_sessions_by_installation ON support_sessions (installation_id, created_at DESC);
CREATE INDEX support_sessions_active ON support_sessions (state) WHERE state = 'ACTIVE';

-- Every proxied request made inside a session. This is the record §15 asks for:
-- what was accessed, what was changed, and by whom. Append-only for the same
-- reason vendor_audit is.
CREATE TABLE support_actions (
  id            BIGSERIAL   PRIMARY KEY,
  session_id    TEXT        NOT NULL REFERENCES support_sessions(id) ON DELETE CASCADE,
  at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  method        TEXT        NOT NULL,
  -- Route pattern where one is known, otherwise the path with ids left in:
  -- inside a support session the document id IS the useful fact, and the
  -- customer is already identified by the session.
  path          TEXT        NOT NULL,
  http_status   INTEGER     NOT NULL DEFAULT 0,
  -- Set for mutations, so a corrected document can be found again afterwards.
  document_ref  TEXT        NOT NULL DEFAULT ''
);
CREATE INDEX support_actions_by_session ON support_actions (session_id, at);

CREATE TRIGGER support_actions_no_update
  BEFORE UPDATE OR DELETE ON support_actions
  FOR EACH ROW EXECUTE FUNCTION vendor_audit_is_append_only();

-- ---------------------------------------------------------------------------
-- Feature flags (§19).
-- ---------------------------------------------------------------------------

CREATE TABLE feature_flags (
  id              TEXT        PRIMARY KEY,
  -- NULL means every installation. A row for one installation overrides it.
  installation_id TEXT        REFERENCES installations(id) ON DELETE CASCADE,
  key             TEXT        NOT NULL,
  enabled         BOOLEAN     NOT NULL DEFAULT TRUE,
  reason          TEXT        NOT NULL DEFAULT '',
  updated_by      TEXT        NOT NULL DEFAULT '',
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX feature_flags_global ON feature_flags (key) WHERE installation_id IS NULL;
CREATE UNIQUE INDEX feature_flags_scoped ON feature_flags (installation_id, key) WHERE installation_id IS NOT NULL;
