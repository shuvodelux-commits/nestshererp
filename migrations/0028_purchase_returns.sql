-- Phase 7 — goods going back to the supplier (§5.11, §2.5, owner decisions
-- 2026-08-26). Forward-only and additive (SRS 3.10).
--
--   `purchase_returns`       one return, as a posted document against one bill
--   `purchase_return_lines`  what went back, one row per bill line it came from
--
-- **The mirror of 0027, with one asymmetry that matters.** A sales return puts
-- goods back at the cost that left; a purchase return takes goods off the shelf
-- at what the lot holds — `actual_unit_cost`, which includes that line's share
-- of the bill discount **and of the extra cost** (van fare, labour). The
-- supplier credits only what they billed. The difference is the transport the
-- shop already paid on goods it no longer owns, and it posts to
-- `STOCK_ADJUSTMENT`: it cannot stay in `INVENTORY` (the goods are gone, and
-- INV-05 compares that account against a valuation of what is left) and it
-- cannot be charged to the supplier, who never received it.
--
-- **What has already gone back is computed, never stored** — `Σ
-- purchase_return_lines.qty` per bill line — for the same reason 0027 gives.
-- The second cap is the lot itself: goods already sold cannot be sent back, and
-- `inventory_lots.qty_remaining` is what answers that.

-- --------------------------------------------------------- purchase_returns
-- Class B (§3.4): a posted document — numbered, dated, period-guarded.
CREATE TABLE purchase_returns (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL REFERENCES tenants (id),
  return_number TEXT NOT NULL,
  purchase_id CHAR(26) NOT NULL REFERENCES purchases (id),
  supplier_party_id CHAR(26) NOT NULL REFERENCES parties (id),
  supplier_name_snapshot TEXT NOT NULL,
  location_id CHAR(26) NOT NULL REFERENCES inventory_locations (id),
  reason TEXT NOT NULL,
  note TEXT,
  -- What the supplier credits: the billed value of the goods, after the bill
  -- discount and **without** the extra cost the shop paid to bring them in.
  return_value_minor BIGINT NOT NULL,
  -- What comes off the shelf: qty × the lot's own actual_unit_cost.
  inventory_minor BIGINT NOT NULL,
  -- Money actually taken back from the supplier, and what was left against
  -- their bills instead. They add up to return_value_minor.
  received_minor BIGINT NOT NULL,
  credit_minor BIGINT NOT NULL,
  -- How much of the credit cleared *this* bill, as opposed to sitting against
  -- the supplier generally. The bill's outstanding reads it.
  settled_minor BIGINT NOT NULL,
  receipt_account_code TEXT,
  business_date DATE NOT NULL, entry_mode TEXT NOT NULL,
  backdate_reason TEXT,
  status TEXT NOT NULL,
  operation_id CHAR(26) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  created_by CHAR(26) NOT NULL, updated_by CHAR(26) NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ, deleted_by CHAR(26),
  CONSTRAINT purchase_returns_status_known CHECK (status IN ('POSTED', 'VOIDED')),
  CONSTRAINT purchase_returns_reason_known
    CHECK (reason IN ('DAMAGED', 'WRONG_ITEM', 'CHANGED_MIND', 'EXTRA_QUANTITY', 'OTHER')),
  CONSTRAINT purchase_returns_amounts_not_negative
    CHECK (
      return_value_minor >= 0 AND inventory_minor >= 0
      AND received_minor >= 0 AND credit_minor >= 0
    ),
  CONSTRAINT purchase_returns_value_is_split
    CHECK (received_minor + credit_minor = return_value_minor),
  CONSTRAINT purchase_returns_settled_within_credit
    CHECK (settled_minor >= 0 AND settled_minor <= credit_minor),
  CONSTRAINT purchase_returns_receipt_has_account
    CHECK (received_minor = 0 OR receipt_account_code IS NOT NULL),
  CONSTRAINT purchase_returns_backdate_has_reason
    CHECK (entry_mode <> 'BACKDATED' OR backdate_reason IS NOT NULL)
);

CREATE UNIQUE INDEX purchase_returns_number_unique ON purchase_returns (tenant_id, return_number);
CREATE INDEX purchase_returns_purchase_idx ON purchase_returns (tenant_id, purchase_id);
CREATE INDEX purchase_returns_supplier_idx
  ON purchase_returns (tenant_id, supplier_party_id, business_date DESC);
CREATE INDEX purchase_returns_listing_idx ON purchase_returns (tenant_id, business_date DESC, id DESC);

ALTER TABLE purchase_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_returns FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON purchase_returns USING (tenant_id = current_setting('app.tenant_id')::char(26));

-- ---------------------------------------------------- purchase_return_lines
CREATE TABLE purchase_return_lines (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL REFERENCES tenants (id),
  return_id CHAR(26) NOT NULL REFERENCES purchase_returns (id),
  line_no INTEGER NOT NULL,
  purchase_line_id CHAR(26) NOT NULL REFERENCES purchase_lines (id),
  product_id CHAR(26) NOT NULL REFERENCES products (id),
  lot_id CHAR(26) NOT NULL REFERENCES inventory_lots (id),
  qty BIGINT NOT NULL,
  value_minor BIGINT NOT NULL,
  cost_minor BIGINT NOT NULL,
  movement_id CHAR(26) NOT NULL REFERENCES stock_movements (id),
  created_at TIMESTAMPTZ NOT NULL, created_by CHAR(26) NOT NULL,
  CONSTRAINT purchase_return_lines_qty_positive CHECK (qty > 0),
  CONSTRAINT purchase_return_lines_amounts_not_negative
    CHECK (value_minor >= 0 AND cost_minor >= 0)
);

CREATE INDEX purchase_return_lines_return_idx ON purchase_return_lines (tenant_id, return_id, line_no);
-- The quantity cap reads this: Σ qty per bill line, over posted returns.
CREATE INDEX purchase_return_lines_source_idx ON purchase_return_lines (tenant_id, purchase_line_id);

ALTER TABLE purchase_return_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_return_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON purchase_return_lines USING (tenant_id = current_setting('app.tenant_id')::char(26));
