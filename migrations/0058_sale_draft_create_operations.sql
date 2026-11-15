-- MOD-007 M7-02B2A (#176) — permanent, non-posting Sales Draft creation identity.
-- Additive after MOD-008 P6C migration 0057. The identity is retained after
-- a parked draft is hard-deleted, so an old retry must never recreate it.
-- This row holds no customer name, cart, payments, serials or other draft PII.
CREATE TABLE sale_draft_create_operations (
  tenant_id           CHAR(26)    NOT NULL REFERENCES tenants (id),
  operation_id        CHAR(26)    NOT NULL,
  fingerprint_version TEXT        NOT NULL
    CHECK (fingerprint_version = 'sale.draft.create/v1'),
  request_fingerprint CHAR(64)    NOT NULL
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  draft_id            CHAR(26)    NOT NULL,
  business_date       DATE        NOT NULL,
  saved_at            TIMESTAMPTZ NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL,
  created_by          CHAR(26)    NOT NULL,
  CONSTRAINT sale_draft_create_operations_tenant_operation_unique
    UNIQUE (tenant_id, operation_id)
);
-- Intentionally no FK to sale_drafts: legacy DELETE hard-deletes the cart
-- without deleting its idempotency tombstone. Tenant-wide data erasure is
-- a separately authorized administrative operation.
-- No UPDATE/DELETE RLS policy: routine tenant sessions can read/claim only.
ALTER TABLE sale_draft_create_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_draft_create_operations FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_select ON sale_draft_create_operations
  FOR SELECT USING (
    tenant_id = current_setting('app.tenant_id', TRUE)::CHAR(26)
  );
CREATE POLICY tenant_insert ON sale_draft_create_operations
  FOR INSERT WITH CHECK (
    tenant_id = current_setting('app.tenant_id', TRUE)::CHAR(26)
  );

-- Deployment-role provisioning must grant the runtime role SELECT + INSERT,
-- not UPDATE/DELETE/TRUNCATE. Do not assume a universal sher_app role exists.
-- Controlled, audited tenant erasure is a separate administrative process.
