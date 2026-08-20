-- Phase 3, path 3.2: owned opening stock, its lot/movement, and journal value.
CREATE TABLE inventory_locations (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL, name TEXT NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  created_by CHAR(26) NOT NULL, updated_by CHAR(26) NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ, deleted_by CHAR(26)
);
CREATE UNIQUE INDEX inventory_locations_default_unique ON inventory_locations (tenant_id) WHERE is_default AND deleted_at IS NULL;
CREATE INDEX inventory_locations_tenant_name_idx ON inventory_locations (tenant_id, name, id);

CREATE TABLE stock_openings (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL, opening_number TEXT NOT NULL,
  product_id CHAR(26) NOT NULL, location_id CHAR(26) NOT NULL, qty BIGINT NOT NULL,
  unit_cost BIGINT NOT NULL, value_minor BIGINT NOT NULL,
  business_date DATE NOT NULL, entry_mode TEXT NOT NULL, status TEXT NOT NULL,
  operation_id CHAR(26) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  created_by CHAR(26) NOT NULL, updated_by CHAR(26) NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ, deleted_by CHAR(26),
  CONSTRAINT stock_openings_qty_positive CHECK (qty > 0),
  CONSTRAINT stock_openings_cost_nonnegative CHECK (unit_cost >= 0),
  CONSTRAINT stock_openings_value_positive CHECK (value_minor > 0),
  CONSTRAINT stock_openings_status_check CHECK (status IN ('POSTED','VOIDED')),
  CONSTRAINT stock_openings_entry_mode_check CHECK (entry_mode IN ('ON_TIME','LATE_ENTRY','BACKDATED','CORRECTED')),
  CONSTRAINT stock_openings_operation_unique UNIQUE (tenant_id, operation_id),
  CONSTRAINT stock_openings_product_unique UNIQUE (tenant_id, product_id),
  CONSTRAINT stock_openings_number_unique UNIQUE (tenant_id, opening_number)
);
CREATE INDEX stock_openings_tenant_date_idx ON stock_openings (tenant_id, business_date DESC, id DESC);

CREATE TABLE inventory_lots (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL, product_id CHAR(26) NOT NULL,
  location_id CHAR(26) NOT NULL, owner_type TEXT NOT NULL, vendor_party_id CHAR(26), supplier_party_id CHAR(26),
  source_document_type TEXT NOT NULL, source_document_id CHAR(26) NOT NULL,
  qty_received BIGINT NOT NULL, qty_remaining BIGINT NOT NULL,
  purchase_unit_cost BIGINT NOT NULL, landed_cost_total BIGINT NOT NULL,
  actual_unit_cost BIGINT NOT NULL, business_date DATE NOT NULL, expiry_date DATE,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  created_by CHAR(26) NOT NULL, updated_by CHAR(26) NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ, deleted_by CHAR(26),
  CONSTRAINT inventory_lots_owner_check CHECK (owner_type IN ('OWNED','VENDOR')),
  CONSTRAINT inventory_lots_qty_check CHECK (qty_received > 0 AND qty_remaining >= 0 AND qty_remaining <= qty_received),
  CONSTRAINT inventory_lots_status_check CHECK (status IN ('OPEN','CLOSED'))
);
CREATE INDEX inventory_lots_tenant_product_location_idx ON inventory_lots (tenant_id, product_id, location_id, status, business_date, id);
CREATE INDEX inventory_lots_tenant_expiry_idx ON inventory_lots (tenant_id, expiry_date, product_id) WHERE status = 'OPEN';

CREATE TABLE stock_movements (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL, created_at TIMESTAMPTZ NOT NULL, created_by CHAR(26) NOT NULL,
  product_id CHAR(26) NOT NULL, location_id CHAR(26) NOT NULL, lot_id CHAR(26),
  qty BIGINT NOT NULL, direction TEXT NOT NULL, business_date DATE NOT NULL,
  source_document_type TEXT NOT NULL, source_document_id CHAR(26) NOT NULL,
  source_number TEXT NOT NULL, unit_cost BIGINT,
  CONSTRAINT stock_movements_qty_positive CHECK (qty > 0),
  CONSTRAINT stock_movements_direction_check CHECK (direction IN ('IN','OUT'))
);
CREATE INDEX stock_movements_tenant_product_location_date_idx ON stock_movements (tenant_id, product_id, location_id, business_date, created_at, id);
CREATE INDEX stock_movements_tenant_source_idx ON stock_movements (tenant_id, source_document_type, source_document_id);


CREATE TABLE journal_entries (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL, created_at TIMESTAMPTZ NOT NULL, created_by CHAR(26) NOT NULL,
  business_date DATE NOT NULL, source_document_type TEXT NOT NULL, source_document_id CHAR(26) NOT NULL,
  source_number TEXT NOT NULL, entry_mode TEXT NOT NULL,
  CONSTRAINT journal_entries_entry_mode_check CHECK (entry_mode IN ('ON_TIME','LATE_ENTRY','BACKDATED','CORRECTED')),
  CONSTRAINT journal_entries_source_unique UNIQUE (tenant_id, source_document_type, source_document_id)
);
CREATE INDEX journal_entries_tenant_date_idx ON journal_entries (tenant_id, business_date, created_at, id);

CREATE TABLE journal_lines (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL, created_at TIMESTAMPTZ NOT NULL, created_by CHAR(26) NOT NULL,
  journal_entry_id CHAR(26) NOT NULL, account_code TEXT NOT NULL, amount_minor BIGINT NOT NULL, party_id CHAR(26),
  CONSTRAINT journal_lines_nonzero CHECK (amount_minor <> 0)
);
CREATE INDEX journal_lines_tenant_entry_idx ON journal_lines (tenant_id, journal_entry_id, id);
CREATE INDEX journal_lines_tenant_account_idx ON journal_lines (tenant_id, account_code, created_at, id);

CREATE TABLE product_cost_state (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL, product_id CHAR(26) NOT NULL, location_id CHAR(26) NOT NULL,
  avg_unit_cost BIGINT NOT NULL, qty_on_hand BIGINT NOT NULL, last_recomputed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  created_by CHAR(26) NOT NULL, updated_by CHAR(26) NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ, deleted_by CHAR(26),
  CONSTRAINT product_cost_state_unique UNIQUE (tenant_id, product_id, location_id)
);
CREATE INDEX product_cost_state_tenant_location_idx ON product_cost_state (tenant_id, location_id, product_id);

ALTER TABLE inventory_locations ENABLE ROW LEVEL SECURITY; ALTER TABLE inventory_locations FORCE ROW LEVEL SECURITY;
ALTER TABLE stock_openings ENABLE ROW LEVEL SECURITY; ALTER TABLE stock_openings FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory_lots ENABLE ROW LEVEL SECURITY; ALTER TABLE inventory_lots FORCE ROW LEVEL SECURITY;
ALTER TABLE stock_movements ENABLE ROW LEVEL SECURITY; ALTER TABLE stock_movements FORCE ROW LEVEL SECURITY;
ALTER TABLE journal_entries ENABLE ROW LEVEL SECURITY; ALTER TABLE journal_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE journal_lines ENABLE ROW LEVEL SECURITY; ALTER TABLE journal_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE product_cost_state ENABLE ROW LEVEL SECURITY; ALTER TABLE product_cost_state FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON inventory_locations USING (tenant_id = current_setting('app.tenant_id')::char(26));
CREATE POLICY tenant_isolation ON stock_openings USING (tenant_id = current_setting('app.tenant_id')::char(26));
CREATE POLICY tenant_isolation ON inventory_lots USING (tenant_id = current_setting('app.tenant_id')::char(26));
CREATE POLICY tenant_isolation ON stock_movements USING (tenant_id = current_setting('app.tenant_id')::char(26));
CREATE POLICY tenant_isolation ON journal_entries USING (tenant_id = current_setting('app.tenant_id')::char(26));
CREATE POLICY tenant_isolation ON journal_lines USING (tenant_id = current_setting('app.tenant_id')::char(26));
CREATE POLICY tenant_isolation ON product_cost_state USING (tenant_id = current_setting('app.tenant_id')::char(26));
