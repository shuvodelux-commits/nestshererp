-- MOD-008 DRAFT-P5A: durable, non-posting Purchase Draft create idempotency.
-- Additive to 0053; legacy drafts remain readable without an operation ID.
-- These columns are immutable creation evidence, NOT the mutable draft payload.
ALTER TABLE purchase_drafts
  ADD COLUMN create_operation_id CHAR(26),
  ADD COLUMN create_fingerprint CHAR(64);

ALTER TABLE purchase_drafts
  ADD CONSTRAINT purchase_drafts_create_idempotency_pair CHECK (
    (create_operation_id IS NULL AND create_fingerprint IS NULL)
    OR (create_operation_id IS NOT NULL AND create_fingerprint IS NOT NULL)
  );

-- Permanent tenant-scoped uniqueness: safe even after 30-day recycle expiry.
-- PostgreSQL allows multiple NULLs so pre-existing rows require no backfill.
ALTER TABLE purchase_drafts
  ADD CONSTRAINT purchase_drafts_tenant_create_operation_unique
  UNIQUE (tenant_id, create_operation_id);
