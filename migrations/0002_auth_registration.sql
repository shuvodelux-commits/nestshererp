-- Phase 1, slice 1.1 — register a tenant via OTP, set username/password/PIN.
--
-- Forward-only and additive (SRS 3.10). Adds the credential columns a user needs
-- to exist as a login identity, the OTP table signup verification runs on, and
-- the pre-authentication index from an identifier to the account that owns it.

-- ------------------------------------------------------------------ users
-- `username` is set at signup, unique per tenant, and is a display/audit
-- identity — NOT a login identifier in V1 (§5.3). Login uses email, phone, PIN
-- or Google. Credentials are hashes; a plaintext password or PIN is never stored.
--
-- The three credential columns are NULLABLE because a user created by an
-- administrator (slice 1.3) exists before they have set a password. NOT NULL
-- would force a placeholder hash, and a placeholder hash is a password.
ALTER TABLE users
  ADD COLUMN username       TEXT NULL,
  ADD COLUMN phone          TEXT NULL,
  ADD COLUMN password_hash  TEXT NULL,
  ADD COLUMN pin_hash       TEXT NULL;

-- A user who signed up with a mobile number has no email, and vice versa: the
-- single signup field accepts one or the other (D-07). The existing
-- (tenant_id, email) unique constraint still holds — PostgreSQL treats NULLs as
-- distinct, so several phone-only users coexist under it.
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;

-- Uniqueness is per tenant and only over live rows: a soft-deleted user must not
-- reserve a username forever. Phone uniqueness for *users* is per tenant and
-- independent of the customer-phone rule in D-02 (§5.3).
CREATE UNIQUE INDEX users_tenant_username_unique
  ON users (tenant_id, username) WHERE deleted_at IS NULL AND username IS NOT NULL;
CREATE UNIQUE INDEX users_tenant_phone_unique
  ON users (tenant_id, phone) WHERE deleted_at IS NULL AND phone IS NOT NULL;

-- ------------------------------------------------------------- otp_codes
-- Class C in spirit: written once, then consumed or abandoned. It carries NO
-- tenant_id, because an OTP is verified before a tenant exists — which is also
-- why it has no RLS policy. Its protection is that no API ever reads it: the
-- code is stored hashed, never logged and never returned in a response body
-- (§5.3). `purpose` is constrained to SIGNUP; password recovery adds its own
-- value in slice 1.2, when that flow is actually built.
CREATE TABLE otp_codes (
  id             CHAR(26)    PRIMARY KEY,
  identifier     TEXT        NOT NULL,
  channel        TEXT        NOT NULL CHECK (channel IN ('EMAIL', 'PHONE')),
  purpose        TEXT        NOT NULL CHECK (purpose IN ('SIGNUP')),
  code_hash      TEXT        NOT NULL,
  attempt_count  INTEGER     NOT NULL DEFAULT 0,
  consumed_at    TIMESTAMPTZ NULL,
  created_at     TIMESTAMPTZ NOT NULL,
  created_by     CHAR(26)    NOT NULL
);

-- The verification path always wants the newest code for one identifier.
-- Expiry is derived from created_at by the domain, not stored, so the 5-minute
-- rule lives in one place and a row cannot disagree with it.
CREATE INDEX otp_codes_identifier_idx ON otp_codes (identifier, created_at DESC);

-- ------------------------------------------------------- user_identifiers
-- The pre-authentication index: which account owns a phone number or email.
--
-- It exists because `users` is RLS-scoped and a signup has no tenant context to
-- search it with, and because "one identifier, one account" must be enforced by
-- a unique constraint rather than by a read-then-write race. Slice 1.2's login
-- resolves its identifier through this same index.
--
-- Deliberately NOT RLS-scoped — it must be readable before authentication. It is
-- never exposed through an API: confirming that an identifier is taken is
-- exactly what an enumeration attack wants, so callers answer generically.
CREATE TABLE user_identifiers (
  id          CHAR(26)    PRIMARY KEY,
  identifier  TEXT        NOT NULL,
  channel     TEXT        NOT NULL CHECK (channel IN ('EMAIL', 'PHONE')),
  tenant_id   CHAR(26)    NOT NULL REFERENCES tenants (id),
  user_id     CHAR(26)    NOT NULL REFERENCES users (id),
  created_at  TIMESTAMPTZ NOT NULL,
  created_by  CHAR(26)    NOT NULL,
  CONSTRAINT user_identifiers_unique UNIQUE (identifier)
);

CREATE INDEX user_identifiers_tenant_idx ON user_identifiers (tenant_id);

-- ---------------------------------------------------------- audit_events
-- §5.3 requires every OTP send, failure and lockout to be audited (R-13, SIM
-- swap) — and those happen before a tenant exists. tenant_id becomes nullable
-- so a platform event has somewhere honest to live; every other write path
-- still always supplies it.
ALTER TABLE audit_events ALTER COLUMN tenant_id DROP NOT NULL;

-- The read side is unchanged: a NULL-tenant row belongs to no tenant and is
-- therefore visible to none of them, so the audit trail slice 1.6 builds cannot
-- leak platform events into a tenant's view. Only the write side is widened,
-- and only for rows that claim no tenant at all.
DROP POLICY tenant_isolation ON audit_events;
CREATE POLICY tenant_isolation ON audit_events
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::CHAR(26))
  WITH CHECK (
    tenant_id IS NULL
    OR tenant_id = current_setting('app.tenant_id', TRUE)::CHAR(26)
  );
