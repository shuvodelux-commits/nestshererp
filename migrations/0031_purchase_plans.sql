-- Phase 8 — the Purchase Planner and the paper that goes to the supplier
-- (§5.9, owner decisions 2026-08-26). Forward-only and additive (SRS 3.10).
--
--   `purchase_plans`               one buying plan: what to order, and why
--   `purchase_plan_lines`          one product on it
--   `supplier_purchase_orders`     the numbered copy actually sent to a supplier
--   `supplier_purchase_order_lines`  exactly what that copy said
--
-- **A plan posts nothing.** No lot, no movement, no payable, no journal entry —
-- §5.9 is explicit, and that is why there is no `operation_id` on any table
-- here: there is no financial write to make idempotent. Stock and the supplier
-- ledger happen when the plan is converted and `CreatePurchaseService` runs,
-- which is the same use case a typed-from-scratch bill uses (A14).
--
-- **Fulfilment is derived, never counted into a column.** `purchase_lines`
-- gains `plan_line_id`, so how much of a plan line has really been bought is a
-- SUM over posted purchase lines. A cached counter would have to be unwound
-- when a bill is voided or corrected; a SUM is simply right afterwards.
--
-- **Status is derived too.** Only `closed_at` is stored. A plan reads CLOSED
-- when it was closed by hand, COMPLETED when every line has been bought, and
-- OPEN otherwise — three states that cannot disagree with the purchases they
-- describe.

-- ------------------------------------------------------------ purchase_plans
CREATE TABLE purchase_plans (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL REFERENCES tenants (id),
  plan_number TEXT NOT NULL,
  title TEXT,
  -- The two numbers the suggestion was computed from, kept so a plan can still
  -- be read months later when the shop's settings have moved on.
  look_back_days INTEGER NOT NULL,
  cover_days INTEGER NOT NULL,
  -- Null is "no budget". Zero would mean a budget of nothing, which is a
  -- different and legitimate thing to say.
  budget_minor BIGINT,
  business_date DATE NOT NULL,
  closed_at TIMESTAMPTZ, closed_by CHAR(26),
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  created_by CHAR(26) NOT NULL, updated_by CHAR(26) NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ, deleted_by CHAR(26),
  CONSTRAINT purchase_plans_days_positive CHECK (look_back_days > 0 AND cover_days > 0),
  CONSTRAINT purchase_plans_budget_not_negative CHECK (budget_minor IS NULL OR budget_minor >= 0),
  CONSTRAINT purchase_plans_closed_together
    CHECK ((closed_at IS NULL AND closed_by IS NULL) OR (closed_at IS NOT NULL AND closed_by IS NOT NULL))
);

CREATE UNIQUE INDEX purchase_plans_number_unique ON purchase_plans (tenant_id, plan_number);
CREATE INDEX purchase_plans_listing_idx ON purchase_plans (tenant_id, business_date DESC, id DESC);
CREATE INDEX purchase_plans_open_idx ON purchase_plans (tenant_id, id) WHERE closed_at IS NULL AND deleted_at IS NULL;

ALTER TABLE purchase_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_plans FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON purchase_plans USING (tenant_id = current_setting('app.tenant_id')::char(26));

-- ------------------------------------------------------- purchase_plan_lines
-- `suggested_qty` is what the planner worked out; `planned_qty` is what the
-- shopkeeper decided. Both are kept: the gap between them is the only record
-- that a suggestion was overridden, and it is the first thing to look at when
-- a plan turns out to have been wrong.
CREATE TABLE purchase_plan_lines (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL REFERENCES tenants (id),
  plan_id CHAR(26) NOT NULL REFERENCES purchase_plans (id),
  line_no INTEGER NOT NULL,
  product_id CHAR(26) NOT NULL REFERENCES products (id),
  -- Null when the product has no usual supplier and has never been bought:
  -- the line is real and still needs ordering, it just has nobody to send to
  -- yet. The planner shows these in their own group.
  supplier_party_id CHAR(26) REFERENCES parties (id),
  suggested_qty BIGINT NOT NULL,
  planned_qty BIGINT NOT NULL,
  priority TEXT NOT NULL,
  -- What the shop knew when it planned: cover, cost and price as they stood.
  -- Snapshots, not live reads — a plan is a decision made on a day.
  stock_qty BIGINT NOT NULL,
  daily_sales_qty BIGINT NOT NULL,
  cover_days INTEGER,
  unit_cost_minor BIGINT NOT NULL,
  selling_price_minor BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  created_by CHAR(26) NOT NULL, updated_by CHAR(26) NOT NULL,
  CONSTRAINT purchase_plan_lines_qty_not_negative
    CHECK (suggested_qty >= 0 AND planned_qty >= 0),
  CONSTRAINT purchase_plan_lines_priority_known
    CHECK (priority IN ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW'))
);

CREATE UNIQUE INDEX purchase_plan_lines_product_unique ON purchase_plan_lines (tenant_id, plan_id, product_id);
CREATE INDEX purchase_plan_lines_plan_idx ON purchase_plan_lines (tenant_id, plan_id, line_no);
CREATE INDEX purchase_plan_lines_product_idx ON purchase_plan_lines (tenant_id, product_id, id);
CREATE INDEX purchase_plan_lines_supplier_idx ON purchase_plan_lines (tenant_id, plan_id, supplier_party_id);

ALTER TABLE purchase_plan_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_plan_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON purchase_plan_lines USING (tenant_id = current_setting('app.tenant_id')::char(26));

-- -------------------------------------------------- supplier_purchase_orders
-- The paper the supplier is holding. It is stored rather than regenerated so
-- that editing the plan afterwards can never change what was already sent —
-- a reprint months later has to produce the same sheet, or a disagreement
-- about "this is what you ordered" has nothing to settle it.
CREATE TABLE supplier_purchase_orders (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL REFERENCES tenants (id),
  plan_id CHAR(26) NOT NULL REFERENCES purchase_plans (id),
  supplier_party_id CHAR(26) NOT NULL REFERENCES parties (id),
  order_number TEXT NOT NULL,
  business_date DATE NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  created_by CHAR(26) NOT NULL, updated_by CHAR(26) NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ, deleted_by CHAR(26)
);

CREATE UNIQUE INDEX supplier_purchase_orders_number_unique ON supplier_purchase_orders (tenant_id, order_number);
CREATE INDEX supplier_purchase_orders_plan_idx ON supplier_purchase_orders (tenant_id, plan_id, id);
CREATE INDEX supplier_purchase_orders_supplier_idx ON supplier_purchase_orders (tenant_id, supplier_party_id, business_date DESC, id DESC);

ALTER TABLE supplier_purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_purchase_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON supplier_purchase_orders USING (tenant_id = current_setting('app.tenant_id')::char(26));

-- --------------------------------------------- supplier_purchase_order_lines
-- `product_name` is a snapshot for the same reason the order itself is: the
-- supplier's copy says what it said on the day, even if the product is renamed
-- afterwards. Cost, selling price, stock and profit are deliberately absent —
-- the owner's rule is that the supplier copy never carries them, and a column
-- that does not exist cannot leak into a print template by accident.
CREATE TABLE supplier_purchase_order_lines (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL REFERENCES tenants (id),
  order_id CHAR(26) NOT NULL REFERENCES supplier_purchase_orders (id),
  line_no INTEGER NOT NULL,
  product_id CHAR(26) NOT NULL REFERENCES products (id),
  product_name TEXT NOT NULL,
  unit_name TEXT NOT NULL,
  qty BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL, created_by CHAR(26) NOT NULL,
  CONSTRAINT supplier_purchase_order_lines_qty_positive CHECK (qty > 0)
);

CREATE INDEX supplier_purchase_order_lines_order_idx ON supplier_purchase_order_lines (tenant_id, order_id, line_no);

ALTER TABLE supplier_purchase_order_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_purchase_order_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON supplier_purchase_order_lines USING (tenant_id = current_setting('app.tenant_id')::char(26));

-- ------------------------------------------------- the link back to purchases
-- What a plan line actually got. Nullable because most purchase lines are
-- typed from scratch and belong to no plan at all.
ALTER TABLE purchase_lines ADD COLUMN plan_line_id CHAR(26) REFERENCES purchase_plan_lines (id);
CREATE INDEX purchase_lines_plan_line_idx ON purchase_lines (tenant_id, plan_line_id) WHERE plan_line_id IS NOT NULL;

-- ----------------------------------------------------------- product columns
-- The supplier the planner should assume, and the smallest quantity that
-- supplier will sell. Both optional: blank `usual_supplier_id` falls back to
-- the most-used recent supplier from purchase history, and a blank
-- `min_order_qty` applies no minimum at all.
ALTER TABLE products ADD COLUMN usual_supplier_id CHAR(26) REFERENCES parties (id);
ALTER TABLE products ADD COLUMN min_order_qty BIGINT;
ALTER TABLE products ADD CONSTRAINT products_min_order_qty_positive
  CHECK (min_order_qty IS NULL OR min_order_qty > 0);
CREATE INDEX products_usual_supplier_idx ON products (tenant_id, usual_supplier_id) WHERE usual_supplier_id IS NOT NULL;
