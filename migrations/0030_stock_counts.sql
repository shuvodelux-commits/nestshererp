-- Phase 7 — counting the shelf against the system (§5.13, owner decisions
-- 2026-08-26). Forward-only and additive (SRS 3.10).
--
--   `stock_counts`       one count sheet, posted as a single document
--   `stock_count_lines`  one row per product on it
--
-- **The count posts no stock of its own.** Each difference goes through
-- `ManageInventoryService.adjustStockWithin` — the same use case the Stock
-- Adjustment dialog calls — so a counted difference obeys exactly the costing,
-- lot and journal rules a typed adjustment does, and the Damaged & Written-off
-- report keeps working without knowing counts exist. `adjustment_id` on a line
-- is that posting; the count is the sheet those postings were made from.
--
-- §5.13 is explicit that a reconciliation must never write stock directly, and
-- INV-01…INV-05 would break the moment it did.
--
-- **The whole sheet is one transaction** (R-D5): a count that half-posted would
-- leave the shop believing it had counted things it had not.
--
-- `system_qty` is what the system said **when the line was counted**, kept so
-- the sheet can show what moved underneath it; the difference that actually
-- posts is recomputed against live stock at posting time (owner decision).

-- -------------------------------------------------------------- stock_counts
CREATE TABLE stock_counts (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL REFERENCES tenants (id),
  count_number TEXT NOT NULL,
  location_id CHAR(26) NOT NULL REFERENCES inventory_locations (id),
  -- What the sheet covered, for the record: all products, or one category or
  -- brand. Free text rather than a foreign key — it describes a filter that was
  -- applied once, not a live relationship.
  scope_label TEXT NOT NULL,
  note TEXT,
  line_count INTEGER NOT NULL,
  -- How many lines actually differed, and what those differences came to.
  difference_count INTEGER NOT NULL,
  shortage_value_minor BIGINT NOT NULL,
  surplus_value_minor BIGINT NOT NULL,
  business_date DATE NOT NULL, entry_mode TEXT NOT NULL,
  backdate_reason TEXT,
  status TEXT NOT NULL,
  operation_id CHAR(26) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  created_by CHAR(26) NOT NULL, updated_by CHAR(26) NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ, deleted_by CHAR(26),
  CONSTRAINT stock_counts_status_known CHECK (status IN ('POSTED', 'VOIDED')),
  CONSTRAINT stock_counts_counts_not_negative
    CHECK (line_count >= 0 AND difference_count >= 0),
  CONSTRAINT stock_counts_values_not_negative
    CHECK (shortage_value_minor >= 0 AND surplus_value_minor >= 0),
  CONSTRAINT stock_counts_backdate_has_reason
    CHECK (entry_mode <> 'BACKDATED' OR backdate_reason IS NOT NULL)
);

CREATE UNIQUE INDEX stock_counts_number_unique ON stock_counts (tenant_id, count_number);
CREATE UNIQUE INDEX stock_counts_operation_unique ON stock_counts (tenant_id, operation_id);
CREATE INDEX stock_counts_listing_idx ON stock_counts (tenant_id, business_date DESC, id DESC);

ALTER TABLE stock_counts ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_counts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON stock_counts USING (tenant_id = current_setting('app.tenant_id')::char(26));

-- --------------------------------------------------------- stock_count_lines
-- Every counted product, including the ones that agreed: a sheet that recorded
-- only the differences could not answer "was this product counted at all", and
-- that is the question a second count asks first.
CREATE TABLE stock_count_lines (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL REFERENCES tenants (id),
  count_id CHAR(26) NOT NULL REFERENCES stock_counts (id),
  line_no INTEGER NOT NULL,
  product_id CHAR(26) NOT NULL REFERENCES products (id),
  -- What the shelf held, what the system held when it was counted, and what the
  -- system held at posting time. The third is what the difference was computed
  -- from; the first two are what the shopkeeper looked at.
  counted_qty BIGINT NOT NULL,
  system_qty BIGINT NOT NULL,
  posted_system_qty BIGINT NOT NULL,
  qty_delta BIGINT NOT NULL,
  value_minor BIGINT NOT NULL,
  -- Null on a line that agreed: nothing posted, and nothing needed to.
  adjustment_id CHAR(26) REFERENCES stock_adjustments (id),
  created_at TIMESTAMPTZ NOT NULL, created_by CHAR(26) NOT NULL,
  CONSTRAINT stock_count_lines_counted_not_negative CHECK (counted_qty >= 0),
  -- A line with a difference posted an adjustment; a line without did not.
  CONSTRAINT stock_count_lines_delta_has_adjustment
    CHECK ((qty_delta = 0 AND adjustment_id IS NULL) OR (qty_delta <> 0 AND adjustment_id IS NOT NULL))
);

CREATE INDEX stock_count_lines_count_idx ON stock_count_lines (tenant_id, count_id, line_no);
CREATE INDEX stock_count_lines_product_idx ON stock_count_lines (tenant_id, product_id, created_at DESC);

ALTER TABLE stock_count_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_count_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON stock_count_lines USING (tenant_id = current_setting('app.tenant_id')::char(26));
