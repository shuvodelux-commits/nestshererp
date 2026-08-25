-- Phase 6 — a parked cart (§5.7, owner decision 2026-08-26). Forward-only and
-- additive (SRS 3.10).
--
-- A counter is interrupted: the customer goes back for one more item, or asks
-- the shopkeeper to hold the bill while they fetch money. Today the only way
-- out of a half-built cart is to post it or lose it. A draft is neither — it is
-- **not a document**: no number, no journal entry, no stock movement, no
-- period guard, and it can be deleted outright, which is exactly what
-- distinguishes it from the posted sale it may become.
--
-- The cart is stored as JSONB rather than as draft_lines. It is one shopkeeper's
-- unfinished screen, read back whole into the same screen, and nothing will ever
-- query inside it — a table of lines would buy referential integrity over rows
-- that are deliberately allowed to name a product whose price has since changed.
CREATE TABLE sale_drafts (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL REFERENCES tenants (id),
  -- What the shopkeeper will recognise it by: the customer, or what they typed.
  label TEXT NOT NULL,
  -- Shown in the list without opening it.
  customer_name TEXT,
  item_count INTEGER NOT NULL,
  grand_total_minor BIGINT NOT NULL,
  -- The cart exactly as the counter had it: lines, discount, payments, customer.
  cart JSONB NOT NULL,
  business_date DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  created_by CHAR(26) NOT NULL, updated_by CHAR(26) NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT sale_drafts_counts_not_negative
    CHECK (item_count >= 0 AND grand_total_minor >= 0),
  CONSTRAINT sale_drafts_cart_is_object CHECK (jsonb_typeof(cart) = 'object')
);

CREATE INDEX sale_drafts_tenant_idx ON sale_drafts (tenant_id, created_at DESC, id DESC);

ALTER TABLE sale_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_drafts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sale_drafts USING (tenant_id = current_setting('app.tenant_id')::char(26));
