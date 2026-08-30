-- Phase 8 — warranty claims, and stock the shop holds but does not own
-- (§5.19 M23, §5.6 M07, DR13.10, owner decisions 2026-08-26). Additive.
--
--   `warranty_claims`        one faulty item, from the counter to closed
--   `vendor_stock_receipts`  goods a vendor left to be sold on their behalf
--   `vendor_stock_returns`   the unsold ones going back
--
-- **Warranty implements no accounting of its own** (§5.19). A replacement given
-- from own stock is a stock issue with no revenue — `DR WARRANTY_EXPENSE /
-- CR INVENTORY` through the ordinary consume path — and a supplier settlement
-- credits that expense back. **No warranty receivable is ever created**: these
-- claims are often never recovered, and an asset row would quietly overstate
-- what the shop is worth. A pending claim is a status here, not a balance.
--
-- **Six statuses, not eleven** (owner simplification 2026-08-26). What §5.19
-- listed as separate statuses for each outcome is one SETTLED status plus a
-- settlement type, which is the same information with five fewer words for a
-- shopkeeper to learn.
--
-- **Vendor stock is one row per receipt, not a document with lines.** The owner
-- asked for a very small form: one vendor, one product, one quantity, one cost.
-- The lot it creates carries `owner_type='VENDOR'`, which is what keeps it out
-- of valuation and COGS until it sells (DR13.10).

-- ----------------------------------------------------------- warranty_claims
CREATE TABLE warranty_claims (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL REFERENCES tenants (id),
  claim_number TEXT NOT NULL,
  -- Who brought it in. Null for a walk-in whose details were only ever an
  -- invoice snapshot, which is exactly the case the phone/invoice search covers.
  customer_party_id CHAR(26) REFERENCES parties (id),
  customer_name TEXT NOT NULL,
  customer_phone TEXT,
  product_id CHAR(26) NOT NULL REFERENCES products (id),
  -- Set when the item was serialised and could be identified exactly. A ceiling
  -- fan with a paper card has a claim and no unit, which is why this is nullable.
  inventory_unit_id CHAR(26) REFERENCES inventory_units (id),
  serial_no TEXT,
  sale_id CHAR(26) REFERENCES sales (id),
  invoice_number TEXT,
  -- Which delivery it came in on, so the shop can tell before promising a
  -- repair whether the supplier still owes them one.
  purchase_id CHAR(26) REFERENCES purchases (id),
  supplier_party_id CHAR(26) REFERENCES parties (id),
  customer_warranty_end DATE,
  supplier_warranty_end DATE,
  complaint TEXT NOT NULL,
  received_date DATE NOT NULL,
  -- How it is being handled. A field, not a second workflow: courier and
  -- over-the-counter differ only in whether a courier name is worth recording.
  handling TEXT NOT NULL,
  courier_name TEXT,
  status TEXT NOT NULL,
  -- Filled in at the settle step. `REPLACED` and `REPAIRED` bring goods back,
  -- `ADJUSTED` brings money, `REJECTED` brings the original back and the
  -- expense stands.
  settlement_type TEXT,
  settlement_note TEXT,
  sent_to_supplier_date DATE,
  settled_date DATE,
  -- The unit handed to the customer out of own stock, and the entry that
  -- charged it to WARRANTY_EXPENSE. Both null until the shop replaces it.
  replacement_unit_id CHAR(26) REFERENCES inventory_units (id),
  replacement_journal_entry_id CHAR(26) REFERENCES journal_entries (id),
  recovery_journal_entry_id CHAR(26) REFERENCES journal_entries (id),
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  created_by CHAR(26) NOT NULL, updated_by CHAR(26) NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ, deleted_by CHAR(26),
  CONSTRAINT warranty_claims_status_known
    CHECK (status IN ('RECEIVED', 'CHECKING', 'SENT_TO_SUPPLIER', 'SETTLED', 'RETURNED_TO_CUSTOMER', 'CLOSED')),
  CONSTRAINT warranty_claims_handling_known CHECK (handling IN ('SHOP', 'COURIER')),
  CONSTRAINT warranty_claims_settlement_known
    CHECK (settlement_type IS NULL OR settlement_type IN ('REPLACED', 'REPAIRED', 'ADJUSTED', 'REJECTED')),
  CONSTRAINT warranty_claims_settled_has_type
    CHECK (status NOT IN ('SETTLED', 'RETURNED_TO_CUSTOMER', 'CLOSED') OR settlement_type IS NOT NULL),
  CONSTRAINT warranty_claims_complaint_not_blank CHECK (length(btrim(complaint)) > 0)
);

CREATE UNIQUE INDEX warranty_claims_number_unique ON warranty_claims (tenant_id, claim_number);
CREATE INDEX warranty_claims_listing_idx ON warranty_claims (tenant_id, received_date DESC, id DESC);
CREATE INDEX warranty_claims_status_idx ON warranty_claims (tenant_id, status, received_date DESC);
CREATE INDEX warranty_claims_unit_idx ON warranty_claims (tenant_id, inventory_unit_id) WHERE inventory_unit_id IS NOT NULL;
CREATE INDEX warranty_claims_supplier_idx ON warranty_claims (tenant_id, supplier_party_id, status) WHERE supplier_party_id IS NOT NULL;
CREATE INDEX warranty_claims_customer_idx ON warranty_claims (tenant_id, customer_party_id) WHERE customer_party_id IS NOT NULL;

ALTER TABLE warranty_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE warranty_claims FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON warranty_claims USING (tenant_id = current_setting('app.tenant_id')::char(26));

-- ---------------------------------------------------- vendor_stock_receipts
-- Goods on the shelf that belong to somebody else. The receipt posts no
-- journal entry at all: nothing has been bought and nobody is owed until one
-- of them sells, at which point the sale converts the lot to OWNED at vendor
-- cost and creates the vendor payable (DR13.10).
CREATE TABLE vendor_stock_receipts (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL REFERENCES tenants (id),
  receipt_number TEXT NOT NULL,
  vendor_party_id CHAR(26) NOT NULL REFERENCES parties (id),
  product_id CHAR(26) NOT NULL REFERENCES products (id),
  location_id CHAR(26) NOT NULL REFERENCES inventory_locations (id),
  qty BIGINT NOT NULL,
  -- Scale 4, like every other unit cost. What the vendor is owed per unit when
  -- one sells, and what the deemed purchase will be posted at.
  vendor_unit_cost BIGINT NOT NULL,
  lot_id CHAR(26) NOT NULL REFERENCES inventory_lots (id),
  movement_id CHAR(26) NOT NULL REFERENCES stock_movements (id),
  note TEXT,
  business_date DATE NOT NULL,
  operation_id CHAR(26) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  created_by CHAR(26) NOT NULL, updated_by CHAR(26) NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT vendor_stock_receipts_qty_positive CHECK (qty > 0),
  CONSTRAINT vendor_stock_receipts_cost_not_negative CHECK (vendor_unit_cost >= 0)
);

CREATE UNIQUE INDEX vendor_stock_receipts_number_unique ON vendor_stock_receipts (tenant_id, receipt_number);
CREATE UNIQUE INDEX vendor_stock_receipts_operation_unique ON vendor_stock_receipts (tenant_id, operation_id);
CREATE INDEX vendor_stock_receipts_vendor_idx ON vendor_stock_receipts (tenant_id, vendor_party_id, business_date DESC, id DESC);
CREATE INDEX vendor_stock_receipts_product_idx ON vendor_stock_receipts (tenant_id, product_id, id);

ALTER TABLE vendor_stock_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_stock_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON vendor_stock_receipts USING (tenant_id = current_setting('app.tenant_id')::char(26));

-- ----------------------------------------------------- vendor_stock_returns
-- Handing back what did not sell. Stock only, and no money moves — the shop
-- never bought these, so there is nothing to unpay and nothing to reverse.
CREATE TABLE vendor_stock_returns (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL REFERENCES tenants (id),
  return_number TEXT NOT NULL,
  receipt_id CHAR(26) NOT NULL REFERENCES vendor_stock_receipts (id),
  vendor_party_id CHAR(26) NOT NULL REFERENCES parties (id),
  product_id CHAR(26) NOT NULL REFERENCES products (id),
  qty BIGINT NOT NULL,
  movement_id CHAR(26) NOT NULL REFERENCES stock_movements (id),
  note TEXT,
  business_date DATE NOT NULL,
  operation_id CHAR(26) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  created_by CHAR(26) NOT NULL, updated_by CHAR(26) NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT vendor_stock_returns_qty_positive CHECK (qty > 0)
);

CREATE UNIQUE INDEX vendor_stock_returns_number_unique ON vendor_stock_returns (tenant_id, return_number);
CREATE UNIQUE INDEX vendor_stock_returns_operation_unique ON vendor_stock_returns (tenant_id, operation_id);
CREATE INDEX vendor_stock_returns_receipt_idx ON vendor_stock_returns (tenant_id, receipt_id, id);
CREATE INDEX vendor_stock_returns_vendor_idx ON vendor_stock_returns (tenant_id, vendor_party_id, business_date DESC, id DESC);

ALTER TABLE vendor_stock_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_stock_returns FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON vendor_stock_returns USING (tenant_id = current_setting('app.tenant_id')::char(26));
