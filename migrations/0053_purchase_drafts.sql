-- MOD-008 DRAFT-P0 — durable unfinished purchase carts, never posted documents.
-- Additive tenant-owned metadata + opaque editor state; no stock, cash, AP or journal writes.
-- 30-day recoverability is enforced by the application against deleted_at.
CREATE TABLE purchase_drafts (
  id CHAR(26) PRIMARY KEY,
  tenant_id CHAR(26) NOT NULL REFERENCES tenants (id),
  label TEXT NOT NULL,
  supplier_name TEXT,
  item_count INTEGER NOT NULL,
  grand_total_minor BIGINT NOT NULL,
  cart JSONB NOT NULL,
  business_date DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  created_by CHAR(26) NOT NULL,
  updated_by CHAR(26) NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ,
  deleted_by CHAR(26),
  CONSTRAINT purchase_drafts_nonnegative CHECK (item_count >= 0 AND grand_total_minor >= 0),
  CONSTRAINT purchase_drafts_version_positive CHECK (version > 0),
  CONSTRAINT purchase_drafts_cart_object CHECK (jsonb_typeof(cart) = 'object'),
  CONSTRAINT purchase_drafts_deletion_pair CHECK (
    (deleted_at IS NULL AND deleted_by IS NULL) OR
    (deleted_at IS NOT NULL AND deleted_by IS NOT NULL)
  )
);

CREATE INDEX purchase_drafts_tenant_active_idx
  ON purchase_drafts (tenant_id, updated_at DESC, id DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX purchase_drafts_tenant_deleted_idx
  ON purchase_drafts (tenant_id, deleted_at DESC, id DESC)
  WHERE deleted_at IS NOT NULL;

ALTER TABLE purchase_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_drafts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON purchase_drafts
  USING (tenant_id = current_setting('app.tenant_id')::char(26))
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::char(26));
