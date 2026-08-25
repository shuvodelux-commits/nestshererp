-- Phase 7 — goods coming back over the counter (§5.11, §2.5, owner decisions
-- 2026-08-26). Forward-only and additive (SRS 3.10).
--
-- Two tables and two columns:
--
--   `sales_returns`       one return, as a posted document against one invoice
--   `sales_return_lines`  what came back, one row per invoice line it came from
--   `roles.cash_refund_*` how much cash a role may hand back before a PIN
--
-- **A return is always against its invoice.** `sale_id` is NOT NULL and there
-- is no free-standing return: what may come back is what that invoice sold,
-- minus what has already come back, and the quantity cap is therefore a query
-- over these rows rather than a column anyone has to keep up to date. The same
-- argument as `0017` and `0015` — a stored "already returned" figure is a
-- second answer to a question the lines already answer.
--
-- **The value is what the customer paid, not what the product is worth today.**
-- `value_minor` on a line is that invoice line's net amount in proportion to
-- the quantity returning, and `cost_minor` is the cost that actually left,
-- read from the lots the sale consumed. Re-costing a return at today's average
-- would leave COGS and INVENTORY holding a difference nobody created (INV-05).

-- ------------------------------------------------------------ sales_returns
-- Class B (§3.4): a posted document — numbered, dated, period-guarded, and
-- reversible. It is never edited in place.
CREATE TABLE sales_returns (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL REFERENCES tenants (id),
  return_number TEXT NOT NULL,
  sale_id CHAR(26) NOT NULL REFERENCES sales (id),
  party_id CHAR(26) NOT NULL REFERENCES parties (id),
  customer_name_snapshot TEXT NOT NULL,
  location_id CHAR(26) NOT NULL REFERENCES inventory_locations (id),
  reason TEXT NOT NULL,
  note TEXT,
  return_value_minor BIGINT NOT NULL,
  refund_minor BIGINT NOT NULL,
  credit_minor BIGINT NOT NULL,
  -- How much of the credit cleared *this* invoice, as opposed to sitting as an
  -- advance for next time. The invoice's due reads it, the same way it reads
  -- receipt allocations: what a customer still owes on a bill they partly sent
  -- back is the bill minus what was paid, allocated, and credited against it.
  settled_minor BIGINT NOT NULL,
  cogs_minor BIGINT NOT NULL,
  -- Null when nothing was handed back: the whole value stayed on the account.
  refund_account_code TEXT,
  -- Who approved a refund over the taker's role limit. Null when none was
  -- needed — which is the ordinary case, and is not the same as nobody caring.
  approved_by CHAR(26) REFERENCES users (id),
  -- §5.19: the business date may be earlier than the entry date, and when it
  -- is, the reason is not optional.
  business_date DATE NOT NULL, entry_mode TEXT NOT NULL,
  backdate_reason TEXT,
  status TEXT NOT NULL,
  operation_id CHAR(26) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  created_by CHAR(26) NOT NULL, updated_by CHAR(26) NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ, deleted_by CHAR(26),
  CONSTRAINT sales_returns_status_known CHECK (status IN ('POSTED', 'VOIDED')),
  CONSTRAINT sales_returns_reason_known
    CHECK (reason IN ('DAMAGED', 'WRONG_ITEM', 'CHANGED_MIND', 'EXTRA_QUANTITY', 'OTHER')),
  CONSTRAINT sales_returns_amounts_not_negative
    CHECK (return_value_minor >= 0 AND refund_minor >= 0 AND credit_minor >= 0 AND cogs_minor >= 0),
  -- The two halves of what came back must add up to it. A return whose refund
  -- and credit did not reconcile to its value would put the difference nowhere.
  CONSTRAINT sales_returns_settled_within_credit
    CHECK (settled_minor >= 0 AND settled_minor <= credit_minor),
  CONSTRAINT sales_returns_value_is_split
    CHECK (refund_minor + credit_minor = return_value_minor),
  -- Money out needs somewhere to have come from.
  CONSTRAINT sales_returns_refund_has_account
    CHECK (refund_minor = 0 OR refund_account_code IS NOT NULL),
  CONSTRAINT sales_returns_backdate_has_reason
    CHECK (entry_mode <> 'BACKDATED' OR backdate_reason IS NOT NULL)
);

CREATE UNIQUE INDEX sales_returns_number_unique ON sales_returns (tenant_id, return_number);
CREATE INDEX sales_returns_sale_idx ON sales_returns (tenant_id, sale_id);
CREATE INDEX sales_returns_party_idx ON sales_returns (tenant_id, party_id, business_date DESC);
CREATE INDEX sales_returns_listing_idx ON sales_returns (tenant_id, business_date DESC, id DESC);
-- What one person has already refunded today, for the per-day cap. Partial,
-- because a return that refunded nothing does not count against a cash limit.
CREATE INDEX sales_returns_refunds_today_idx
  ON sales_returns (tenant_id, created_by, business_date)
  WHERE refund_minor > 0 AND status = 'POSTED';

ALTER TABLE sales_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_returns FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sales_returns USING (tenant_id = current_setting('app.tenant_id')::char(26));

-- ------------------------------------------------------- sales_return_lines
-- One row per invoice line something came back from. `sale_line_id` is what
-- makes the cap computable and what ties the returned goods to the cost that
-- left; `movement_id` is the stock movement that put them back.
CREATE TABLE sales_return_lines (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL REFERENCES tenants (id),
  return_id CHAR(26) NOT NULL REFERENCES sales_returns (id),
  line_no INTEGER NOT NULL,
  sale_line_id CHAR(26) NOT NULL REFERENCES sale_lines (id),
  product_id CHAR(26) NOT NULL REFERENCES products (id),
  qty BIGINT NOT NULL,
  value_minor BIGINT NOT NULL,
  cost_minor BIGINT NOT NULL,
  movement_id CHAR(26) NOT NULL REFERENCES stock_movements (id),
  created_at TIMESTAMPTZ NOT NULL, created_by CHAR(26) NOT NULL,
  CONSTRAINT sales_return_lines_qty_positive CHECK (qty > 0),
  CONSTRAINT sales_return_lines_amounts_not_negative
    CHECK (value_minor >= 0 AND cost_minor >= 0)
);

CREATE INDEX sales_return_lines_return_idx ON sales_return_lines (tenant_id, return_id, line_no);
-- The quantity cap reads this: Σ qty per sale line, over posted returns.
CREATE INDEX sales_return_lines_sale_line_idx ON sales_return_lines (tenant_id, sale_line_id);

ALTER TABLE sales_return_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_return_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sales_return_lines USING (tenant_id = current_setting('app.tenant_id')::char(26));

-- ------------------------------------------------------- refund caps on roles
-- How much cash a role may hand back on a return, per return and per business
-- day (owner decision 2026-08-26). NULL is unlimited — Owner and Manager — and
-- 0 is a role that may take returns but never open the drawer for one.
--
-- On the role rather than the user, because the shop's question is "how much
-- can whoever is at the counter give back", and per-person amounts would be a
-- number to maintain every time somebody is hired.
ALTER TABLE roles ADD COLUMN cash_refund_per_return_minor BIGINT;
ALTER TABLE roles ADD COLUMN cash_refund_per_day_minor BIGINT;

ALTER TABLE roles ADD CONSTRAINT roles_refund_caps_not_negative
  CHECK (
    (cash_refund_per_return_minor IS NULL OR cash_refund_per_return_minor >= 0)
    AND (cash_refund_per_day_minor IS NULL OR cash_refund_per_day_minor >= 0)
  );
