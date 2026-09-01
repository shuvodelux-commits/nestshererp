-- Phase 8.3 — the Vendor Workspace (§5.6 M07, DR13.10, owner decisions
-- 2026-08-31). Forward-only and additive (§3.10).
--
--   `vendor_payments`               money handed to a vendor
--   `vendor_receipts`               an advance handed back by a vendor
--   `vendor_product_issues`         the shop's own goods lent to a vendor
--   `vendor_product_issue_lots`     which lots they left from, at what cost
--   `vendor_product_issue_returns`  the ones that came back
--
-- **Three of the workspace's six actions create no table here, deliberately.**
-- Receiving and returning consignment stock already have `vendor_stock_receipts`
-- and `vendor_stock_returns` (0034). Goods *charged* to a vendor are an
-- ordinary sale and live in `sales`, and money settling that receivable is an
-- ordinary customer receipt — writing a second row for either would be a second
-- tally of the same event, and the two would eventually disagree. The workspace
-- reads them back from the modules that own them.
--
-- **What is genuinely new is what nothing else could do.** `VENDOR_PAYABLE` is
-- created by the deemed purchase when a consignment item sells (DR13.10) and
-- the supplier payment flow cannot touch it — that flow debits `AP` and
-- allocates against purchase bills, of which a consignment payable has none.
-- Hence `vendor_payments`, whose allocation is the ledger itself: the balance
-- is the sum of the party's journal lines (INV-06), so there is nothing to
-- allocate and nothing to keep in step.

-- ------------------------------------------------------------ vendor_payments
-- Money out. `intent` is stored because the ledger cannot recover it: once
-- posted, a settlement and an advance are two rows on two accounts, and which
-- one the shopkeeper *meant* is the thing a later question asks about.
CREATE TABLE vendor_payments (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL REFERENCES tenants (id),
  payment_number TEXT NOT NULL,
  vendor_party_id CHAR(26) NOT NULL REFERENCES parties (id),
  intent TEXT NOT NULL,
  amount_minor BIGINT NOT NULL,
  -- `CASH:01J…` or `BANK:01J…`. Never a fixed account: money physically sits
  -- somewhere, and `VENDOR_PAYABLE` is not a place it sits.
  account_code TEXT NOT NULL,
  -- The drawer session this belongs to, when it was cash (§5.16).
  cash_session_id CHAR(26),
  journal_entry_id CHAR(26) NOT NULL REFERENCES journal_entries (id),
  note TEXT,
  business_date DATE NOT NULL,
  operation_id CHAR(26) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  created_by CHAR(26) NOT NULL, updated_by CHAR(26) NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT vendor_payments_amount_positive CHECK (amount_minor > 0),
  CONSTRAINT vendor_payments_intent_known CHECK (intent IN ('SETTLE_PAYABLE', 'ADVANCE'))
);

CREATE UNIQUE INDEX vendor_payments_number_unique ON vendor_payments (tenant_id, payment_number);
CREATE UNIQUE INDEX vendor_payments_operation_unique ON vendor_payments (tenant_id, operation_id);
CREATE INDEX vendor_payments_vendor_idx ON vendor_payments (tenant_id, vendor_party_id, business_date DESC, id DESC);

ALTER TABLE vendor_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_payments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON vendor_payments USING (tenant_id = current_setting('app.tenant_id')::char(26));

-- ------------------------------------------------------------ vendor_receipts
-- Money in that is **not** a customer receipt. Only one thing qualifies: a
-- vendor handing back an advance the shop had paid them. Money they owe for
-- goods charged to them is a receivable on `AR` like any other, and settling it
-- goes through the customer receipt service, which is why no row lands here.
CREATE TABLE vendor_receipts (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL REFERENCES tenants (id),
  receipt_number TEXT NOT NULL,
  vendor_party_id CHAR(26) NOT NULL REFERENCES parties (id),
  intent TEXT NOT NULL,
  amount_minor BIGINT NOT NULL,
  account_code TEXT NOT NULL,
  cash_session_id CHAR(26),
  journal_entry_id CHAR(26) NOT NULL REFERENCES journal_entries (id),
  note TEXT,
  business_date DATE NOT NULL,
  operation_id CHAR(26) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  created_by CHAR(26) NOT NULL, updated_by CHAR(26) NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT vendor_receipts_amount_positive CHECK (amount_minor > 0),
  CONSTRAINT vendor_receipts_intent_known CHECK (intent IN ('REFUND_ADVANCE'))
);

CREATE UNIQUE INDEX vendor_receipts_number_unique ON vendor_receipts (tenant_id, receipt_number);
CREATE UNIQUE INDEX vendor_receipts_operation_unique ON vendor_receipts (tenant_id, operation_id);
CREATE INDEX vendor_receipts_vendor_idx ON vendor_receipts (tenant_id, vendor_party_id, business_date DESC, id DESC);

ALTER TABLE vendor_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON vendor_receipts USING (tenant_id = current_setting('app.tenant_id')::char(26));

-- ------------------------------------------------------ vendor_product_issues
-- The shop's own goods, in a vendor's hands, still the shop's.
--
-- **No journal entry exists for a row in this table, and none should.** Nothing
-- has been bought, sold or owed: the goods have merely moved, the way they move
-- between two of the shop's own locations. They stay in `INVENTORY` and in the
-- valuation at the cost they left at, which is what `vendor_product_issue_lots`
-- keeps — so when they come back, the cost that returns is the cost that left,
-- and not today's average. That is the same rule a cancelled sales return
-- follows, for the same reason.
--
-- Goods *charged* to a vendor are absent from this table on purpose: they are a
-- sale, and `sales` already holds them with their lines, their COGS and their
-- receivable.
CREATE TABLE vendor_product_issues (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL REFERENCES tenants (id),
  issue_number TEXT NOT NULL,
  vendor_party_id CHAR(26) NOT NULL REFERENCES parties (id),
  product_id CHAR(26) NOT NULL REFERENCES products (id),
  location_id CHAR(26) NOT NULL REFERENCES inventory_locations (id),
  qty BIGINT NOT NULL,
  -- Kept in step with `vendor_product_issue_returns` inside the same
  -- transaction that writes one, so "what is still out" is one column and not
  -- a sum nobody can index.
  returned_qty BIGINT NOT NULL DEFAULT 0,
  -- What the goods cost the shop when they left, scale 0 (poisha), summed from
  -- the lots below. Not a price: nobody has agreed one.
  cost_minor BIGINT NOT NULL,
  movement_id CHAR(26) NOT NULL REFERENCES stock_movements (id),
  note TEXT,
  business_date DATE NOT NULL,
  operation_id CHAR(26) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  created_by CHAR(26) NOT NULL, updated_by CHAR(26) NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT vendor_product_issues_qty_positive CHECK (qty > 0),
  CONSTRAINT vendor_product_issues_returned_within CHECK (returned_qty >= 0 AND returned_qty <= qty)
);

CREATE UNIQUE INDEX vendor_product_issues_number_unique ON vendor_product_issues (tenant_id, issue_number);
CREATE UNIQUE INDEX vendor_product_issues_operation_unique ON vendor_product_issues (tenant_id, operation_id);
CREATE INDEX vendor_product_issues_vendor_idx ON vendor_product_issues (tenant_id, vendor_party_id, business_date DESC, id DESC);
CREATE INDEX vendor_product_issues_open_idx ON vendor_product_issues (tenant_id, vendor_party_id) WHERE returned_qty < qty;

ALTER TABLE vendor_product_issues ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_product_issues FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON vendor_product_issues USING (tenant_id = current_setting('app.tenant_id')::char(26));

-- -------------------------------------------------- vendor_product_issue_lots
-- Cost provenance, one row per lot the issue drew from. Without it a return
-- would have to guess a cost, and `INVENTORY` would come back holding a number
-- the shop never paid.
CREATE TABLE vendor_product_issue_lots (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL REFERENCES tenants (id),
  issue_id CHAR(26) NOT NULL REFERENCES vendor_product_issues (id),
  lot_id CHAR(26) NOT NULL REFERENCES inventory_lots (id),
  qty BIGINT NOT NULL,
  -- Scale 4, like every other unit cost.
  unit_cost BIGINT NOT NULL,
  -- What is still out from this lot specifically, so a partial return puts each
  -- part back where it came from.
  qty_outstanding BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL, created_by CHAR(26) NOT NULL,
  CONSTRAINT vendor_product_issue_lots_qty_positive CHECK (qty > 0),
  CONSTRAINT vendor_product_issue_lots_outstanding_within CHECK (qty_outstanding >= 0 AND qty_outstanding <= qty)
);

CREATE INDEX vendor_product_issue_lots_issue_idx ON vendor_product_issue_lots (tenant_id, issue_id, id);

ALTER TABLE vendor_product_issue_lots ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_product_issue_lots FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON vendor_product_issue_lots USING (tenant_id = current_setting('app.tenant_id')::char(26));

-- ----------------------------------------------- vendor_product_issue_returns
-- What came back. Stock only, like the issue it settles.
CREATE TABLE vendor_product_issue_returns (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL REFERENCES tenants (id),
  return_number TEXT NOT NULL,
  issue_id CHAR(26) NOT NULL REFERENCES vendor_product_issues (id),
  qty BIGINT NOT NULL,
  cost_minor BIGINT NOT NULL,
  movement_id CHAR(26) NOT NULL REFERENCES stock_movements (id),
  note TEXT,
  business_date DATE NOT NULL,
  operation_id CHAR(26) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  created_by CHAR(26) NOT NULL, updated_by CHAR(26) NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT vendor_product_issue_returns_qty_positive CHECK (qty > 0)
);

CREATE UNIQUE INDEX vendor_product_issue_returns_number_unique ON vendor_product_issue_returns (tenant_id, return_number);
CREATE UNIQUE INDEX vendor_product_issue_returns_operation_unique ON vendor_product_issue_returns (tenant_id, operation_id);
CREATE INDEX vendor_product_issue_returns_issue_idx ON vendor_product_issue_returns (tenant_id, issue_id, id);

ALTER TABLE vendor_product_issue_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_product_issue_returns FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON vendor_product_issue_returns USING (tenant_id = current_setting('app.tenant_id')::char(26));
