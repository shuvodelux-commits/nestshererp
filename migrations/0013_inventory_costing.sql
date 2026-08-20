-- Phase 3, path 3.3: lot drill-down and the append-only costing history named
-- by §5.11. Kept separate from 0012 because 0012 had already been applied to
-- the working databases; migrations are forward-only (§3.10).

ALTER TABLE inventory_lots ADD COLUMN source_number TEXT;
UPDATE inventory_lots lot
   SET source_number = opening.opening_number
  FROM stock_openings opening
 WHERE lot.tenant_id = opening.tenant_id
   AND lot.source_document_type = 'OPENING_STOCK'
   AND lot.source_document_id = opening.id;
ALTER TABLE inventory_lots ALTER COLUMN source_number SET NOT NULL;

CREATE INDEX inventory_lots_tenant_product_date_idx ON inventory_lots (tenant_id, product_id, business_date, id);
CREATE INDEX inventory_lots_tenant_product_expiry_idx ON inventory_lots (tenant_id, product_id, expiry_date, id);
CREATE INDEX inventory_lots_tenant_product_received_idx ON inventory_lots (tenant_id, product_id, qty_received, id);
CREATE INDEX inventory_lots_tenant_product_remaining_idx ON inventory_lots (tenant_id, product_id, qty_remaining, id);
CREATE INDEX inventory_lots_tenant_product_status_idx ON inventory_lots (tenant_id, product_id, status, id);

CREATE TABLE lot_consumptions (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL, created_at TIMESTAMPTZ NOT NULL, created_by CHAR(26) NOT NULL,
  movement_id CHAR(26) NOT NULL, lot_id CHAR(26) NOT NULL, qty BIGINT NOT NULL,
  unit_cost_used BIGINT NOT NULL, document_type TEXT NOT NULL, document_id CHAR(26) NOT NULL,
  business_date DATE NOT NULL, superseded_by CHAR(26),
  CONSTRAINT lot_consumptions_qty_positive CHECK (qty > 0),
  CONSTRAINT lot_consumptions_cost_nonnegative CHECK (unit_cost_used >= 0)
);
CREATE INDEX lot_consumptions_tenant_lot_idx ON lot_consumptions (tenant_id, lot_id, business_date, created_at, id);
CREATE INDEX lot_consumptions_tenant_movement_idx ON lot_consumptions (tenant_id, movement_id, id);

CREATE TABLE cost_adjustments (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL, created_at TIMESTAMPTZ NOT NULL, created_by CHAR(26) NOT NULL,
  product_id CHAR(26) NOT NULL, lot_id CHAR(26), reason TEXT NOT NULL,
  document_ref TEXT NOT NULL, amount_minor BIGINT NOT NULL, business_date DATE NOT NULL,
  CONSTRAINT cost_adjustments_reason_check CHECK (reason IN ('BACKDATE','EDIT','LANDED_COST','SYNC_TRUE_UP','NEGATIVE_STOCK_TRUE_UP')),
  CONSTRAINT cost_adjustments_amount_nonzero CHECK (amount_minor <> 0)
);
CREATE INDEX cost_adjustments_tenant_product_date_idx ON cost_adjustments (tenant_id, product_id, business_date, created_at, id);

ALTER TABLE lot_consumptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE lot_consumptions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON lot_consumptions
  USING (tenant_id = current_setting('app.tenant_id')::char(26));

ALTER TABLE cost_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_adjustments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cost_adjustments
  USING (tenant_id = current_setting('app.tenant_id')::char(26));
