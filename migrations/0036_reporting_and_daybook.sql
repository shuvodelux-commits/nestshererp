-- Phase 9 — reporting, dashboard and Daybook (§5.20, §5.27, owner decisions
-- 2026-08-30). Forward-only and additive (SRS 3.10).
--
--   `profit_targets`        one typed target per month, per shop
--   `daybook_review_marks`  that a day was checked against the notebook
--   `daybook_prints`        that a day was printed, and with what totals
--
-- **Three tables, and not one of them holds a business figure.** Every number
-- on every report and in the daybook is read from `journal_entries`,
-- `journal_lines` and `stock_movements` (INV-10) — a reporting table holding a
-- total would be a second version of the truth, and the first thing to
-- disagree with the ledger. What is stored here is what the *shopkeeper*
-- decided or did: a target they typed, a day they ticked, a paper they
-- printed.

-- ------------------------------------------------------------ profit_targets
-- O-10, closed by owner decision: one target per month for the whole shop,
-- typed by the owner — not derived from history, not per category, not per
-- product. `basis` says whether the number is profit or sales, because a shop
-- that thinks in turnover and one that thinks in earnings both exist and the
-- projection beside it means something different in each.
--
-- The projection itself is never stored. It is an estimate recomputed from the
-- current daily rate whenever the screen is opened, and a stored estimate is
-- indistinguishable from a posted figure the moment somebody reads the table.
CREATE TABLE profit_targets (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL REFERENCES tenants (id),
  month CHAR(7) NOT NULL,
  basis TEXT NOT NULL,
  amount_minor BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  created_by CHAR(26) NOT NULL, updated_by CHAR(26) NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT profit_targets_basis_known CHECK (basis IN ('PROFIT', 'SALES')),
  CONSTRAINT profit_targets_amount_not_negative CHECK (amount_minor >= 0),
  CONSTRAINT profit_targets_month_shape CHECK (month ~ '^[0-9]{4}-[0-9]{2}$')
);

CREATE UNIQUE INDEX profit_targets_month_unique ON profit_targets (tenant_id, month);

ALTER TABLE profit_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE profit_targets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON profit_targets USING (tenant_id = current_setting('app.tenant_id')::char(26));

-- ------------------------------------------------------ daybook_review_marks
-- "I have checked this day against my notebook", with who and when, and a note
-- for whatever looked odd (owner decision 2026-08-30). One mark per day: a day
-- checked twice is still a day checked, and the later look replaces the
-- earlier one rather than queueing behind it.
--
-- Marking a day changes no figure anywhere. It is a statement about the
-- reviewer, not about the ledger.
CREATE TABLE daybook_review_marks (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL REFERENCES tenants (id),
  business_date DATE NOT NULL,
  reviewed_at TIMESTAMPTZ NOT NULL,
  reviewed_by CHAR(26) NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  created_by CHAR(26) NOT NULL, updated_by CHAR(26) NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX daybook_review_marks_day_unique ON daybook_review_marks (tenant_id, business_date);

ALTER TABLE daybook_review_marks ENABLE ROW LEVEL SECURITY;
ALTER TABLE daybook_review_marks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON daybook_review_marks USING (tenant_id = current_setting('app.tenant_id')::char(26));

-- ------------------------------------------------------------ daybook_prints
-- §5.27's own table, so a reprint can be proved identical to — or explicitly
-- different from — the physical copy somebody is holding. Without it, two
-- printed copies of the same day can differ with nothing to show which came
-- first, and a day-end report that cannot be trusted is not worth printing.
--
-- The totals are **stored as printed**, not recomputed on read: that is the
-- whole point. `totals_json` carries the section figures the layout showed;
-- the four columns beside it are the ones a person compares at a glance.
--
-- `print_serial` is the number on the paper, counted per tenant, so "print 3
-- of the 14th" identifies one sheet.
CREATE TABLE daybook_prints (
  id CHAR(26) PRIMARY KEY, tenant_id CHAR(26) NOT NULL REFERENCES tenants (id),
  from_date DATE NOT NULL,
  to_date DATE NOT NULL,
  format TEXT NOT NULL,
  print_serial INTEGER NOT NULL,
  printed_at TIMESTAMPTZ NOT NULL,
  printed_by CHAR(26) NOT NULL,
  opening_cash_minor BIGINT NOT NULL,
  closing_cash_minor BIGINT NOT NULL,
  transaction_count INTEGER NOT NULL,
  totals_json JSONB NOT NULL,
  -- Set on a reprint, pointing at the print being copied. The copy is stamped
  -- REPRINT and keeps its own serial, so the two are never confused.
  reprint_of_id CHAR(26) REFERENCES daybook_prints (id),
  CONSTRAINT daybook_prints_format_known CHECK (format IN ('A4', 'THERMAL_80')),
  CONSTRAINT daybook_prints_range_ordered CHECK (to_date >= from_date),
  CONSTRAINT daybook_prints_count_not_negative CHECK (transaction_count >= 0)
);

CREATE UNIQUE INDEX daybook_prints_serial_unique ON daybook_prints (tenant_id, print_serial);
CREATE INDEX daybook_prints_range_idx ON daybook_prints (tenant_id, from_date DESC, printed_at DESC);

ALTER TABLE daybook_prints ENABLE ROW LEVEL SECURITY;
ALTER TABLE daybook_prints FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON daybook_prints USING (tenant_id = current_setting('app.tenant_id')::char(26));
