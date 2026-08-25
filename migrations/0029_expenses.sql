-- Phase 7 — what the shop spends (§5.12, §2.4, owner decisions 2026-08-26).
-- Forward-only and additive (SRS 3.10).
--
--   `expense_categories`  the shop's own list: Salary, Rent, Electricity, …
--   `expenses`            one payment out, as a posted document
--
-- **The category is part of the account code, not a column the ledger ignores.**
-- §2.4's list has `EXPENSE:{cat}`, so an expense posts to `EXPENSE:SALARY` and a
-- month's salary bill is a balance on one account rather than a filter over
-- rows. `code` is therefore constrained to what an account segment accepts —
-- letters, digits, underscore, dash — and is fixed once the category has posted
-- anything, because changing it would move history to an account nobody reads.
-- The display `name` stays editable, exactly as a role's does.
--
-- Seeded per tenant by `backfill-seed-roles`, the same script that seeds units
-- and roles: a shopkeeper should never meet an empty dropdown on day one.

-- ------------------------------------------------------- expense_categories
CREATE TABLE expense_categories (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL REFERENCES tenants (id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  -- Shipped with the tenant. A shop may rename or archive one, and cannot
  -- delete it once it holds history — the same rule a system role has.
  is_system BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  created_by CHAR(26) NOT NULL, updated_by CHAR(26) NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ, deleted_by CHAR(26),
  CONSTRAINT expense_categories_status_known CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  -- What `parameterisedAccount('EXPENSE', code)` will accept, checked here too
  -- so a bad row cannot exist even if it arrives another way.
  CONSTRAINT expense_categories_code_shape CHECK (code ~ '^[A-Za-z0-9_-]{1,64}$')
);

CREATE UNIQUE INDEX expense_categories_code_unique
  ON expense_categories (tenant_id, code) WHERE deleted_at IS NULL;
CREATE INDEX expense_categories_listing_idx ON expense_categories (tenant_id, name);

ALTER TABLE expense_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense_categories FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON expense_categories USING (tenant_id = current_setting('app.tenant_id')::char(26));

-- ------------------------------------------------------------------ expenses
-- Class B (§3.4): a posted document — numbered, dated, period-guarded.
CREATE TABLE expenses (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL REFERENCES tenants (id),
  expense_number TEXT NOT NULL,
  category_id CHAR(26) NOT NULL REFERENCES expense_categories (id),
  -- Snapshotted: renaming Electricity later must not rewrite what last March
  -- said it spent money on.
  category_code_snapshot TEXT NOT NULL,
  category_name_snapshot TEXT NOT NULL,
  -- Who was paid, when the shop knows: Belal for salary, a landlord for rent.
  -- Optional, because a bus fare has no party (§5.12).
  payee_party_id CHAR(26) REFERENCES parties (id),
  payee_name_snapshot TEXT,
  amount_minor BIGINT NOT NULL,
  account_code TEXT NOT NULL,
  -- The open day the cash left, when it was cash (§5.16.1).
  session_id CHAR(26),
  note TEXT,
  business_date DATE NOT NULL, entry_mode TEXT NOT NULL,
  backdate_reason TEXT,
  status TEXT NOT NULL,
  operation_id CHAR(26) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  created_by CHAR(26) NOT NULL, updated_by CHAR(26) NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ, deleted_by CHAR(26),
  CONSTRAINT expenses_status_known CHECK (status IN ('POSTED', 'VOIDED')),
  CONSTRAINT expenses_amount_positive CHECK (amount_minor > 0),
  CONSTRAINT expenses_backdate_has_reason
    CHECK (entry_mode <> 'BACKDATED' OR backdate_reason IS NOT NULL)
);

CREATE UNIQUE INDEX expenses_number_unique ON expenses (tenant_id, expense_number);
CREATE UNIQUE INDEX expenses_operation_unique ON expenses (tenant_id, operation_id);
CREATE INDEX expenses_listing_idx ON expenses (tenant_id, business_date DESC, id DESC);
CREATE INDEX expenses_category_idx ON expenses (tenant_id, category_id, business_date DESC);
CREATE INDEX expenses_payee_idx
  ON expenses (tenant_id, payee_party_id, business_date DESC) WHERE payee_party_id IS NOT NULL;

ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON expenses USING (tenant_id = current_setting('app.tenant_id')::char(26));
