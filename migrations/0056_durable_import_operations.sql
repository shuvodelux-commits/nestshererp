-- MOD-003 C003-02 — permanent tenant-scoped import operation identity.
-- Additive/forward-only. NEVER remove historical source journals, stock, audit
-- or outbox rows. The 30-day idempotency cache remains a performance fast path.
--
-- Response is NULL only while a posting transaction is in flight; application
-- completes it before returning from that SAME transaction. An interruption
-- rolls back the claim, all imported rows, journal, audit and outbox together.
CREATE TABLE import_operations (
  id                   CHAR(26)    PRIMARY KEY,
  tenant_id            CHAR(26)    NOT NULL REFERENCES tenants (id),
  operation_id         CHAR(26)    NOT NULL,
  import_type          TEXT        NOT NULL
    CHECK (import_type IN ('PRODUCTS', 'CUSTOMERS', 'SUPPLIERS', 'OPENING_STOCK')),
  request_fingerprint  TEXT        NOT NULL
    CHECK (request_fingerprint ~ '^import:sha256:v1:[0-9a-f]{64}$'),
  response_json        JSONB       NULL
    CHECK (response_json IS NULL OR jsonb_typeof(response_json) = 'object'),
  created_at           TIMESTAMPTZ NOT NULL,
  created_by           CHAR(26)    NOT NULL,
  completed_at         TIMESTAMPTZ NULL,
  CONSTRAINT import_operations_tenant_operation_unique
    UNIQUE (tenant_id, operation_id),
  CONSTRAINT import_operations_completion_consistent CHECK (
    (response_json IS NULL AND completed_at IS NULL)
    OR (response_json IS NOT NULL AND completed_at IS NOT NULL)
  )
);

CREATE INDEX import_operations_tenant_created_idx
  ON import_operations (tenant_id, created_at DESC);

-- One-time safe migration of still-cached, versioned full-content import
-- fingerprints. These bytes were verified by the C003-01 commit path and
-- already have a committed response. Reuse the cache row's ULID as the new
-- table's independent primary key. Never backfill length-only historical
-- fingerprints or guess the identity of a record whose fast key was pruned.
--
-- This runs under the authorized migration principal before RLS is enabled
-- on this NEW table. The existing idempotency_keys RLS remains unchanged.
INSERT INTO import_operations (
  id, tenant_id, operation_id, import_type, request_fingerprint,
  response_json, created_at, created_by, completed_at
)
SELECT
  id, tenant_id, operation_id, response_json->>'type',
  request_fingerprint, response_json, created_at, created_by, created_at
FROM idempotency_keys
WHERE request_fingerprint ~ '^import:sha256:v1:[0-9a-f]{64}$'
  AND jsonb_typeof(response_json) = 'object'
  AND response_json->>'type' IN ('PRODUCTS', 'CUSTOMERS', 'SUPPLIERS', 'OPENING_STOCK')
  AND jsonb_typeof(response_json->'rows') = 'number'
  AND jsonb_typeof(response_json->'imported') = 'number';

ALTER TABLE import_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON import_operations
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::CHAR(26))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::CHAR(26));

-- The migration principal may differ from the runtime principal. Where the
-- standard runtime role already exists, grant only the operations used by the
-- import service. The RLS policy still binds every row to app.tenant_id.
-- Deployments using another named runtime role must apply their own explicit
-- least-privilege grants; no role is created or elevated by this migration.
DO $
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sher_app') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE import_operations TO sher_app;
  END IF;
END
$;

-- Never grant DELETE, TRUNCATE, BYPASSRLS or SUPERUSER for durable import
-- identities. Any authorized tenant/data-erasure process needs a distinct,
-- audited operator path; a routine import replay must not erase history.
