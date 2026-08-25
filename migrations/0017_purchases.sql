-- Phase 5 — buying goods: the bill, what it put on the shelf, what it owes the
-- supplier, and paying that supplier off (§5.9, §5.11, §2.4, INV-01…INV-06).
-- Forward-only and additive (SRS 3.10).
--
-- Four tables:
--
--   `purchases`            one supplier bill, as a posted document
--   `purchase_lines`       what was on it, one row per product received
--   `supplier_payments`    money handed to a supplier afterwards
--   `payment_allocations`  which bills that money settled
--
-- **There is no `paid` or `outstanding` column that a payment updates.** A
-- purchase stores what was paid *on the bill itself* (`paid_minor`, the "Paid
-- now" box), and everything paid later is the sum of its allocations. What is
-- still owed is therefore always derived — `grand_total − paid_minor − Σ
-- allocations` — for the same reason a party has no balance column (see
-- `0015_party_openings.sql`): a stored outstanding figure is a second answer to
-- "what do I owe", and the first posting path that forgets to update it makes
-- the purchase list and the supplier's statement disagree.
--
-- The supplier's balance itself is not here at all. INV-06 makes it the sum of
-- their `AP` journal lines, which is what both the party list and the statement
-- already read.

-- ---------------------------------------------------------------- purchases
-- Class B (§3.4): a posted document — numbered, dated, period-guarded,
-- reversible, never edited in place.
CREATE TABLE purchases (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL REFERENCES tenants (id),
  purchase_number TEXT NOT NULL,
  supplier_party_id CHAR(26) NOT NULL REFERENCES parties (id),
  -- The number written on the supplier's own bill. Free text, and not unique:
  -- two suppliers number their pads independently, and a shop that is handed a
  -- duplicate must still be able to record what it was given.
  supplier_bill_ref TEXT,
  location_id CHAR(26) NOT NULL REFERENCES inventory_locations (id),
  -- Optional (owner decision 2026-08-24). §5.9 says every credit purchase has an
  -- explicit due date; the owner overrode that for V1 because most suppliers
  -- here give goods without naming a day, and a required field would be filled
  -- with a guess — which is worse than an honest blank. A bill with no due date
  -- is unpaid but never overdue.
  due_date DATE,
  -- The five figures of a bill, stored rather than recomputed on read, so the
  -- document keeps saying what it said when it was posted.
  items_total_minor BIGINT NOT NULL,
  discount_minor BIGINT NOT NULL,
  extra_cost_minor BIGINT NOT NULL,
  grand_total_minor BIGINT NOT NULL,
  -- What was handed over *with the bill*. Later money is a supplier payment.
  paid_minor BIGINT NOT NULL,
  paid_account_code TEXT,
  -- The day the cash left the drawer, when it did. Lets Daily Cash tie a
  -- purchase to the session it belongs to without re-deriving it from journal
  -- lines (§5.16.1).
  session_id CHAR(26) REFERENCES cash_sessions (id),
  notes TEXT,
  business_date DATE NOT NULL, entry_mode TEXT NOT NULL, status TEXT NOT NULL,
  operation_id CHAR(26) NOT NULL,
  -- R-C9 reserved columns (§3.4). D-09 removed VAT from V1; these stay NULL so
  -- a later phase never migrates them onto posted history.
  tax_rate_id CHAR(26), tax_amount BIGINT, is_tax_inclusive BOOLEAN,
  pack_size BIGINT, device_prefix TEXT,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  created_by CHAR(26) NOT NULL, updated_by CHAR(26) NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ, deleted_by CHAR(26),
  CONSTRAINT purchases_status_check CHECK (status IN ('POSTED','VOIDED')),
  CONSTRAINT purchases_entry_mode_check CHECK (entry_mode IN ('ON_TIME','LATE_ENTRY','BACKDATED','CORRECTED')),
  CONSTRAINT purchases_amounts_not_negative
    CHECK (items_total_minor >= 0 AND discount_minor >= 0 AND extra_cost_minor >= 0 AND paid_minor >= 0),
  -- The arithmetic of the bill, enforced where it cannot be argued with. If a
  -- future posting path ever adds these up differently it fails here rather
  -- than storing a total that is not the sum of its parts.
  CONSTRAINT purchases_total_arithmetic
    CHECK (grand_total_minor = items_total_minor - discount_minor + extra_cost_minor),
  -- A discount cannot be larger than the goods, and nobody can hand over more
  -- than the bill: either would post negative value somewhere.
  CONSTRAINT purchases_discount_within_items CHECK (discount_minor <= items_total_minor),
  CONSTRAINT purchases_paid_within_total CHECK (paid_minor <= grand_total_minor),
  -- Money that moved must say which account it came out of, and money that did
  -- not must not name one.
  CONSTRAINT purchases_paid_account_pair CHECK ((paid_minor > 0) = (paid_account_code IS NOT NULL)),
  CONSTRAINT purchases_operation_unique UNIQUE (tenant_id, operation_id),
  CONSTRAINT purchases_number_unique UNIQUE (tenant_id, purchase_number)
);

-- The list, newest first (§3.9 keyset paging — `OFFSET` is banned).
CREATE INDEX purchases_tenant_date_idx ON purchases (tenant_id, business_date DESC, id DESC);
-- "What do I still owe this supplier, oldest bill first" — the question the
-- payment allocation asks on every supplier payment.
CREATE INDEX purchases_tenant_supplier_idx
  ON purchases (tenant_id, supplier_party_id, business_date, id);
CREATE INDEX purchases_tenant_due_idx ON purchases (tenant_id, due_date) WHERE due_date IS NOT NULL;

-- ----------------------------------------------------------- purchase_lines
-- What was received, one row per product. Immutable like a journal line: a
-- posted bill is corrected by a further document (§2.5), never by rewriting a
-- line, so these carry `created_at`/`created_by` and no `updated_*` pair.
--
-- Each line names the lot and the stock movement it produced, so "where did
-- this batch come from" and "what did that cost" are one join apart rather
-- than a search through the movement trail.
CREATE TABLE purchase_lines (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL,
  purchase_id CHAR(26) NOT NULL REFERENCES purchases (id),
  line_no INTEGER NOT NULL,
  product_id CHAR(26) NOT NULL REFERENCES products (id),
  -- Quantity at scale 3, unit price in poisha — the same pair every other
  -- stock document uses.
  qty BIGINT NOT NULL,
  unit_price_minor BIGINT NOT NULL,
  line_total_minor BIGINT NOT NULL,
  -- This line's share of the bill discount and of transport/labour, split by
  -- line value with the §3.3 largest-remainder rule. Stored because they are
  -- what turned the rate on the bill into the cost on the shelf, and a
  -- shopkeeper asking "why is this costing me more than I paid" is asking
  -- exactly for these two numbers.
  discount_share_minor BIGINT NOT NULL,
  extra_cost_share_minor BIGINT NOT NULL,
  -- Scale 4, the same UnitCost every lot carries (DR13.8's `actual_unit_cost`).
  actual_unit_cost BIGINT NOT NULL,
  expiry_date DATE,
  lot_id CHAR(26) NOT NULL REFERENCES inventory_lots (id),
  movement_id CHAR(26) NOT NULL REFERENCES stock_movements (id),
  tax_rate_id CHAR(26), tax_amount BIGINT, is_tax_inclusive BOOLEAN,
  created_at TIMESTAMPTZ NOT NULL, created_by CHAR(26) NOT NULL,
  CONSTRAINT purchase_lines_qty_positive CHECK (qty > 0),
  CONSTRAINT purchase_lines_price_not_negative CHECK (unit_price_minor >= 0),
  CONSTRAINT purchase_lines_shares_not_negative
    CHECK (discount_share_minor >= 0 AND extra_cost_share_minor >= 0),
  CONSTRAINT purchase_lines_no_unique UNIQUE (purchase_id, line_no)
);

CREATE INDEX purchase_lines_tenant_purchase_idx ON purchase_lines (tenant_id, purchase_id, line_no);
CREATE INDEX purchase_lines_tenant_product_idx ON purchase_lines (tenant_id, product_id, id);

-- ------------------------------------------------------- supplier_payments
-- Class B: money handed to a supplier after the goods arrived (§5.9).
--
-- Deliberately **not** the same table as `cash_movements`. A cash movement has
-- two account sides and belongs to nobody; a supplier payment has one account
-- side and a party, settles named bills, and appears on that party's statement.
-- Folding them together would mean a nullable party, a nullable second side and
-- a `kind` column deciding which rules apply.
CREATE TABLE supplier_payments (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL REFERENCES tenants (id),
  payment_number TEXT NOT NULL,
  supplier_party_id CHAR(26) NOT NULL REFERENCES parties (id),
  -- A validated account code (§2.4): `CASH:01J…` or `BANK:01J…`.
  account_code TEXT NOT NULL,
  amount_minor BIGINT NOT NULL,
  note TEXT,
  session_id CHAR(26) REFERENCES cash_sessions (id),
  business_date DATE NOT NULL, entry_mode TEXT NOT NULL, status TEXT NOT NULL,
  operation_id CHAR(26) NOT NULL,
  tax_rate_id CHAR(26), tax_amount BIGINT, is_tax_inclusive BOOLEAN,
  pack_size BIGINT, device_prefix TEXT,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  created_by CHAR(26) NOT NULL, updated_by CHAR(26) NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ, deleted_by CHAR(26),
  CONSTRAINT supplier_payments_amount_positive CHECK (amount_minor > 0),
  CONSTRAINT supplier_payments_status_check CHECK (status IN ('POSTED','VOIDED')),
  CONSTRAINT supplier_payments_entry_mode_check CHECK (entry_mode IN ('ON_TIME','LATE_ENTRY','BACKDATED','CORRECTED')),
  CONSTRAINT supplier_payments_operation_unique UNIQUE (tenant_id, operation_id),
  CONSTRAINT supplier_payments_number_unique UNIQUE (tenant_id, payment_number)
);

CREATE INDEX supplier_payments_tenant_supplier_idx
  ON supplier_payments (tenant_id, supplier_party_id, business_date DESC, id DESC);
CREATE INDEX supplier_payments_tenant_date_idx ON supplier_payments (tenant_id, business_date DESC, id DESC);

-- ------------------------------------------------------ payment_allocations
-- Which bills a payment settled. §5.9: "Application changes allocation only —
-- it must not post cash twice or rewrite the original return/payment", which is
-- why this is a table of links rather than a column on either side.
CREATE TABLE payment_allocations (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL,
  payment_id CHAR(26) NOT NULL REFERENCES supplier_payments (id),
  purchase_id CHAR(26) NOT NULL REFERENCES purchases (id),
  amount_minor BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL, created_by CHAR(26) NOT NULL,
  CONSTRAINT payment_allocations_amount_positive CHECK (amount_minor > 0),
  -- One link per (payment, bill). A payment settling the same bill twice is a
  -- retry that slipped through, not two facts.
  CONSTRAINT payment_allocations_pair_unique UNIQUE (payment_id, purchase_id)
);

-- Outstanding per bill is `SUM(amount_minor)` over this, so it must be an index
-- lookup rather than a scan on every list page.
CREATE INDEX payment_allocations_tenant_purchase_idx
  ON payment_allocations (tenant_id, purchase_id, id);
CREATE INDEX payment_allocations_tenant_payment_idx
  ON payment_allocations (tenant_id, payment_id, id);

ALTER TABLE purchases ENABLE ROW LEVEL SECURITY; ALTER TABLE purchases FORCE ROW LEVEL SECURITY;
ALTER TABLE purchase_lines ENABLE ROW LEVEL SECURITY; ALTER TABLE purchase_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE supplier_payments ENABLE ROW LEVEL SECURITY; ALTER TABLE supplier_payments FORCE ROW LEVEL SECURITY;
ALTER TABLE payment_allocations ENABLE ROW LEVEL SECURITY; ALTER TABLE payment_allocations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON purchases USING (tenant_id = current_setting('app.tenant_id')::char(26));
CREATE POLICY tenant_isolation ON purchase_lines USING (tenant_id = current_setting('app.tenant_id')::char(26));
CREATE POLICY tenant_isolation ON supplier_payments USING (tenant_id = current_setting('app.tenant_id')::char(26));
CREATE POLICY tenant_isolation ON payment_allocations USING (tenant_id = current_setting('app.tenant_id')::char(26));
