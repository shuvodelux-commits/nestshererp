-- Phase 1, slice 1.2 — log in and log out.
--
-- Forward-only and additive (SRS 3.10).
--
-- §5.3: access tokens last 15 minutes; refresh tokens last 30 days and are
-- **rotating, revocable and server-stored**. Server-stored is what makes "log
-- out" mean something: without a row to revoke, logging out would only forget
-- the token in one browser while it stayed valid everywhere else.

-- ------------------------------------------------------------ refresh_tokens
-- One row per signed-in device session.
--
-- Deliberately NOT RLS-scoped, for the same reason as `user_identifiers`: a
-- refresh request arrives with no tenant context — the token is what reveals
-- which tenant it belongs to. The token is stored **hashed**, so a database
-- read cannot mint a session, and the unique index is on that hash.
--
-- Rotation is recorded rather than destructive: refreshing revokes the old row
-- and points `rotated_to` at its replacement. A revoked token presented again
-- is therefore detectable as replay rather than merely absent.
CREATE TABLE refresh_tokens (
  id          CHAR(26)    PRIMARY KEY,
  tenant_id   CHAR(26)    NOT NULL REFERENCES tenants (id),
  user_id     CHAR(26)    NOT NULL REFERENCES users (id),
  token_hash  TEXT        NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ NULL,
  rotated_to  CHAR(26)    NULL,
  created_at  TIMESTAMPTZ NOT NULL,
  created_by  CHAR(26)    NOT NULL,
  CONSTRAINT refresh_tokens_hash_unique UNIQUE (token_hash)
);

-- Revoking every session for a user is a single indexed statement — §5.3
-- requires changing a password to invalidate all other sessions.
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (tenant_id, user_id);
