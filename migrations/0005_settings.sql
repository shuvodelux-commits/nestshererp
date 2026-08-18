-- Phase 1, slice 1.5 — tenant settings and feature controls (§5.21).
--
-- Forward-only and additive (SRS 3.10). No column is dropped or renamed.
--
-- One table, one row per setting a tenant has actually changed. A tenant that
-- has never touched a setting has no rows at all and runs on the shipped
-- defaults in `SETTING_CATALOGUE`.
--
-- **Why not a column per setting, and why not one JSONB blob on `tenants`.**
-- A column per setting means a migration every time a module adds one, and
-- §5.21 keeps adding them through Phase 11. A JSONB blob is one row that every
-- setting fights over: two people changing two unrelated settings would collide
-- on the same optimistic lock, and the audit trail would record the whole blob
-- on both sides of every change instead of the one thing that moved.
--
-- A key/value row per changed setting gives each setting its own version, its
-- own audit before/after, and no migration when the next one is defined.

-- ------------------------------------------------------------------ settings
-- Class A (§3.4) — mutable configuration, the class the standard-columns table
-- names for settings explicitly. Not Class B: a setting carries no business
-- date, is not a document, and is never posted, voided or numbered.
CREATE TABLE settings (
  id          CHAR(26)    PRIMARY KEY,
  tenant_id   CHAR(26)    NOT NULL REFERENCES tenants (id),
  -- The catalogue key, e.g. `sale_costing_method`. Deliberately NOT constrained
  -- by a CHECK: the valid keys are the catalogue in core-contracts, every write
  -- is validated against it before it reaches here, and a CHECK would mean a
  -- migration every time a later module defines its own setting. The FK-shaped
  -- guarantee lives in the one place that can also say what the key *means*.
  setting_key TEXT        NOT NULL,
  -- Stored as text for every kind. `on`/`off`, `FIFO`, `BLOCK` — the catalogue
  -- says which values a key may hold, and the use case refuses anything else.
  -- No numeric or money setting exists in §5.21, so there is nothing here that
  -- integer-minor-unit rules would apply to (R-C2).
  value       TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL,
  created_by  CHAR(26)    NOT NULL,
  updated_by  CHAR(26)    NOT NULL,
  version     INTEGER     NOT NULL DEFAULT 1,
  deleted_at  TIMESTAMPTZ NULL,
  deleted_by  CHAR(26)    NULL
);

-- One live row per key per tenant. The unique constraint includes tenant_id
-- (SRS 3.2) so two tenants can each hold `sale_costing_method`, and a tenant
-- can never end up with two conflicting values for one key — which would make
-- "what is this shop's costing method" a question with two answers.
--
-- A setting is never soft-deleted (there is no "unset" action; changing one
-- writes the new value over the old), so the index needs no deleted_at
-- predicate and the constraint stays total.
ALTER TABLE settings
  ADD CONSTRAINT settings_tenant_key_unique UNIQUE (tenant_id, setting_key);

ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON settings
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::CHAR(26));
