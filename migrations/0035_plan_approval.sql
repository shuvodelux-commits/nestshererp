-- Phase 8 rework — the planner's real working flow (owner decision 2026-08-26,
-- after driving the first cut). Forward-only and additive.
--
--   plan:  DRAFT → APPROVED → (its supplier orders) → purchase
--                → REJECTED
--
-- **Approving is what produces the supplier orders**, not a separate "send"
-- click: the owner's point was that a plan is either agreed or it is not, and
-- the paper for each supplier falls out of agreeing. Nothing is transmitted
-- anywhere — an order is printed, saved as PDF or shared as an image, which is
-- why there is no sent-at column and no delivery state to track.
--
-- **A supplier order is Open until a purchase is made from it**, and then it
-- names that purchase. Both directions are stored because both questions get
-- asked: "what did we order and has it come" from the order, and "what was this
-- bill against" from the purchase.

ALTER TABLE purchase_plans ADD COLUMN status TEXT NOT NULL DEFAULT 'DRAFT';
ALTER TABLE purchase_plans ADD COLUMN notes TEXT;
ALTER TABLE purchase_plans ADD COLUMN decided_at TIMESTAMPTZ;
ALTER TABLE purchase_plans ADD COLUMN decided_by CHAR(26);
ALTER TABLE purchase_plans ADD CONSTRAINT purchase_plans_status_known
  CHECK (status IN ('DRAFT', 'APPROVED', 'REJECTED'));
-- A decision is a person and a moment, or neither.
ALTER TABLE purchase_plans ADD CONSTRAINT purchase_plans_decided_together
  CHECK ((decided_at IS NULL AND decided_by IS NULL) OR (decided_at IS NOT NULL AND decided_by IS NOT NULL));
CREATE INDEX purchase_plans_status_idx ON purchase_plans (tenant_id, status, business_date DESC);

ALTER TABLE supplier_purchase_orders ADD COLUMN status TEXT NOT NULL DEFAULT 'OPEN';
ALTER TABLE supplier_purchase_orders ADD COLUMN purchase_id CHAR(26) REFERENCES purchases (id);
ALTER TABLE supplier_purchase_orders ADD CONSTRAINT supplier_purchase_orders_status_known
  CHECK (status IN ('OPEN', 'CONVERTED', 'CANCELLED'));
-- Converted means there is a bill; open means there is not.
ALTER TABLE supplier_purchase_orders ADD CONSTRAINT supplier_purchase_orders_converted_has_purchase
  CHECK (status <> 'CONVERTED' OR purchase_id IS NOT NULL);
CREATE INDEX supplier_purchase_orders_status_idx ON supplier_purchase_orders (tenant_id, status, business_date DESC);

-- The other direction: which order this bill was raised against.
ALTER TABLE purchases ADD COLUMN supplier_order_id CHAR(26) REFERENCES supplier_purchase_orders (id);
CREATE INDEX purchases_supplier_order_idx ON purchases (tenant_id, supplier_order_id) WHERE supplier_order_id IS NOT NULL;
