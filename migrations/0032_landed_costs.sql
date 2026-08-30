-- Phase 8 — what the goods really cost by the time they reached the shelf
-- (§5.12 M14, owner decisions 2026-08-26). Forward-only and additive.
--
--   `purchase_landed_costs`  one named extra cost on a bill, and how it spread
--
-- **This replaces nothing.** A bill's single `extra_cost_minor` box stays
-- exactly where it is and keeps working; every existing purchase is still
-- valued the way it was posted. What is new is that the box becomes a list of
-- named lines, each with its own spreading method, and that a line may arrive
-- days after the bill.
--
-- **Two methods, one rule.** BY_VALUE weights each purchase line by what it
-- came to; BY_QTY weights it by how much of it arrived. Both hand the weights
-- to §3.3's largest-remainder allocation, which is the only sharing-out rule in
-- this codebase — a van fare that lost a poisha to rounding would put
-- `INVENTORY` out of step with the lots, and INV-05 exists to catch that.
--
-- **A cost that arrives late is split before it is spread.** Goods already sold
-- cannot have their lots raised — the lot is gone — so that share is posted to
-- `COGS` instead, on the day the cost is recorded rather than the day of the
-- bill. Backdating it into the original purchase would mean rewriting a period
-- that may be closed, which §5.19's period guard exists to prevent. The shop's
-- total profit is unchanged either way; only which month carries it moves.
-- `inventory_share_minor` and `cogs_share_minor` record how that split fell.

CREATE TABLE purchase_landed_costs (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL REFERENCES tenants (id),
  purchase_id CHAR(26) NOT NULL REFERENCES purchases (id),
  line_no INTEGER NOT NULL,
  -- The six seeded categories, closed. §5.12 allows tenants to add their own;
  -- `OTHER` covers that until a shop asks for it, and a closed list is what
  -- lets a landed-cost report group by category at all.
  category TEXT NOT NULL,
  method TEXT NOT NULL,
  amount_minor BIGINT NOT NULL,
  -- How this line landed. On a cost entered with the bill the whole amount is
  -- inventory, because nothing has been sold yet.
  inventory_share_minor BIGINT NOT NULL,
  cogs_share_minor BIGINT NOT NULL,
  -- Null for a cost that was part of the bill's own entry. Set for one added
  -- afterwards, which posts an entry of its own.
  journal_entry_id CHAR(26) REFERENCES journal_entries (id),
  -- The day this cost was recorded, which is the bill's own date for a cost
  -- entered with it and today's date for one added later.
  business_date DATE NOT NULL,
  operation_id CHAR(26),
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  created_by CHAR(26) NOT NULL, updated_by CHAR(26) NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT purchase_landed_costs_amount_positive CHECK (amount_minor > 0),
  CONSTRAINT purchase_landed_costs_shares_not_negative
    CHECK (inventory_share_minor >= 0 AND cogs_share_minor >= 0),
  CONSTRAINT purchase_landed_costs_shares_sum
    CHECK (inventory_share_minor + cogs_share_minor = amount_minor),
  CONSTRAINT purchase_landed_costs_category_known
    CHECK (category IN ('TRANSPORT', 'LABOUR', 'LOADING', 'DELIVERY', 'CUSTOMS', 'OTHER')),
  CONSTRAINT purchase_landed_costs_method_known
    CHECK (method IN ('BY_VALUE', 'BY_QTY')),
  -- A cost added later posts money and so must be replay-safe; one entered with
  -- the bill is already covered by the bill's own operation id.
  CONSTRAINT purchase_landed_costs_late_is_idempotent
    CHECK ((journal_entry_id IS NULL AND operation_id IS NULL)
        OR (journal_entry_id IS NOT NULL AND operation_id IS NOT NULL))
);

CREATE INDEX purchase_landed_costs_purchase_idx ON purchase_landed_costs (tenant_id, purchase_id, line_no);
CREATE UNIQUE INDEX purchase_landed_costs_operation_unique
  ON purchase_landed_costs (tenant_id, operation_id) WHERE operation_id IS NOT NULL;

ALTER TABLE purchase_landed_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_landed_costs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON purchase_landed_costs USING (tenant_id = current_setting('app.tenant_id')::char(26));
