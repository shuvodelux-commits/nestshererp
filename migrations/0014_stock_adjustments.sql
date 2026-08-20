-- Products & Stock module: the posted stock correction (§5.10, §5.13).
--
-- §5.13's rule is that there is no direct silent quantity manipulation, so a
-- correction is a document like any other — Class B (§3.4) with its own number,
-- business date, entry mode and permanent `operation_id`. The movement, lot
-- effect and journal entry it produces live in the tables 0012/0013 created.

CREATE TABLE stock_adjustments (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL, adjustment_number TEXT NOT NULL,
  product_id CHAR(26) NOT NULL, location_id CHAR(26) NOT NULL,
  -- Signed as the user typed it, plus the resolved movement shape. Keeping the
  -- delta is what lets the Damaged report say "-5" without re-deriving a sign
  -- from a direction column and hoping the two still agree.
  qty_delta BIGINT NOT NULL, direction TEXT NOT NULL, qty BIGINT NOT NULL,
  value_minor BIGINT NOT NULL,
  reason TEXT NOT NULL, note TEXT,
  business_date DATE NOT NULL, entry_mode TEXT NOT NULL, status TEXT NOT NULL,
  operation_id CHAR(26) NOT NULL,
  -- R-C9 reserved columns. A stock correction has no price and therefore no
  -- tax, and these stay NULL in V1 (D-09 revised); they are here because §3.4
  -- and the YAGNI carve-out require every transaction table to carry them, so a
  -- later phase never has to migrate them onto posted history.
  tax_rate_id CHAR(26), tax_amount BIGINT, is_tax_inclusive BOOLEAN,
  pack_size BIGINT, device_prefix TEXT,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  created_by CHAR(26) NOT NULL, updated_by CHAR(26) NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ, deleted_by CHAR(26),
  -- Zero is refused in the domain and again here: a correction that moved
  -- nothing is either a bug or a half-filled form, and once posted it cannot be
  -- told apart from a real one worth nothing.
  CONSTRAINT stock_adjustments_delta_nonzero CHECK (qty_delta <> 0),
  CONSTRAINT stock_adjustments_qty_positive CHECK (qty > 0),
  CONSTRAINT stock_adjustments_qty_matches_delta CHECK (qty = abs(qty_delta)),
  CONSTRAINT stock_adjustments_direction_matches_delta
    CHECK ((direction = 'IN' AND qty_delta > 0) OR (direction = 'OUT' AND qty_delta < 0)),
  -- At least one poisha: a zero-value entry could not balance and INV-09 would
  -- fail. `stock_openings` refuses the same case for the same reason.
  CONSTRAINT stock_adjustments_value_positive CHECK (value_minor > 0),
  CONSTRAINT stock_adjustments_direction_check CHECK (direction IN ('IN','OUT')),
  -- Closed list: the Damaged & Written-off report groups by this column, and
  -- free text cannot be grouped.
  CONSTRAINT stock_adjustments_reason_check CHECK (reason IN ('DAMAGE','RECOUNT','THEFT_LOSS','OTHER')),
  CONSTRAINT stock_adjustments_note_for_other CHECK (reason <> 'OTHER' OR (note IS NOT NULL AND btrim(note) <> '')),
  CONSTRAINT stock_adjustments_status_check CHECK (status IN ('POSTED','VOIDED')),
  CONSTRAINT stock_adjustments_entry_mode_check CHECK (entry_mode IN ('ON_TIME','LATE_ENTRY','BACKDATED','CORRECTED')),
  -- C10: the permanent guarantee, not the 30-day fast path.
  CONSTRAINT stock_adjustments_operation_unique UNIQUE (tenant_id, operation_id),
  CONSTRAINT stock_adjustments_number_unique UNIQUE (tenant_id, adjustment_number)
);

-- The Damaged & Written-off report reads by date and reason; the product row
-- menu and the movement drill-down read by product.
CREATE INDEX stock_adjustments_tenant_date_idx ON stock_adjustments (tenant_id, business_date DESC, id DESC);
CREATE INDEX stock_adjustments_tenant_reason_date_idx ON stock_adjustments (tenant_id, reason, business_date DESC, id DESC);
CREATE INDEX stock_adjustments_tenant_product_date_idx ON stock_adjustments (tenant_id, product_id, business_date DESC, id DESC);

ALTER TABLE stock_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_adjustments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON stock_adjustments
  USING (tenant_id = current_setting('app.tenant_id')::char(26));
