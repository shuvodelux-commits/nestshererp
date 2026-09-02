-- Phase 8.2 corrections — exact landed-cost shares, mixed sale origins,
-- consignment serial provenance and vendor product settlement.
-- Forward-only and additive. Historical rows are not rewritten.

-- ------------------------------------------------ landed-cost row detail
ALTER TABLE purchase_landed_costs
  ADD COLUMN description TEXT,
  ADD COLUMN paid_account_code TEXT,
  ADD COLUMN session_id CHAR(26) REFERENCES cash_sessions (id);

ALTER TABLE purchase_landed_costs
  DROP CONSTRAINT purchase_landed_costs_method_known,
  ADD CONSTRAINT purchase_landed_costs_method_known
    CHECK (method IN ('BY_VALUE', 'BY_QTY', 'MANUAL')),
  ADD CONSTRAINT purchase_landed_costs_other_description
    CHECK (category <> 'OTHER' OR length(btrim(description)) > 0) NOT VALID;

-- The exact poisha assigned to each purchase line. This is also populated for
-- automatic allocation methods so every cost has one durable explanation.
CREATE TABLE purchase_landed_cost_allocations (
  id CHAR(26) PRIMARY KEY,
  tenant_id CHAR(26) NOT NULL REFERENCES tenants (id),
  landed_cost_id CHAR(26) NOT NULL REFERENCES purchase_landed_costs (id),
  purchase_line_id CHAR(26) NOT NULL REFERENCES purchase_lines (id),
  amount_minor BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  created_by CHAR(26) NOT NULL,
  CONSTRAINT purchase_landed_cost_allocations_amount_nonnegative CHECK (amount_minor >= 0),
  CONSTRAINT purchase_landed_cost_allocations_line_unique
    UNIQUE (landed_cost_id, purchase_line_id)
);

CREATE INDEX purchase_landed_cost_allocations_cost_idx
  ON purchase_landed_cost_allocations (tenant_id, landed_cost_id, purchase_line_id);
ALTER TABLE purchase_landed_cost_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_landed_cost_allocations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON purchase_landed_cost_allocations
  USING (tenant_id = current_setting('app.tenant_id')::char(26));

-- ------------------------------------------- durable sale inventory origins
-- One sale line may have OWNED, VENDOR and NEGATIVE portions. Rows are
-- append-only audit facts: a correction creates a new sale and new rows.
CREATE TABLE sale_line_source_allocations (
  id CHAR(26) PRIMARY KEY,
  tenant_id CHAR(26) NOT NULL REFERENCES tenants (id),
  sale_id CHAR(26) NOT NULL REFERENCES sales (id),
  sale_line_id CHAR(26) NOT NULL REFERENCES sale_lines (id),
  source_type TEXT NOT NULL,
  qty BIGINT NOT NULL,
  owned_lot_id CHAR(26) REFERENCES inventory_lots (id),
  vendor_party_id CHAR(26) REFERENCES parties (id),
  vendor_stock_receipt_id CHAR(26) REFERENCES vendor_stock_receipts (id),
  vendor_lot_id CHAR(26) REFERENCES inventory_lots (id),
  inventory_unit_id CHAR(26) REFERENCES inventory_units (id),
  unit_cost_used BIGINT,
  created_at TIMESTAMPTZ NOT NULL,
  created_by CHAR(26) NOT NULL,
  CONSTRAINT sale_line_source_allocations_source_known
    CHECK (source_type IN ('OWNED', 'VENDOR', 'NEGATIVE')),
  CONSTRAINT sale_line_source_allocations_qty_positive CHECK (qty > 0),
  CONSTRAINT sale_line_source_allocations_cost_known
    CHECK (unit_cost_used IS NOT NULL AND unit_cost_used >= 0),
  CONSTRAINT sale_line_source_allocations_origin_shape CHECK (
    (source_type = 'OWNED' AND owned_lot_id IS NOT NULL AND vendor_party_id IS NULL AND vendor_stock_receipt_id IS NULL AND vendor_lot_id IS NULL)
    OR
    (source_type = 'VENDOR' AND vendor_party_id IS NOT NULL AND vendor_stock_receipt_id IS NOT NULL AND vendor_lot_id IS NOT NULL AND owned_lot_id IS NULL)
    OR
    (source_type = 'NEGATIVE' AND owned_lot_id IS NULL AND vendor_party_id IS NULL AND vendor_stock_receipt_id IS NULL AND vendor_lot_id IS NULL AND inventory_unit_id IS NULL)
  )
);

CREATE INDEX sale_line_source_allocations_sale_idx
  ON sale_line_source_allocations (tenant_id, sale_id, sale_line_id, id);
CREATE INDEX sale_line_source_allocations_vendor_idx
  ON sale_line_source_allocations (tenant_id, vendor_party_id, vendor_stock_receipt_id)
  WHERE source_type = 'VENDOR';
-- A returned serial can be sold again. Keep its complete history searchable,
-- but do not make the immutable historical allocation globally unique.
CREATE INDEX sale_line_source_allocations_serial_idx
  ON sale_line_source_allocations (tenant_id, inventory_unit_id)
  WHERE inventory_unit_id IS NOT NULL;
ALTER TABLE sale_line_source_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_line_source_allocations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sale_line_source_allocations
  USING (tenant_id = current_setting('app.tenant_id')::char(26));

-- A reversal is another immutable row pointing at the source fact it reverses.
-- The original allocation is never updated in place.
CREATE TABLE sale_source_allocation_reversals (
  id CHAR(26) PRIMARY KEY,
  tenant_id CHAR(26) NOT NULL REFERENCES tenants (id),
  source_allocation_id CHAR(26) NOT NULL REFERENCES sale_line_source_allocations (id),
  source_document_type TEXT NOT NULL,
  source_document_id CHAR(26) NOT NULL,
  qty BIGINT NOT NULL,
  serial_previous_status TEXT,
  serial_sale_id CHAR(26),
  serial_sale_line_id CHAR(26),
  serial_customer_party_id CHAR(26),
  serial_sold_date DATE,
  serial_customer_warranty_months INTEGER,
  created_at TIMESTAMPTZ NOT NULL,
  created_by CHAR(26) NOT NULL,
  CONSTRAINT sale_source_allocation_reversals_qty_positive CHECK (qty > 0),
  CONSTRAINT sale_source_allocation_reversals_unique
    UNIQUE (source_allocation_id, source_document_type, source_document_id)
);

CREATE INDEX sale_source_allocation_reversals_source_idx
  ON sale_source_allocation_reversals (tenant_id, source_allocation_id, id);
ALTER TABLE sale_source_allocation_reversals ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_source_allocation_reversals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sale_source_allocation_reversals
  USING (tenant_id = current_setting('app.tenant_id')::char(26));

-- -------------------------------------- vendor-owned serial exact provenance
ALTER TABLE inventory_units
  ADD COLUMN vendor_party_id CHAR(26) REFERENCES parties (id),
  ADD COLUMN vendor_stock_receipt_id CHAR(26) REFERENCES vendor_stock_receipts (id),
  ADD COLUMN vendor_lot_id CHAR(26) REFERENCES inventory_lots (id);

ALTER TABLE inventory_units
  ADD CONSTRAINT inventory_units_vendor_source_complete CHECK (
    (vendor_party_id IS NULL AND vendor_stock_receipt_id IS NULL AND vendor_lot_id IS NULL)
    OR
    (vendor_party_id IS NOT NULL AND vendor_stock_receipt_id IS NOT NULL AND vendor_lot_id IS NOT NULL)
  );

CREATE INDEX inventory_units_vendor_available_idx
  ON inventory_units (tenant_id, vendor_party_id, product_id, status, received_date, id)
  WHERE vendor_party_id IS NOT NULL;

-- ------------------------------------------ vendor product settlement audit
CREATE TABLE vendor_product_settlements (
  id CHAR(26) PRIMARY KEY,
  tenant_id CHAR(26) NOT NULL REFERENCES tenants (id),
  settlement_number TEXT NOT NULL,
  operation_id CHAR(26) NOT NULL,
  vendor_party_id CHAR(26) NOT NULL REFERENCES parties (id),
  purchase_id CHAR(26) NOT NULL REFERENCES purchases (id),
  gross_product_minor BIGINT NOT NULL,
  discount_minor BIGINT NOT NULL,
  net_product_minor BIGINT NOT NULL,
  landed_cost_minor BIGINT NOT NULL DEFAULT 0,
  receivable_before_minor BIGINT NOT NULL,
  receivable_after_minor BIGINT NOT NULL,
  journal_entry_id CHAR(26) NOT NULL REFERENCES journal_entries (id),
  business_date DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  created_by CHAR(26) NOT NULL,
  CONSTRAINT vendor_product_settlements_values_valid CHECK (
    gross_product_minor > 0 AND discount_minor >= 0
    AND net_product_minor = gross_product_minor - discount_minor
    AND net_product_minor > 0
    AND landed_cost_minor >= 0
    AND receivable_before_minor >= net_product_minor
    AND receivable_after_minor = receivable_before_minor - net_product_minor
  ),
  CONSTRAINT vendor_product_settlements_number_unique UNIQUE (tenant_id, settlement_number),
  CONSTRAINT vendor_product_settlements_operation_unique UNIQUE (tenant_id, operation_id),
  CONSTRAINT vendor_product_settlements_purchase_unique UNIQUE (tenant_id, purchase_id)
);

CREATE INDEX vendor_product_settlements_vendor_idx
  ON vendor_product_settlements (tenant_id, vendor_party_id, business_date DESC, id DESC);
ALTER TABLE vendor_product_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_product_settlements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON vendor_product_settlements
  USING (tenant_id = current_setting('app.tenant_id')::char(26));

CREATE TABLE vendor_receivable_settlement_allocations (
  id CHAR(26) PRIMARY KEY,
  tenant_id CHAR(26) NOT NULL REFERENCES tenants (id),
  settlement_id CHAR(26) NOT NULL REFERENCES vendor_product_settlements (id),
  sale_id CHAR(26) NOT NULL REFERENCES sales (id),
  amount_minor BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  created_by CHAR(26) NOT NULL,
  CONSTRAINT vendor_receivable_settlement_allocations_amount_positive CHECK (amount_minor > 0),
  CONSTRAINT vendor_receivable_settlement_allocations_sale_unique
    UNIQUE (settlement_id, sale_id)
);

CREATE INDEX vendor_receivable_settlement_allocations_settlement_idx
  ON vendor_receivable_settlement_allocations (tenant_id, settlement_id, sale_id);
ALTER TABLE vendor_receivable_settlement_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_receivable_settlement_allocations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON vendor_receivable_settlement_allocations
  USING (tenant_id = current_setting('app.tenant_id')::char(26));
