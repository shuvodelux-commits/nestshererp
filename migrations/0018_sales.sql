-- Phase 6 — selling: the counter sale, what left the shelf, what the customer
-- paid, what they still owe, and how the invoice is presented and printed
-- (§5.7, §5.8, §2.4, DR13.10, INV-01…INV-06).
-- Forward-only and additive (SRS 3.10).
--
--   `sales`                    one posted invoice
--   `sale_lines`               what was sold, one row per cart line
--   `sale_payments`            how it was paid, one row per method/account
--   `customer_receipts`        money received from a customer afterwards
--   `receipt_allocations`      which invoices that money settled
--   `invoice_presentation`     display-only overrides for the printed invoice
--   `invoice_line_presentation`  display-only product labels on one invoice
--   `invoice_settings`         per-tenant template, language and paper setup
--   `quotations` / `sales_orders` (+ lines)  non-posting wholesale drafts
--   `product_group_prices`     one selling price per customer group
--
-- **There is no `paid` or `outstanding` column that a receipt updates.** A sale
-- stores what was taken *at the counter* (`sale_payments`), and everything
-- received later is the sum of its allocations. What is still owed is therefore
-- always derived — `grand_total − Σ sale_payments − Σ allocations` — for the
-- same reason a purchase has none (0017) and a party has no balance column
-- (0015): a stored figure is a second answer to "what do they owe me", and the
-- first posting path that forgets to update it makes the list and the
-- statement disagree.

-- -------------------------------------------------------------------- sales
-- Class B (§3.4): a posted document — numbered, dated, period-guarded,
-- reversible, never edited in place.
CREATE TABLE sales (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL REFERENCES tenants (id),
  sale_number TEXT NOT NULL,
  -- Always set: the registered customer, or the tenant's system walk-in party
  -- for a fully paid guest sale (§5.8). Never null, so every journal line has
  -- a party the ledger can name.
  party_id CHAR(26) NOT NULL REFERENCES parties (id),
  -- The customer as they appeared at posting time (§5.8). Document facts:
  -- renaming the party later never rewrites a printed invoice.
  customer_name_snapshot TEXT NOT NULL,
  customer_phone_snapshot TEXT,
  customer_guardian_name_snapshot TEXT,
  customer_address_snapshot TEXT,
  location_id CHAR(26) NOT NULL REFERENCES inventory_locations (id),
  -- Optional, exactly like a purchase's (owner decision 2026-08-25): most
  -- counter credit is given without naming a day. A sale with no due date is
  -- unpaid but never overdue.
  due_date DATE,
  items_total_minor BIGINT NOT NULL,
  -- The bill-level discount, spread over the lines by value (§3.3). Line-level
  -- discount lives on the line and is already inside `items_total_minor`.
  discount_minor BIGINT NOT NULL,
  grand_total_minor BIGINT NOT NULL,
  -- What the goods cost the shop, from the costing service (DR13.2) — the
  -- figure posted to COGS. Stored because a posted document must keep saying
  -- what it said, and re-deriving it later would re-cost history (R-01).
  cogs_minor BIGINT NOT NULL,
  -- Taken at the counter: Σ `sale_payments`. Stored so the list does not join
  -- for the commonest figure; the CHECK below and one insert path keep it true.
  paid_minor BIGINT NOT NULL,
  -- The open day the drawer took cash on, when it did (§5.16.1).
  session_id CHAR(26) REFERENCES cash_sessions (id),
  notes TEXT,
  business_date DATE NOT NULL, entry_mode TEXT NOT NULL, status TEXT NOT NULL,
  operation_id CHAR(26) NOT NULL,
  -- R-C9 reserved columns (§3.4). D-09 removed VAT from V1; these stay NULL.
  tax_rate_id CHAR(26), tax_amount BIGINT, is_tax_inclusive BOOLEAN,
  pack_size BIGINT, device_prefix TEXT,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  created_by CHAR(26) NOT NULL, updated_by CHAR(26) NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ, deleted_by CHAR(26),
  CONSTRAINT sales_status_check CHECK (status IN ('POSTED','VOIDED')),
  CONSTRAINT sales_entry_mode_check CHECK (entry_mode IN ('ON_TIME','LATE_ENTRY','BACKDATED','CORRECTED')),
  CONSTRAINT sales_amounts_not_negative
    CHECK (items_total_minor >= 0 AND discount_minor >= 0 AND paid_minor >= 0 AND cogs_minor >= 0),
  CONSTRAINT sales_total_arithmetic
    CHECK (grand_total_minor = items_total_minor - discount_minor),
  CONSTRAINT sales_discount_within_items CHECK (discount_minor <= items_total_minor),
  -- Overpayment is held as a customer advance, so paid may exceed the bill —
  -- but only for a named customer, which the service enforces (walk-in cannot
  -- hold a balance). Nothing may be paid on a sale worth nothing.
  CONSTRAINT sales_has_value CHECK (grand_total_minor > 0),
  CONSTRAINT sales_operation_unique UNIQUE (tenant_id, operation_id),
  CONSTRAINT sales_number_unique UNIQUE (tenant_id, sale_number)
);

-- The list and the Daybook, newest first (§3.9 keyset paging — `OFFSET` banned).
CREATE INDEX sales_tenant_date_idx ON sales (tenant_id, business_date DESC, id DESC);
-- "What does this customer still owe me, oldest invoice first" — the question
-- every receipt allocation asks.
CREATE INDEX sales_tenant_party_idx ON sales (tenant_id, party_id, business_date, id);
CREATE INDEX sales_tenant_due_idx ON sales (tenant_id, due_date) WHERE due_date IS NOT NULL;
-- Find an invoice by the phone written on it — registered and guest alike
-- (§5.8). Partial, because most counter sales carry no phone at all.
CREATE INDEX sales_tenant_phone_idx
  ON sales (tenant_id, customer_phone_snapshot, id DESC) WHERE customer_phone_snapshot IS NOT NULL;
-- Find an invoice by its number, typed into the same box as the phone.
CREATE INDEX sales_tenant_number_idx ON sales (tenant_id, sale_number);

-- --------------------------------------------------------------- sale_lines
-- Immutable like a journal line: a posted invoice is corrected by a further
-- document (§2.5), never by rewriting a line.
CREATE TABLE sale_lines (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL,
  sale_id CHAR(26) NOT NULL REFERENCES sales (id),
  line_no INTEGER NOT NULL,
  product_id CHAR(26) NOT NULL REFERENCES products (id),
  qty BIGINT NOT NULL,
  unit_price_minor BIGINT NOT NULL,
  -- What the shopkeeper knocked off this one line, before the bill discount.
  line_discount_minor BIGINT NOT NULL,
  line_total_minor BIGINT NOT NULL,
  -- This line's share of the bill discount, split by line value with §3.3's
  -- largest-remainder rule — so each product's real margin stays correct.
  discount_share_minor BIGINT NOT NULL,
  net_amount_minor BIGINT NOT NULL,
  -- What this line cost the shop: FIFO lot consumptions or qty × moving
  -- average (DR13.2), or the stated vendor cost for a consignment line.
  cost_minor BIGINT NOT NULL,
  -- §5.7 source selection. `VENDOR` posts DR13.10's deemed purchase and keeps
  -- the goods out of owned valuation (INV-04).
  source TEXT NOT NULL,
  vendor_party_id CHAR(26) REFERENCES parties (id),
  vendor_unit_cost BIGINT,
  -- What this line did to stock. A vendor-sourced line creates the deemed lot
  -- it immediately consumes, so both ids are present on every line.
  movement_id CHAR(26) NOT NULL REFERENCES stock_movements (id),
  vendor_lot_id CHAR(26) REFERENCES inventory_lots (id),
  -- True when the line was sold below what the shop had on hand and the
  -- negative-stock policy allowed it (D-19 provisional cost).
  is_provisional_cost BOOLEAN NOT NULL DEFAULT FALSE,
  tax_rate_id CHAR(26), tax_amount BIGINT, is_tax_inclusive BOOLEAN,
  created_at TIMESTAMPTZ NOT NULL, created_by CHAR(26) NOT NULL,
  CONSTRAINT sale_lines_qty_positive CHECK (qty > 0),
  CONSTRAINT sale_lines_price_not_negative CHECK (unit_price_minor >= 0),
  CONSTRAINT sale_lines_discounts_not_negative
    CHECK (line_discount_minor >= 0 AND discount_share_minor >= 0),
  CONSTRAINT sale_lines_source_check CHECK (source IN ('OWN_STOCK','VENDOR_CONSIGNMENT')),
  -- A vendor line names its vendor and its cost; an own-stock line names
  -- neither. Either way there is exactly one story about where goods came from.
  CONSTRAINT sale_lines_vendor_pair CHECK (
    (source = 'VENDOR_CONSIGNMENT') = (vendor_party_id IS NOT NULL AND vendor_unit_cost IS NOT NULL)
  ),
  CONSTRAINT sale_lines_no_unique UNIQUE (sale_id, line_no)
);

CREATE INDEX sale_lines_tenant_sale_idx ON sale_lines (tenant_id, sale_id, line_no);
CREATE INDEX sale_lines_tenant_product_idx ON sale_lines (tenant_id, product_id, id);

-- ------------------------------------------------------------ sale_payments
-- One row per method the customer paid with (owner decision 2026-08-25): a
-- split of ৳2,000 cash + ৳3,000 bKash is two rows, two accounts and two
-- journal lines — never one "method" column that loses which account moved.
CREATE TABLE sale_payments (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL,
  sale_id CHAR(26) NOT NULL REFERENCES sales (id),
  line_no INTEGER NOT NULL,
  -- A validated account code (§2.4): `CASH:01J…` or `BANK:01J…`.
  account_code TEXT NOT NULL,
  amount_minor BIGINT NOT NULL,
  -- Set only when this row touched the drawer, so Daily Cash can tie the
  -- takings to the day that must count them.
  session_id CHAR(26) REFERENCES cash_sessions (id),
  created_at TIMESTAMPTZ NOT NULL, created_by CHAR(26) NOT NULL,
  CONSTRAINT sale_payments_amount_positive CHECK (amount_minor > 0),
  CONSTRAINT sale_payments_no_unique UNIQUE (sale_id, line_no)
);

CREATE INDEX sale_payments_tenant_sale_idx ON sale_payments (tenant_id, sale_id, line_no);

-- ------------------------------------------------------- customer_receipts
-- Class B: money received from a customer after the sale (§5.8) — the mirror
-- of `supplier_payments`, and deliberately a separate table for the same
-- reason: one account side, one party, and it belongs on their statement.
CREATE TABLE customer_receipts (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL REFERENCES tenants (id),
  receipt_number TEXT NOT NULL,
  customer_party_id CHAR(26) NOT NULL REFERENCES parties (id),
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
  CONSTRAINT customer_receipts_amount_positive CHECK (amount_minor > 0),
  CONSTRAINT customer_receipts_status_check CHECK (status IN ('POSTED','VOIDED')),
  CONSTRAINT customer_receipts_entry_mode_check CHECK (entry_mode IN ('ON_TIME','LATE_ENTRY','BACKDATED','CORRECTED')),
  CONSTRAINT customer_receipts_operation_unique UNIQUE (tenant_id, operation_id),
  CONSTRAINT customer_receipts_number_unique UNIQUE (tenant_id, receipt_number)
);

CREATE INDEX customer_receipts_tenant_party_idx
  ON customer_receipts (tenant_id, customer_party_id, business_date DESC, id DESC);
CREATE INDEX customer_receipts_tenant_date_idx
  ON customer_receipts (tenant_id, business_date DESC, id DESC);

-- ------------------------------------------------------ receipt_allocations
-- Which invoices a receipt settled. §5.9's "application changes allocation
-- only" is why this is a table of links rather than a column on either side.
CREATE TABLE receipt_allocations (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL,
  receipt_id CHAR(26) NOT NULL REFERENCES customer_receipts (id),
  sale_id CHAR(26) NOT NULL REFERENCES sales (id),
  amount_minor BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL, created_by CHAR(26) NOT NULL,
  CONSTRAINT receipt_allocations_amount_positive CHECK (amount_minor > 0),
  CONSTRAINT receipt_allocations_pair_unique UNIQUE (receipt_id, sale_id)
);

CREATE INDEX receipt_allocations_tenant_sale_idx ON receipt_allocations (tenant_id, sale_id, id);
CREATE INDEX receipt_allocations_tenant_receipt_idx ON receipt_allocations (tenant_id, receipt_id, id);

-- ----------------------------------------------------- invoice_presentation
-- §5.8's cosmetic presentation overrides: what the *printed* invoice says.
--
-- One row per invoice, edited any number of times, audited through the normal
-- audit log. Every column here is display-only by construction — there is
-- deliberately no quantity, price, discount, payment or party column, so a
-- presentation edit **cannot** reach an accounting fact even by mistake.
CREATE TABLE invoice_presentation (
  sale_id CHAR(26) PRIMARY KEY REFERENCES sales (id),
  tenant_id CHAR(26) NOT NULL REFERENCES tenants (id),
  customer_display_name TEXT,
  customer_phone TEXT,
  customer_address TEXT,
  delivery_address TEXT,
  courier_name TEXT,
  delivery_instruction TEXT,
  payment_note TEXT,
  custom_label_1 TEXT, custom_value_1 TEXT,
  custom_label_2 TEXT, custom_value_2 TEXT,
  custom_label_3 TEXT, custom_value_3 TEXT,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  created_by CHAR(26) NOT NULL, updated_by CHAR(26) NOT NULL, version INTEGER NOT NULL DEFAULT 1
);

-- The product label on one invoice — "6\" PVC Pipe" printed as "PVC Pipe 6
-- inch" for a customer who asked for it. Never touches the product master.
CREATE TABLE invoice_line_presentation (
  sale_line_id CHAR(26) PRIMARY KEY REFERENCES sale_lines (id),
  tenant_id CHAR(26) NOT NULL REFERENCES tenants (id),
  sale_id CHAR(26) NOT NULL REFERENCES sales (id),
  display_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  created_by CHAR(26) NOT NULL, updated_by CHAR(26) NOT NULL, version INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX invoice_line_presentation_tenant_sale_idx
  ON invoice_line_presentation (tenant_id, sale_id);

-- --------------------------------------------------------- invoice_settings
-- §5.8's invoice design settings: one row per tenant, read by the same
-- renderer that draws the preview, the A4 sheet, the 80mm receipt and the
-- shared JPG — so a preview cannot lie about what will print.
CREATE TABLE invoice_settings (
  tenant_id CHAR(26) PRIMARY KEY REFERENCES tenants (id),
  language TEXT NOT NULL DEFAULT 'EN',
  default_template TEXT NOT NULL DEFAULT 'A4',
  show_logo BOOLEAN NOT NULL DEFAULT TRUE,
  show_business_block BOOLEAN NOT NULL DEFAULT TRUE,
  show_customer_block BOOLEAN NOT NULL DEFAULT TRUE,
  show_sku BOOLEAN NOT NULL DEFAULT FALSE,
  show_barcode BOOLEAN NOT NULL DEFAULT FALSE,
  show_discount BOOLEAN NOT NULL DEFAULT TRUE,
  show_payment_breakdown BOOLEAN NOT NULL DEFAULT TRUE,
  show_due BOOLEAN NOT NULL DEFAULT TRUE,
  show_amount_in_words BOOLEAN NOT NULL DEFAULT TRUE,
  footer_text TEXT,
  terms_text TEXT,
  -- Business Pad mode: the shop's own printed pad already carries the header,
  -- so the header block is suppressed and the content starts further down.
  business_pad_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  business_pad_top_mm INTEGER NOT NULL DEFAULT 40,
  page_margin_mm INTEGER NOT NULL DEFAULT 10,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  created_by CHAR(26) NOT NULL, updated_by CHAR(26) NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT invoice_settings_language_check CHECK (language IN ('EN','BN')),
  CONSTRAINT invoice_settings_template_check CHECK (default_template IN ('A4','THERMAL_80')),
  CONSTRAINT invoice_settings_spacing_check
    CHECK (business_pad_top_mm BETWEEN 0 AND 150 AND page_margin_mm BETWEEN 0 AND 50)
);

-- ------------------------------------------------------ product_group_prices
-- Dealer pricing (§5.7): one selling price per active customer group, behind
-- its own setting. The applied price is copied onto the sale line at posting,
-- so changing it later never moves a printed invoice.
CREATE TABLE product_group_prices (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL REFERENCES tenants (id),
  product_id CHAR(26) NOT NULL REFERENCES products (id),
  customer_group_id CHAR(26) NOT NULL REFERENCES customer_groups (id),
  price_minor BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  created_by CHAR(26) NOT NULL, updated_by CHAR(26) NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT product_group_prices_price_not_negative CHECK (price_minor >= 0),
  CONSTRAINT product_group_prices_pair_unique UNIQUE (tenant_id, product_id, customer_group_id)
);

CREATE INDEX product_group_prices_tenant_product_idx
  ON product_group_prices (tenant_id, product_id);

-- --------------------------------------------------- quotations / sales orders
-- §5.7's lean wholesale path, hidden unless the tenant enables it. These
-- reserve no stock and create **no journal entry and no movement** — they are
-- lists of intent that seed the one posting path (A14), never a second one.
CREATE TABLE quotations (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL REFERENCES tenants (id),
  quotation_number TEXT NOT NULL,
  party_id CHAR(26) REFERENCES parties (id),
  customer_name_snapshot TEXT NOT NULL,
  customer_phone_snapshot TEXT,
  valid_until DATE,
  items_total_minor BIGINT NOT NULL,
  discount_minor BIGINT NOT NULL,
  grand_total_minor BIGINT NOT NULL,
  notes TEXT,
  business_date DATE NOT NULL, status TEXT NOT NULL,
  operation_id CHAR(26) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  created_by CHAR(26) NOT NULL, updated_by CHAR(26) NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ, deleted_by CHAR(26),
  CONSTRAINT quotations_status_check CHECK (status IN ('DRAFT','SENT','ACCEPTED','CONVERTED','CANCELLED')),
  CONSTRAINT quotations_operation_unique UNIQUE (tenant_id, operation_id),
  CONSTRAINT quotations_number_unique UNIQUE (tenant_id, quotation_number)
);

CREATE TABLE quotation_lines (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL,
  quotation_id CHAR(26) NOT NULL REFERENCES quotations (id),
  line_no INTEGER NOT NULL,
  product_id CHAR(26) NOT NULL REFERENCES products (id),
  qty BIGINT NOT NULL, unit_price_minor BIGINT NOT NULL,
  line_discount_minor BIGINT NOT NULL, line_total_minor BIGINT NOT NULL,
  -- How much of this line has already been carried into a later document.
  -- Conversion may never exceed the remaining quantity (§5.7).
  qty_converted BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL, created_by CHAR(26) NOT NULL,
  CONSTRAINT quotation_lines_qty_positive CHECK (qty > 0),
  CONSTRAINT quotation_lines_converted_within CHECK (qty_converted BETWEEN 0 AND qty),
  CONSTRAINT quotation_lines_no_unique UNIQUE (quotation_id, line_no)
);

CREATE TABLE sales_orders (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL REFERENCES tenants (id),
  order_number TEXT NOT NULL,
  party_id CHAR(26) REFERENCES parties (id),
  customer_name_snapshot TEXT NOT NULL,
  customer_phone_snapshot TEXT,
  source_quotation_id CHAR(26) REFERENCES quotations (id),
  expected_date DATE,
  items_total_minor BIGINT NOT NULL,
  discount_minor BIGINT NOT NULL,
  grand_total_minor BIGINT NOT NULL,
  notes TEXT,
  business_date DATE NOT NULL, status TEXT NOT NULL,
  operation_id CHAR(26) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  created_by CHAR(26) NOT NULL, updated_by CHAR(26) NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ, deleted_by CHAR(26),
  CONSTRAINT sales_orders_status_check CHECK (status IN ('OPEN','CONVERTED','CANCELLED')),
  CONSTRAINT sales_orders_operation_unique UNIQUE (tenant_id, operation_id),
  CONSTRAINT sales_orders_number_unique UNIQUE (tenant_id, order_number)
);

CREATE TABLE sales_order_lines (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL,
  sales_order_id CHAR(26) NOT NULL REFERENCES sales_orders (id),
  line_no INTEGER NOT NULL,
  product_id CHAR(26) NOT NULL REFERENCES products (id),
  qty BIGINT NOT NULL, unit_price_minor BIGINT NOT NULL,
  line_discount_minor BIGINT NOT NULL, line_total_minor BIGINT NOT NULL,
  qty_converted BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL, created_by CHAR(26) NOT NULL,
  CONSTRAINT sales_order_lines_qty_positive CHECK (qty > 0),
  CONSTRAINT sales_order_lines_converted_within CHECK (qty_converted BETWEEN 0 AND qty),
  CONSTRAINT sales_order_lines_no_unique UNIQUE (sales_order_id, line_no)
);

CREATE INDEX quotations_tenant_date_idx ON quotations (tenant_id, business_date DESC, id DESC);
CREATE INDEX quotation_lines_tenant_quotation_idx ON quotation_lines (tenant_id, quotation_id, line_no);
CREATE INDEX sales_orders_tenant_date_idx ON sales_orders (tenant_id, business_date DESC, id DESC);
CREATE INDEX sales_order_lines_tenant_order_idx ON sales_order_lines (tenant_id, sales_order_id, line_no);

-- ------------------------------------------------------------ product image
-- One optional thumbnail per product (owner decision 2026-08-25), stored with
-- the tenant's own data so a backup carries it and an on-prem install needs no
-- object store. Deliberately not a media library: upload, replace, remove.
-- The bytes are resized and compressed before they arrive here; the CHECK is
-- the backstop that keeps a POS grid page from becoming megabytes.
ALTER TABLE products ADD COLUMN image_mime TEXT;
ALTER TABLE products ADD COLUMN image_bytes BYTEA;
ALTER TABLE products ADD CONSTRAINT products_image_pair
  CHECK ((image_mime IS NULL) = (image_bytes IS NULL));
ALTER TABLE products ADD CONSTRAINT products_image_size
  CHECK (image_bytes IS NULL OR octet_length(image_bytes) <= 262144);
ALTER TABLE products ADD CONSTRAINT products_image_mime_check
  CHECK (image_mime IS NULL OR image_mime IN ('image/webp','image/jpeg','image/png'));

ALTER TABLE sales ENABLE ROW LEVEL SECURITY; ALTER TABLE sales FORCE ROW LEVEL SECURITY;
ALTER TABLE sale_lines ENABLE ROW LEVEL SECURITY; ALTER TABLE sale_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE sale_payments ENABLE ROW LEVEL SECURITY; ALTER TABLE sale_payments FORCE ROW LEVEL SECURITY;
ALTER TABLE customer_receipts ENABLE ROW LEVEL SECURITY; ALTER TABLE customer_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE receipt_allocations ENABLE ROW LEVEL SECURITY; ALTER TABLE receipt_allocations FORCE ROW LEVEL SECURITY;
ALTER TABLE invoice_presentation ENABLE ROW LEVEL SECURITY; ALTER TABLE invoice_presentation FORCE ROW LEVEL SECURITY;
ALTER TABLE invoice_line_presentation ENABLE ROW LEVEL SECURITY; ALTER TABLE invoice_line_presentation FORCE ROW LEVEL SECURITY;
ALTER TABLE invoice_settings ENABLE ROW LEVEL SECURITY; ALTER TABLE invoice_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE product_group_prices ENABLE ROW LEVEL SECURITY; ALTER TABLE product_group_prices FORCE ROW LEVEL SECURITY;
ALTER TABLE quotations ENABLE ROW LEVEL SECURITY; ALTER TABLE quotations FORCE ROW LEVEL SECURITY;
ALTER TABLE quotation_lines ENABLE ROW LEVEL SECURITY; ALTER TABLE quotation_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE sales_orders ENABLE ROW LEVEL SECURITY; ALTER TABLE sales_orders FORCE ROW LEVEL SECURITY;
ALTER TABLE sales_order_lines ENABLE ROW LEVEL SECURITY; ALTER TABLE sales_order_lines FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON sales USING (tenant_id = current_setting('app.tenant_id')::char(26));
CREATE POLICY tenant_isolation ON sale_lines USING (tenant_id = current_setting('app.tenant_id')::char(26));
CREATE POLICY tenant_isolation ON sale_payments USING (tenant_id = current_setting('app.tenant_id')::char(26));
CREATE POLICY tenant_isolation ON customer_receipts USING (tenant_id = current_setting('app.tenant_id')::char(26));
CREATE POLICY tenant_isolation ON receipt_allocations USING (tenant_id = current_setting('app.tenant_id')::char(26));
CREATE POLICY tenant_isolation ON invoice_presentation USING (tenant_id = current_setting('app.tenant_id')::char(26));
CREATE POLICY tenant_isolation ON invoice_line_presentation USING (tenant_id = current_setting('app.tenant_id')::char(26));
CREATE POLICY tenant_isolation ON invoice_settings USING (tenant_id = current_setting('app.tenant_id')::char(26));
CREATE POLICY tenant_isolation ON product_group_prices USING (tenant_id = current_setting('app.tenant_id')::char(26));
CREATE POLICY tenant_isolation ON quotations USING (tenant_id = current_setting('app.tenant_id')::char(26));
CREATE POLICY tenant_isolation ON quotation_lines USING (tenant_id = current_setting('app.tenant_id')::char(26));
CREATE POLICY tenant_isolation ON sales_orders USING (tenant_id = current_setting('app.tenant_id')::char(26));
CREATE POLICY tenant_isolation ON sales_order_lines USING (tenant_id = current_setting('app.tenant_id')::char(26));
