-- Phase 12.1 — the offline foundation (§5.23, D-01, D-24, owner decisions
-- 2026-08-31). Forward-only and additive (§3.10).
--
--   `device_authorizations`  one row per registered **browser profile**
--
-- One table, and it holds no business data at all: it answers a single
-- question, "which machine may hold this shop's work while it is offline?".
-- Nothing here posts, and nothing here is written by a device — every row is
-- written by the server on behalf of a person who was signed in at the time.
--
-- **The identity is the browser profile, not the machine** (D-01). The row is
-- keyed by a public key whose private half never leaves the browser that made
-- it, so a second browser on the same PC, an incognito window, or a profile
-- whose site data was cleared is a *different* device with a different row.
-- That is the property that makes copying the offline storage files to another
-- profile useless: the files move, the authority does not.

CREATE TABLE device_authorizations (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL REFERENCES tenants (id),
  -- Base64url SPKI of the profile's public key. Long, because it is a key and
  -- not a name, and unique per tenant because it *is* the identity.
  public_key TEXT NOT NULL,
  name TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT '',
  -- The capability this row is about. One column with one value today, named
  -- rather than assumed, because §5.23's uniqueness rule is written against it
  -- and a second capability must not silently inherit the same single slot.
  capability TEXT NOT NULL DEFAULT 'OFFLINE_RW',
  status TEXT NOT NULL,
  requested_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  approved_by CHAR(26),
  revoked_at TIMESTAMPTZ,
  revoked_by CHAR(26),
  -- Never null on a force revoke: the owner's decision of 2026-08-31 makes the
  -- reason part of the act, and the CHECK below enforces it in the database so
  -- no later caller can quietly cut a machine off without saying why.
  revoke_reason TEXT,
  last_seen_at TIMESTAMPTZ,
  -- The last D-24 gate report this browser sent, so the owner's device list
  -- shows the same truth the machine is showing its own user. Advisory only:
  -- a failed gate stops that browser writing offline, and never revokes.
  gate_installed BOOLEAN,
  gate_persisted BOOLEAN,
  gate_available_bytes BIGINT,
  gate_reported_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  created_by CHAR(26) NOT NULL, updated_by CHAR(26) NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT device_authorizations_status_known
    CHECK (status IN ('REGISTERED', 'PENDING', 'ACTIVE', 'DRAINING', 'REVOKED', 'FORCE_REVOKED')),
  CONSTRAINT device_authorizations_capability_known
    CHECK (capability IN ('OFFLINE_RW')),
  CONSTRAINT device_authorizations_force_revoke_has_reason
    CHECK (status <> 'FORCE_REVOKED' OR (revoke_reason IS NOT NULL AND length(btrim(revoke_reason)) >= 3))
);

CREATE UNIQUE INDEX device_authorizations_one_key_per_tenant
  ON device_authorizations (tenant_id, public_key);

-- §5.23's rule, in the only place that can actually hold it: **one offline
-- writer per shop**. `DRAINING` is included with `ACTIVE` deliberately — a
-- machine on its way out has not finished sending up what it holds, and a
-- second writer alongside it is precisely the state D-01 exists to prevent.
-- Two managers approving two machines at the same moment do not race past this;
-- one of them gets a unique-violation and is told which machine already holds
-- it.
CREATE UNIQUE INDEX device_authorizations_one_writer_per_tenant
  ON device_authorizations (tenant_id, capability)
  WHERE status IN ('ACTIVE', 'DRAINING');

CREATE INDEX device_authorizations_by_tenant
  ON device_authorizations (tenant_id, created_at DESC);

ALTER TABLE device_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_authorizations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON device_authorizations USING (tenant_id = current_setting('app.tenant_id')::char(26));
