-- Phase 8 — one row per physical unit the shop can point at (§5.19, D-18).
-- Forward-only and additive.
--
--   `inventory_units`  a serialised unit: where it came from, where it is now
--
-- **SherERP never invents a manufacturer serial** (§5.9, §5.19). Every value in
-- `serial_no` was read off the goods. The count accepted against a purchase
-- line may never exceed the quantity received, and a unit with no serial simply
-- does not exist as a row — which is what makes "6 still to enter" a fact the
-- purchase screen can state rather than a guess.
--
-- **A unit is not stock.** Quantity, valuation and costing stay entirely in
-- `inventory_lots` and `stock_movements`; this table only says which individual
-- item is which. INV-01…INV-05 never read it, and nothing here posts money.
--
-- **Uniqueness follows D-18: active serials.** The partial index lets a serial
-- reappear once its previous unit has been sold or written off, because that is
-- a manufacturer reusing a number years later, not a mistake being made twice.
CREATE TABLE inventory_units (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL REFERENCES tenants (id),
  product_id CHAR(26) NOT NULL REFERENCES products (id),
  serial_no TEXT NOT NULL,
  -- Where it came from. Null lot for a unit recorded against an opening stock
  -- figure rather than a bill.
  lot_id CHAR(26) REFERENCES inventory_lots (id),
  purchase_id CHAR(26) REFERENCES purchases (id),
  purchase_line_id CHAR(26) REFERENCES purchase_lines (id),
  supplier_party_id CHAR(26) REFERENCES parties (id),
  received_date DATE NOT NULL,
  expiry_date DATE,
  -- The supplier's cover on this unit, counted from the day it arrived
  -- (owner decision 2026-08-26). Null when the shop has no supplier warranty.
  supplier_warranty_months INTEGER,
  -- Filled in when it leaves. The customer's own cover is counted from
  -- `sold_date`, which is why both dates are kept rather than one.
  sale_id CHAR(26) REFERENCES sales (id),
  sale_line_id CHAR(26) REFERENCES sale_lines (id),
  customer_party_id CHAR(26) REFERENCES parties (id),
  sold_date DATE,
  customer_warranty_months INTEGER,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  created_by CHAR(26) NOT NULL, updated_by CHAR(26) NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT inventory_units_status_known
    CHECK (status IN ('IN_STOCK', 'SOLD', 'WITH_SUPPLIER', 'WRITTEN_OFF')),
  CONSTRAINT inventory_units_serial_not_blank CHECK (length(btrim(serial_no)) > 0),
  CONSTRAINT inventory_units_months_positive
    CHECK ((supplier_warranty_months IS NULL OR supplier_warranty_months > 0)
       AND (customer_warranty_months IS NULL OR customer_warranty_months > 0)),
  -- Sold means sold: the sale that took it and the day it went are both known.
  CONSTRAINT inventory_units_sold_has_sale
    CHECK (status <> 'SOLD' OR (sale_id IS NOT NULL AND sold_date IS NOT NULL))
);

CREATE UNIQUE INDEX inventory_units_active_serial_unique
  ON inventory_units (tenant_id, product_id, serial_no)
  WHERE status IN ('IN_STOCK', 'WITH_SUPPLIER');
CREATE INDEX inventory_units_serial_lookup_idx ON inventory_units (tenant_id, serial_no);
CREATE INDEX inventory_units_product_status_idx ON inventory_units (tenant_id, product_id, status, id);
CREATE INDEX inventory_units_purchase_line_idx ON inventory_units (tenant_id, purchase_line_id) WHERE purchase_line_id IS NOT NULL;
CREATE INDEX inventory_units_sale_idx ON inventory_units (tenant_id, sale_id) WHERE sale_id IS NOT NULL;

ALTER TABLE inventory_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_units FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON inventory_units USING (tenant_id = current_setting('app.tenant_id')::char(26));

-- ----------------------------------------------------------- warranty months
-- The shop fills one number in per product. The customer's cover runs from the
-- sale and the supplier's from the delivery (owner decision 2026-08-26), so one
-- product carries both and a purchase line may override the supplier's when
-- that delivery came on different terms.
ALTER TABLE products ADD COLUMN warranty_months INTEGER;
ALTER TABLE products ADD COLUMN supplier_warranty_months INTEGER;
ALTER TABLE products ADD CONSTRAINT products_warranty_months_positive
  CHECK ((warranty_months IS NULL OR warranty_months > 0)
     AND (supplier_warranty_months IS NULL OR supplier_warranty_months > 0));

ALTER TABLE purchase_lines ADD COLUMN supplier_warranty_months INTEGER;
ALTER TABLE purchase_lines ADD CONSTRAINT purchase_lines_warranty_months_positive
  CHECK (supplier_warranty_months IS NULL OR supplier_warranty_months > 0);
